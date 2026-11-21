package expo.modules.lingdevicetransport;

import com.jcraft.jsch.ChannelExec;
import com.jcraft.jsch.HostKey;
import com.jcraft.jsch.HostKeyRepository;
import com.jcraft.jsch.JSch;
import com.jcraft.jsch.JSchException;
import com.jcraft.jsch.Session;
import com.jcraft.jsch.SocketFactory;
import com.jcraft.jsch.UserInfo;
import java.io.ByteArrayOutputStream;
import java.io.IOException;
import java.io.InputStream;
import java.io.OutputStream;
import java.net.InetSocketAddress;
import java.net.Socket;
import java.net.SocketTimeoutException;
import java.nio.charset.StandardCharsets;
import java.security.MessageDigest;
import java.security.NoSuchAlgorithmException;
import java.util.Arrays;
import java.util.HashMap;
import java.util.Map;
import java.util.concurrent.TimeUnit;
import java.util.concurrent.atomic.AtomicBoolean;

final class PinnedSshSession implements AutoCloseable {
  private static final int CONNECT_TIMEOUT_MS = 6_000;
  private static final int MAX_OUTPUT_BYTES = 128 * 1024;
  private final AtomicBoolean closed = new AtomicBoolean();
  private final AtomicBoolean started = new AtomicBoolean();
  private volatile Socket socket;
  private volatile Session session;

  void connect(String host, int port, String user, String fingerprint, String password) throws IOException {
    if (!host.matches("[a-zA-Z0-9][a-zA-Z0-9._-]{0,252}") || port < 1 || port > 65_535
        || !user.matches("[a-zA-Z0-9_][a-zA-Z0-9_.@-]{0,63}") || !fingerprint.matches("[0-9a-f]{64}")
        || password.isEmpty() || password.length() > 1024 || password.indexOf('\0') >= 0) {
      throw new IOException("ssh_invalid_target");
    }
    assertOpen();
    if (!started.compareAndSet(false, true)) throw new IOException("ssh_target_busy");
    FingerprintPin pin = new FingerprintPin(fingerprint);
    JSch client = new JSch();
    client.setHostKeyRepository(pin);
    try {
      Session connection = client.getSession(user, host, port);
      session = connection;
      connection.setSocketFactory(new SocketFactory() {
        @Override
        public Socket createSocket(String hostname, int connectionPort) throws IOException {
          Socket next = new Socket();
          socket = next;
          assertOpen();
          next.connect(new InetSocketAddress(hostname, connectionPort), CONNECT_TIMEOUT_MS);
          return next;
        }

        @Override
        public InputStream getInputStream(Socket connection) throws IOException {
          return connection.getInputStream();
        }

        @Override
        public OutputStream getOutputStream(Socket connection) throws IOException {
          return connection.getOutputStream();
        }
      });
      connection.setConfig("StrictHostKeyChecking", "yes");
      connection.setConfig("PreferredAuthentications", "password");
      connection.setConfig("MaxAuthTries", "1");
      connection.setConfig("ssh-ed25519", "com.jcraft.jsch.bc.SignatureEd25519");
      connection.setConfig("xdh", "com.jcraft.jsch.bc.XDH");
      connection.setTimeout(CONNECT_TIMEOUT_MS);
      byte[] secret = password.getBytes(StandardCharsets.UTF_8);
      try {
        connection.setPassword(secret);
      } finally {
        Arrays.fill(secret, (byte) 0);
      }
      connection.connect(CONNECT_TIMEOUT_MS);
      assertOpen();
      if (!pin.verified) throw new IOException("ssh_host_key_mismatch");
    } catch (JSchException | IOException error) {
      boolean cancelled = closed.get();
      close();
      if (cancelled) throw new IOException("ssh_session_closed");
      if (pin.rejected) throw new IOException("ssh_host_key_mismatch");
      if (error.getMessage() != null && error.getMessage().startsWith("Auth fail")) {
        throw new IOException("ssh_authentication_failed");
      }
      if (error instanceof SocketTimeoutException || error.getCause() instanceof SocketTimeoutException) {
        throw new IOException("ssh_timeout");
      }
      throw new IOException("ssh_connection_failed");
    }
  }

  synchronized Map<String, Object> read(String operation, String argument) throws IOException {
    assertOpen();
    Session connection = session;
    if (connection == null || !connection.isConnected()) throw new IOException("ssh_connection_failed");
    String command = readCommand(operation, argument);
    int timeoutMs = operation.equals("dns") ? 3_000 : 5_000;
    long deadline = System.nanoTime() + TimeUnit.MILLISECONDS.toNanos(timeoutMs);
    ChannelExec channel = null;
    try {
      channel = (ChannelExec) connection.openChannel("exec");
      channel.setCommand(command);
      channel.setInputStream(null);
      BoundedOutput stdout = new BoundedOutput();
      BoundedOutput stderr = new BoundedOutput();
      channel.setOutputStream(stdout);
      channel.setErrStream(stderr);
      channel.connect(timeoutMs);
      while (!channel.isClosed() && !stdout.overflow && !stderr.overflow) {
        assertOpen();
        if (System.nanoTime() >= deadline) throw new IOException("ssh_timeout");
        Thread.sleep(20);
      }
      assertOpen();
      if (stdout.overflow || stderr.overflow) throw new IOException("ssh_output_limit");
      if (channel.getExitStatus() < 0) throw new IOException("ssh_connection_failed");
      Map<String, Object> result = new HashMap<>();
      result.put("stdout", stdout.text());
      result.put("stderr", stderr.text());
      result.put("exitCode", channel.getExitStatus());
      return result;
    } catch (JSchException error) {
      assertOpen();
      throw new IOException("ssh_connection_failed");
    } catch (InterruptedException error) {
      Thread.currentThread().interrupt();
      throw new IOException("ssh_session_closed");
    } finally {
      if (channel != null) channel.disconnect();
    }
  }

  @Override
  public void close() {
    closed.set(true);
    Socket connectionSocket = socket;
    if (connectionSocket != null) {
      try {
        connectionSocket.close();
      } catch (IOException ignored) {
        // The session cannot be reused after closure.
      }
    }
    Session connection = session;
    if (connection != null) connection.disconnect();
  }

  private void assertOpen() throws IOException {
    if (closed.get()) throw new IOException("ssh_session_closed");
  }

  private static String readCommand(String operation, String argument) throws IOException {
    if (argument.isEmpty()) {
      switch (operation) {
        case "kernel": return "uname -sr";
        case "addresses": return "ip -j addr";
        case "route": return "env LC_ALL=C ip -j route get 1.1.1.1";
        case "wifi": return "iw dev";
        default: break;
      }
    }
    if (operation.equals("link") && argument.matches("[a-zA-Z0-9_][a-zA-Z0-9_.-]{0,14}")) {
      return "iw dev " + argument + " link";
    }
    if (operation.equals("dns") && argument.length() <= 253 && argument.matches(
        "(?i)(?:[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?\\.)+[a-z](?:[a-z0-9-]{0,61}[a-z0-9])?\\.?")) {
      return "getent -s dns ahostsv4 " + argument;
    }
    throw new IOException("ssh_unsupported_operation");
  }

  private static final class BoundedOutput extends OutputStream {
    private final ByteArrayOutputStream bytes = new ByteArrayOutputStream();
    private volatile boolean overflow;

    @Override
    public synchronized void write(byte[] data, int offset, int length) throws IOException {
      if (length > MAX_OUTPUT_BYTES - bytes.size()) {
        overflow = true;
        throw new IOException("ssh_output_limit");
      }
      bytes.write(data, offset, length);
    }

    @Override
    public synchronized void write(int value) throws IOException {
      if (bytes.size() == MAX_OUTPUT_BYTES) {
        overflow = true;
        throw new IOException("ssh_output_limit");
      }
      bytes.write(value);
    }

    synchronized String text() {
      return new String(bytes.toByteArray(), StandardCharsets.UTF_8);
    }
  }

  private static final class FingerprintPin implements HostKeyRepository {
    private static final char[] HEX = "0123456789abcdef".toCharArray();
    private final byte[] expected;
    private boolean verified;
    private boolean rejected;

    FingerprintPin(String fingerprint) {
      expected = fingerprint.getBytes(StandardCharsets.US_ASCII);
    }

    @Override
    public int check(String host, byte[] key) {
      try {
        byte[] digest = MessageDigest.getInstance("SHA-256").digest(key);
        byte[] encoded = new byte[digest.length * 2];
        for (int index = 0; index < digest.length; index++) {
          int value = digest[index] & 0xff;
          encoded[index * 2] = (byte) HEX[value >>> 4];
          encoded[index * 2 + 1] = (byte) HEX[value & 0x0f];
        }
        verified = MessageDigest.isEqual(expected, encoded);
      } catch (NoSuchAlgorithmException error) {
        throw new IllegalStateException(error);
      }
      rejected = !verified;
      return verified ? OK : CHANGED;
    }

    @Override public void add(HostKey key, UserInfo user) {}
    @Override public void remove(String host, String type) {}
    @Override public void remove(String host, String type, byte[] key) {}
    @Override public String getKnownHostsRepositoryID() { return "Ling device pin"; }
    @Override public HostKey[] getHostKey() { return new HostKey[0]; }
    @Override public HostKey[] getHostKey(String host, String type) { return new HostKey[0]; }
  }
}

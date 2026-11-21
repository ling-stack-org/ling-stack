package expo.modules.lingdevicetransport;

import static org.junit.Assert.assertEquals;
import static org.junit.Assert.assertThrows;

import java.io.IOException;
import java.io.InputStream;
import java.io.OutputStream;
import java.nio.charset.StandardCharsets;
import java.security.KeyPair;
import java.security.KeyPairGenerator;
import java.util.Base64;
import java.util.concurrent.atomic.AtomicInteger;
import org.apache.sshd.common.config.keys.KeyUtils;
import org.apache.sshd.common.digest.BuiltinDigests;
import org.apache.sshd.common.keyprovider.KeyPairProvider;
import org.apache.sshd.server.Environment;
import org.apache.sshd.server.ExitCallback;
import org.apache.sshd.server.SshServer;
import org.apache.sshd.server.channel.ChannelSession;
import org.apache.sshd.server.command.Command;
import org.junit.Test;

public final class PinnedSshSessionTest {
  @Test(timeout = 20_000)
  public void checksTheHostKeyBeforeSendingThePassword() throws Exception {
    KeyPairGenerator generator = KeyPairGenerator.getInstance("RSA");
    generator.initialize(2048);
    KeyPair hostKey = generator.generateKeyPair();
    AtomicInteger authentications = new AtomicInteger();
    SshServer server = SshServer.setUpDefaultServer();
    server.setHost("127.0.0.1");
    server.setPort(0);
    server.setKeyPairProvider(KeyPairProvider.wrap(hostKey));
    server.setCommandFactory((channel, command) -> new FixtureRead(command));
    server.setPasswordAuthenticator((user, credential, session) -> {
      authentications.incrementAndGet();
      return user.equals("operator") && credential.equals("authorized-local-fixture");
    });
    server.start();
    try {
      try (PinnedSshSession connection = new PinnedSshSession()) {
        IOException mismatch = assertThrows(IOException.class, () -> connection.connect(
            "127.0.0.1", server.getPort(), "operator",
            new String(new char[64]).replace('\0', '0'), "authorized-local-fixture"));
        assertEquals("ssh_host_key_mismatch", mismatch.getMessage());
        assertEquals(0, authentications.get());
      }
      String fingerprint = KeyUtils.getFingerPrint(BuiltinDigests.sha256, hostKey.getPublic());
      StringBuilder hex = new StringBuilder();
      for (byte value : Base64.getDecoder().decode(fingerprint.substring("SHA256:".length()))) {
        hex.append(String.format("%02x", value & 0xff));
      }
      try (PinnedSshSession connection = new PinnedSshSession()) {
        connection.connect("127.0.0.1", server.getPort(), "operator", hex.toString(), "authorized-local-fixture");
        assertEquals(1, authentications.get());
        assertEquals("Linux 6.6-fixture\n", connection.read("kernel", "").get("stdout"));
        IOException unsupported = assertThrows(IOException.class, () -> connection.read("shell", ""));
        assertEquals("ssh_unsupported_operation", unsupported.getMessage());
        IOException literalDns = assertThrows(IOException.class, () -> connection.read("dns", "192.0.2.1"));
        assertEquals("ssh_unsupported_operation", literalDns.getMessage());
        IOException oversized = assertThrows(IOException.class, () -> connection.read("dns", "bounded.example.test"));
        assertEquals("ssh_output_limit", oversized.getMessage());
      }
    } finally {
      server.stop(true);
    }
  }

  private static final class FixtureRead implements Command {
    private final String command;
    private OutputStream output;
    private ExitCallback exit;

    FixtureRead(String command) { this.command = command; }

    @Override public void setInputStream(InputStream input) {}
    @Override public void setOutputStream(OutputStream stream) { output = stream; }
    @Override public void setErrorStream(OutputStream stream) {}
    @Override public void setExitCallback(ExitCallback callback) { exit = callback; }
    @Override public void destroy(ChannelSession channel) {}

    @Override
    public void start(ChannelSession channel, Environment environment) throws IOException {
      if (command.equals("uname -sr")) {
        output.write("Linux 6.6-fixture\n".getBytes(StandardCharsets.UTF_8));
      } else if (command.equals("getent -s dns ahostsv4 bounded.example.test")) {
        output.write(new byte[128 * 1024 + 1]);
      } else {
        exit.onExit(127);
        return;
      }
      output.flush();
      exit.onExit(0);
    }
  }
}

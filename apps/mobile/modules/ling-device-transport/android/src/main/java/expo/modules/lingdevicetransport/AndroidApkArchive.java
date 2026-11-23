package expo.modules.lingdevicetransport;

import android.content.pm.PackageInfo;
import android.content.pm.PackageManager;
import android.content.pm.Signature;
import android.os.Build;

import java.io.File;
import java.security.MessageDigest;
import java.security.NoSuchAlgorithmException;
import java.util.ArrayList;
import java.util.Collections;
import java.util.LinkedHashMap;
import java.util.List;
import java.util.Locale;
import java.util.Map;

final class AndroidApkArchive {
  private AndroidApkArchive() {}

  @SuppressWarnings("deprecation")
  static Map<String, Object> inspect(PackageManager packages, File file) throws NoSuchAlgorithmException {
    boolean modern = Build.VERSION.SDK_INT >= Build.VERSION_CODES.P;
    int flags = modern ? PackageManager.GET_SIGNING_CERTIFICATES : PackageManager.GET_SIGNATURES;
    PackageInfo info = packages.getPackageArchiveInfo(file.getPath(), flags);
    if (info == null) throw new IllegalArgumentException("apk_archive_invalid");

    Signature[] signers = modern && info.signingInfo != null
        ? info.signingInfo.getApkContentsSigners()
        : info.signatures;
    if (signers == null || signers.length == 0) throw new IllegalArgumentException("apk_signers_missing");
    MessageDigest sha256 = MessageDigest.getInstance("SHA-256");
    List<String> fingerprints = new ArrayList<>();
    for (Signature signer : signers) {
      StringBuilder hex = new StringBuilder(64);
      for (byte value : sha256.digest(signer.toByteArray())) hex.append(String.format(Locale.ROOT, "%02x", value & 0xff));
      fingerprints.add(hex.toString());
    }
    Collections.sort(fingerprints);

    long legacy = Integer.toUnsignedLong(info.versionCode);
    long version = modern ? info.getLongVersionCode() : legacy;
    Map<String, Object> result = new LinkedHashMap<>();
    result.put("packageId", info.packageName);
    result.put("versionCode", Long.toString(version));
    if (version > 0xffffffffL) result.put("legacyVersionCode", Long.toString(legacy));
    result.put("signerCertificateSha256", fingerprints);
    return result;
  }
}

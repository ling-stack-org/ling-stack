# JSch instantiates SSH algorithms and authentication methods by class name.
-keep,allowoptimization class com.jcraft.jsch.** {
    <init>();
}

# These JSch integrations are optional on Android and are never selected by the
# pinned password-only transport.
-dontwarn com.sun.jna.**
-dontwarn org.apache.logging.log4j.**
-dontwarn org.ietf.jgss.**
-dontwarn org.newsclub.net.unix.**
-dontwarn org.slf4j.**

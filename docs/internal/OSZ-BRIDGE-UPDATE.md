# osZ Bridge recovery — in-place Hardened 2 update

## Scope

Build `fix/osz-bridge-recovery`; do not merge to main as part of this update.
The APK must target the EXISTING package `com.seekerclaw.app.contextlitehardened2`.
Version stays 2.3.4 / code 28; the packaged Git commit identifies this new build.
An installed version with a higher versionCode is a stop condition, not permission to downgrade.

The Hardened workflow runs Node regressions and the full Android JVM suite, reuses
its existing signing key, verifies package/signature/packaged commit, and exports
APK-INFO.txt and SHA256SUMS alongside the APK. Missing signing key aborts the build;
never generate a new key as an update workaround.

## Before installation

1. Export a private backup using the existing app's Settings export function.
   Keep it on-device/offline; do not attach it to GitHub or chat. Keep the existing
   app installed: a backup does not preserve Android Keystore keys after uninstall.
2. Connect the intended phone over authorized ADB. Verify the installed Hardened 2
   package, version and signing certificate against the new APK. Do not assume the
   latest CI signing key necessarily matches the phone's installed APK.
3. Gracefully STOP the agent in the existing app before backup/install so its
   in-memory state is flushed. Do not clear app storage or force-stop as a substitute
   for the graceful shutdown.
4. Verify the downloaded APK checksum and embedded commit. Preserve the existing
   installed APK locally for identification; no app-private data may be uploaded.
5. If practical, additionally take a private local `run-as` backup of files,
   shared_prefs and databases while stopped. Such backups can contain credentials;
   never commit or publish them. Compare memory/identity file checksums before and
   immediately after installation, before starting the agent again.

## Installation gate

Use **only an in-place replacement**, e.g. `adb -s <verified-device> install -r <verified-apk>`.
No uninstall, `pm clear`, reset-config/wipe-memory, `-d` downgrade, or new parallel
package. If signature/package/version checks or replacement fail, STOP and diagnose;
never uninstall to make installation succeed.

Same package and signing identity plus `install -r` preserves Android app data and
Keystore identity. The patch does not delete/overwrite workspace memory, database,
identity, skills, credentials or configuration. Storage failure and OS/device issues
still make a verified private backup important; do not promise unconditional safety.

After replacement, verify data preservation first. Then explicitly START the agent
(the persisted STOP guard intentionally prevents silent restart), verify the installed
commit in About/logs, RUNNING only after authenticated Bridge health, Android tool
operation, and Telegram separately. A Kotlin/CI pass is not device E2E evidence.

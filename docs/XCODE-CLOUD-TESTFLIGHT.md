# Xcode Cloud and TestFlight

The repository is prepared for a signed iOS archive without storing an Apple
Developer Team ID in Git. The shared `bitchat (iOS)` scheme is the archive
scheme, and `ci_scripts/ci_post_clone.sh` creates the ignored signing config
inside Xcode Cloud.

## One-time Apple setup

After joining the Apple Developer Program:

1. In Certificates, Identifiers & Profiles, register an App ID for the bundle
   identifier `chat.bitchat.<suffix>` and enable App Groups.
2. Register the share extension App ID `chat.bitchat.<suffix>.ShareExtension`.
3. Register the App Group `group.chat.bitchat.<suffix>` and attach it to both
   App IDs.
4. In App Store Connect, create an iOS app using the same main bundle ID.

Use the Team ID as `<suffix>` unless it is already used. The suffix must be
the same for the main app, share extension, and App Group.

## Xcode Cloud workflow

Create a workflow for the fork and configure:

- Repository: `trinhngocmai14835-dev/bitchat`
- Scheme: `bitchat (iOS)`
- Action: Archive
- Platform: iOS
- Signing: automatic signing with the connected Apple Developer account
- Environment variable: `BITCHAT_TEAM_ID` = the Apple Developer Team ID
- Optional environment variable: `BITCHAT_BUNDLE_SUFFIX` = the registered suffix

The post-clone script generates `Configs/Local.xcconfig` with the team ID,
bundle ID, and App Group. It is ignored and never committed. The first archive
should be uploaded to TestFlight from Xcode Cloud.

## Two-iPhone test

1. Install TestFlight on both iPhones.
2. Add both devices as internal TestFlight testers in App Store Connect.
3. Install the same build on both phones.
4. Allow Bluetooth, camera, microphone, and photo access when prompted.
5. On phone A, open the private contacts screen and show its invite QR code.
6. On phone B, scan the QR code, then send a private message.
7. Repeat in the other direction. For long-distance testing, keep internet
   access enabled; the private relay path is used when the phones are not
   connected over Bluetooth.

No app account registration is required. Each installation creates its own
local identity, and the QR invite authorizes the selected contact.

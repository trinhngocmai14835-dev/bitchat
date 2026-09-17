# Private iOS MVP

This branch narrows the iOS entry experience toward invitation-only private chat.

## Current behavior

- iOS opens on a private contacts home instead of a public composer.
- A QR invite may introduce a contact that is not currently visible over BLE.
- The signed QR payload stores the contact's Noise public key, Nostr public key, and nickname locally as a favorite.
- Selecting that contact opens the existing private conversation flow; NostrTransport can deliver it over relays when the contact is remote.
- The existing QR sheet remains the single place to show this device's invite or scan another invite.

## Deliberate limitations in this pass

- The upstream mesh and public-channel services are still compiled and started underneath the new iOS entry screen.
- Identity backup/import and a dedicated contact-removal UI are not yet included.
- Final validation requires macOS/Xcode and two iOS installations, because this Windows environment cannot compile or run iOS targets.

## Automated validation

`.github/workflows/ios-validation.yml` builds the iOS simulator target without signing and runs the Swift package tests on a macOS GitHub Actions runner. It is intentionally separate from TestFlight distribution, which will be configured later through Xcode Cloud after the Apple Developer account is available.

Place the arm64 helper binaries here as:

prebuilt/macos/arm64/modern/bridge   (macOS 14+, ScreenCaptureKit)
prebuilt/macos/arm64/legacy/bridge   (macOS 12+, CGWindow/screencapture)

`setup-helper.mjs` will copy the appropriate variant binary to:
~/.pi/agent/helpers/pi-computer-use/bridge

Build them with:

node scripts/build-native.mjs --arch arm64 --variant modern
node scripts/build-native.mjs --arch arm64 --variant legacy

For public releases, sign with a Developer ID Application identity and notarize the package artifact.

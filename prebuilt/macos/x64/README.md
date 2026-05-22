Place the x64 helper binaries here as:

prebuilt/macos/x64/modern/bridge   (macOS 14+, ScreenCaptureKit)
prebuilt/macos/x64/legacy/bridge   (macOS 12+, CGWindow/screencapture)

`setup-helper.mjs` will copy the appropriate variant binary to:
~/.pi/agent/helpers/pi-computer-use/bridge

Build them with:

node scripts/build-native.mjs --arch x64 --variant modern
node scripts/build-native.mjs --arch x64 --variant legacy

For public releases, sign with a Developer ID Application identity and notarize the package artifact.

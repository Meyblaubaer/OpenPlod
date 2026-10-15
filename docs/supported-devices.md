# Supported Devices and Platforms

This matrix lists only what has recorded evidence in the README and CHANGELOG. Anything not
listed as verified is **not established**. A row marked verified describes the specific setup
that was tested, not every unit, firmware, or OS version.

## Plaud recorders

| Recorder | Status | Evidence |
| --- | --- | --- |
| Plaud Note Pro (one owner-authorized unit, protocol 20) | Verified: direct Bluetooth listing, download, decryption, import and playback, source retained | macOS desktop and Android companion (README "Android Companion"; CHANGELOG 0.5.1/0.6.0) |
| Other Plaud Note Pro units and firmware versions | Not established | No second unit or firmware version has been tested |
| Plaud Note, NotePin and other models | Not established | Never tested |
| Fresh-owner (account-free) authorization | Not verified | The successful tests used an existing account-authorized identity |

The recorder refuses audio until the computer or phone holds a Plaud-minted identity for it.
OpenPlod never resets, re-binds or deletes recordings on the device.

The device's transfer-tail checksum is recorded but its algorithm is unconfirmed; see
[recovery](recovery.md#transfer-tail-checksum).

## Desktop

| Platform | Vault (import, transcripts, documents) | Direct Plaud Bluetooth | Packages |
| --- | --- | --- | --- |
| macOS, Apple Silicon | Built and tested | Verified on the Note Pro above | Build from source. The last prebuilt ZIP (0.5.0) was ad-hoc signed, not notarized |
| macOS, Intel | Not tested | Not tested | None |
| Linux (Arch/Omarchy, Hyprland, BlueZ) | Builds and runs | Discovery and connection verified against the real Note Pro; a full download on Linux is not recorded | `.deb`/`.rpm` build from source |
| Other Linux distributions | Not tested | Not tested | — |
| Windows | Bridge builds for WinRT | Not verified on hardware | None |
| Docker (web vault) | File imports only | Not available | `docker compose` |

## Mobile

| Platform | Status |
| --- | --- |
| Android ARM64 (development build) | Direct encrypted Bluetooth listing, download, playable Opus and source retention verified on the Note Pro above; one-time enrollment from the authorized Mac verified. No public APK |
| Android 16 KB page-size devices | APK and native-library alignment checks pass; runtime on a 16 KB device not verified |
| Android background/boot recovery | Not verified (battery restrictions and process death can stop monitoring) |
| iOS | Direct extraction not supported |

## Requirements that are not bundled

- `ffmpeg` and `ffprobe` for direct Plaud extraction and audio conversion.
- Whisper.cpp binary and models for local transcription; Ollama for local text AI.
- BlueZ and D-Bus access on Linux.

## Reporting compatibility

When you test another recorder or platform, report the model, firmware version, OS, and which
steps worked (discover, connect, list, download, decode, play, source retained). Do not include
serial numbers, identity files or recordings in public reports.

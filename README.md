# IMU FFT

Minimal Tauri 2 desktop app for viewing the ICM-42688-P firmware UART stream, live acceleration plots, FFT peak readout, and a 3D orientation model.

The current app version is `0.1.4`.

## Launch the Desktop App

```powershell
npm install
npm run dev
```

`npm run dev` starts the Vite frontend on `http://127.0.0.1:1420` and opens the Tauri desktop window. On Windows, you can also double-click `dev.bat` from the repo root to run the same development app.

The app opens the first detected serial port at `921600` baud, clears the input buffer, and listens for binary `0xAA 0x55` frames. It does not send serial commands. If no serial port is present, the interface can run on bounded simulated data and keeps checking for a real sensor.

## UI Overview

- The top-left status LED shows only the dot by default; the UI uses one shared tooltip style for hover/focus labels such as `Connected`, `Simulation`, and `No Sensor connected`.
- The simulation toggle enables fallback sample data when no serial device is connected.
- The top readouts show FFT peak frequency, peak axis, latest `Ax`, `Ay`, `Az`, and filtered `Tilt X` / `Tilt Y` pose angles. The FFT peak marker stays hidden until live or simulated data is running.
- The 3D model pose uses an 8 Hz low-pass filtered accelerometer stream before deriving its tilt angles, while the accelerometer chart and FFT still use the raw sample ring.
- The icon-only tare button recenters the 3D model view.
- If an updater release is available, the topbar shows a red update icon; hover or focus it to see update availability, download, install, or error text.

## Package the Desktop App

```powershell
npm install
npm run build:tauri
```

This builds the frontend, compiles the Tauri app in release mode, and creates a Windows MSI installer because `src-tauri/tauri.conf.json` sets `bundle.targets` to `["msi"]`. The packaged installer is written under:

```text
src-tauri/target/release/bundle/msi/
```

After packaging, the release executable is also available at:

```text
src-tauri/target/release/imu-fft.exe
```

## Publish Auto Updates

The installed app checks GitHub Releases for a signed Tauri updater manifest at startup:

```text
https://github.com/TobiasKoehlerETH/imu-fft/releases/latest/download/latest.json
```

The updater signing private key was generated outside the repository at:

```text
%USERPROFILE%\.tauri\imu-fft.key
```

The GitHub repository needs these secrets before publishing signed updater artifacts:

```text
TAURI_SIGNING_PRIVATE_KEY
TAURI_SIGNING_PRIVATE_KEY_PASSWORD
```

`TAURI_SIGNING_PRIVATE_KEY` can be either the private key content or the signing key file content. The generated local key has no password, so `TAURI_SIGNING_PRIVATE_KEY_PASSWORD` can be left empty unless you replace the key with a password-protected one.

Run `.github/workflows/release.yml` manually to publish a new release. Choose `patch`, `minor`, or `major`, or pass an exact SemVer version such as `0.1.4`. The workflow updates `package.json`, `package-lock.json`, `src-tauri/Cargo.toml`, and `src-tauri/tauri.conf.json`, commits the version bump, tags the release, and publishes the MSI plus updater metadata.

You can also bump versions locally before a release:

```powershell
node scripts/bump-version.mjs --bump patch
```

Human-pushed tags matching `v*.*.*` are still supported as long as the tag version matches all version files.

Each GitHub release should include release notes with a bullet-point list of the major user-facing changes in that version. Keep the installer guidance in the release body:

```text
Download the Windows installer asset named IMU.FFT_<version>_x64_en-US.msi.
```

The `.sig` file and `latest.json` asset are used by the in-app auto updater and do not need to be downloaded manually.

## Verify

```powershell
npm run build
npm test
```

`npm run build` runs TypeScript, builds the Vite frontend, and compiles the Rust backend. `npm test` runs `cargo test --manifest-path src-tauri/Cargo.toml`.

## 8 kHz Frame Parser - Why It Stays Cheap At Line Rate

The IMU streams 160 frames/s of 304 bytes each (2 sync + 2 seq + 50 x 6 sample bytes), giving 8000 samples/s x 6 B = **48 KB/s** of UART traffic. `FrameParser` in [`src-tauri/src/stream.rs`](src-tauri/src/stream.rs) is built so the parsing cost is dominated by the kernel serial read, not the decode.

| Property | Implementation | Cost at 8 kHz |
| --- | --- | --- |
| **Bytewise state machine** | A 3-state enum (`Sync0` to `Sync1` to `Payload`) consumed by `feed(byte)` with a single `match`. No look-ahead, no backtracking, no scanning. | One predictable branch per UART byte, about 50 k branches/s. |
| **Stack-resident buffer** | `payload: [u8; PAYLOAD_BYTES]` is an inline array on the parser struct. No `Vec`, no allocator calls in the hot path. | One cache-line write per byte. Zero heap traffic per frame. |
| **Zero-copy resync** | When sync breaks, `resyncs` increments and the state resets without rewind or a replay buffer. | Worst-case resync latency is bounded by the next frame, about 6.25 ms, and invisible to the 200 ms FFT cadence. |
| **Decode is bit-twiddling** | `i16::from_le_bytes` lowers to a small integer load and sign extension; the 50-sample loop is straightforward for the optimizer. | Tiny compared with serial I/O at 48 KB/s. |
| **Frames returned by value** | `DecodedFrame { samples: [[f32; 3]; 50] }` is a 600-byte POD moved on the stack. No `Box`, no `Arc`. | Stays L1-resident and never escapes to the heap on the producer side. |
| **Bounded downstream ring** | `SampleRing` is a fixed-capacity `Vec` (`FFT_SIZE * 2`) with O(1) modular push. | Memory stays constant for arbitrarily long runs. |
| **Cadence-decoupled emit** | Sample ingest runs as fast as bytes arrive, but `model`, `accel`, `fft`, and `status` Tauri events fire on time deadlines. | UI work scales with refresh rate, not sample rate. |

End-to-end, the producer thread runs an O(N) byte loop with no hot-path allocations and no copies beyond decoded `f32` values landing in the ring buffer. At 48 KB/s the parser uses a small fraction of one core; the bottleneck is the serial driver, not the Rust code.

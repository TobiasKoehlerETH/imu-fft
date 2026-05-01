# IMU FFT

Minimal Tauri 2 app for the ICM-42688-P firmware UART stream.

## Launch the Desktop App

```powershell
npm install
npm run dev
```

`npm run dev` starts the Vite frontend on `http://127.0.0.1:1420` and opens the Tauri desktop window. On Windows, you can also double-click `dev.bat` from the repo root to run the same development app.

The app opens the first detected serial port at `921600` baud, clears the input buffer, and listens for binary `0xAA 0x55` frames. It does not send serial commands. If no serial port is present, the interface runs on bounded simulated data and keeps checking for a real sensor.

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

Before publishing the first release, add these GitHub repository secrets:

```text
TAURI_SIGNING_PRIVATE_KEY
TAURI_SIGNING_PRIVATE_KEY_PASSWORD
```

`TAURI_SIGNING_PRIVATE_KEY` can be either the private key content or the signing key file content. The generated local key has no password, so `TAURI_SIGNING_PRIVATE_KEY_PASSWORD` can be left empty unless you replace the key with a password-protected one.

To publish the first release as `0.1.0`, run the release workflow manually with `version` set to `0.1.0`. For later releases, run the same workflow without an exact version and choose `patch`, `minor`, or `major`; the workflow updates `package.json`, `package-lock.json`, `src-tauri/Cargo.toml`, and `src-tauri/tauri.conf.json`, commits that version bump, tags the release, and publishes the MSI plus updater metadata.

You can also bump versions locally before a release:

```powershell
node scripts/bump-version.mjs --bump patch
```

The `.github/workflows/release.yml` workflow builds the Windows MSI, uploads updater signatures, and publishes `latest.json` to the release. Human-pushed tags matching `v*.*.*` are still supported as long as the tag version matches the version files.

## Verify

```powershell
npm run build
npm test
```

## 8 kHz frame parser — why it stays cheap at line rate

The IMU streams 160 frames/s of 304 bytes each (2 sync + 2 seq + 50 × 6 sample bytes), giving 8000 samples/s × 6 B = **48 KB/s** of UART traffic. `FrameParser` in [`src-tauri/src/stream.rs`](src-tauri/src/stream.rs) is built so the parsing cost is dominated by the kernel serial read, not the decode.

| Property | Implementation | Cost at 8 kHz |
| --- | --- | --- |
| **Bytewise state machine** | A 3-state enum (`Sync0` → `Sync1` → `Payload`) consumed by `feed(byte)` with a single `match`. No look-ahead, no backtracking, no scanning. | One predictable branch per UART byte (~50 k branches/s). |
| **Stack-resident buffer** | `payload: [u8; PAYLOAD_BYTES]` is an inline array on the parser struct. No `Vec`, no allocator calls in the hot path. | One cache-line write per byte. Zero heap traffic per frame. |
| **Zero-copy resync** | When sync breaks, we increment `resyncs` and reset state — no rewind, no replay buffer. | Worst-case resync latency is bounded by the next frame (~6.25 ms), invisible to the 200 ms FFT cadence. |
| **Decode is bit-twiddling** | `i16::from_le_bytes` lowers to a single `u16` load + sign-extend; the 50-sample loop is trivially unrollable / auto-vectorizable. | ~50 cycles per sample on a modern x86 core, ~400 µs/s of CPU for the decode loop. |
| **Frames returned by value** | `DecodedFrame { samples: [[f32; 3]; 50] }` is a 600-byte POD moved on the stack — no `Box`, no `Arc`. | Stays L1-resident; never escapes to the heap on the producer side. |
| **Bounded downstream ring** | `SampleRing` is a fixed-capacity `Vec` (`FFT_SIZE * 2`) with O(1) modular push. | Memory is constant for arbitrarily long runs. |
| **Cadence-decoupled emit** | Sample ingest runs as fast as bytes arrive, but `model` / `accel` / `fft` Tauri events fire on **time deadlines** (16 ms / 50 ms / 200 ms), not per sample. | UI work scales with refresh rate, not with sample rate. |

End-to-end, the producer thread runs an `O(N)` byte loop with no allocations and no copies beyond the decoded `f32` values landing in the ring buffer. At 48 KB/s the parser uses a small fraction of one core; the bottleneck is the serial driver, not the Rust code.

# Repo Memory

Last reviewed: 2026-05-01

## Latest Work

- Added root-level agent guidance in `agent.md` so future agents have repo-specific commands, architecture notes, testing expectations, and realtime-stream constraints.
- Added this `memory.md` as the short-lived project memory file. `agent.md` links here and the heartbeat should keep both files current.
- Added a release-note requirement: every GitHub release should include a bullet-point list of major user-facing changes.
- Reworked the top bar so the tare control uses a Lucide refresh icon, the update install action is an icon button, and the disconnected state reads `no sensor connected`.

## Recent Repo Changes

- Improved GitHub release download description so users know to download the MSI and ignore updater-only assets.
- Published releases `v0.1.1` and `v0.1.2`.
- Fixed the release workflow build command and Tauri action version.
- Published release `v0.1.0`.
- Added Tauri auto-update support with signed updater metadata published through GitHub Releases.
- Updated the IMU FFT app UI and streaming path, including live charts, simulated fallback data, and status/model/FFT event handling.
- Tuned simulator noise, stabilized topbar values, and documented why the 8 kHz frame parser stays cheap at line rate.

## Current Architecture Notes

- Frontend: Vite + TypeScript in `src`, with ECharts for acceleration/FFT plots and Three.js for the IMU model view.
- Backend: Tauri 2 + Rust in `src-tauri`, with serial discovery, frame parsing, sample buffering, simulation, orientation snapshots, and FFT analysis.
- Runtime stream: binary `0xAA 0x55` frames at `921600` baud, 160 frames/s, 50 samples/frame, 8000 samples/s.
- UI cadence: Rust emits model, acceleration, FFT, and status events on timers rather than per sample.

## Keep In Mind

- Preserve the bounded, allocation-light stream path in `src-tauri/src/stream.rs`.
- Keep browser-preview simulation working when the frontend runs without Tauri internals.
- Keep release versions aligned across `package.json`, `package-lock.json`, `src-tauri/Cargo.toml`, and `src-tauri/tauri.conf.json`.
- Run `npm run build` for frontend/package changes and `npm test` for Rust stream, parser, simulator, orientation, or DSP changes.

# Repo Memory

Last reviewed: 2026-05-04

## Latest Work

- Prepared release `v0.1.4` with low-pass filtered accelerometer input for 3D pose estimation and two topbar tilt-angle readouts derived from the same filtered pose sample.
- Added `Tilt X` and `Tilt Y` topbar readouts alongside `Ax`, `Ay`, and `Az`; the live serial path and browser preview both use the same 8 Hz one-pole low-pass filter for pose snapshots.
- Fixed the FFT display to use a stable dB axis range instead of auto-ranging on every FFT update.
- Simplified chart/model chrome by removing the model-rate and static `8 kHz` title tags from the main workspace.
- Changed the update notification to a red icon-only topbar button that shows availability/progress/error text through the shared hover/focus tooltip.
- Bumped the app to `0.1.3` for the shared tooltip cleanup, black ECharts axis labels, and hidden idle FFT peak marker.
- Replaced native topbar `title` tooltips with the shared `data-tooltip` CSS pattern so only one hover/focus tooltip appears.
- Updated FFT display logic so chart data and the red peak marker stay hidden while the stream is only searching for a sensor.
- Set ECharts axis names and tick labels to black for higher contrast.
- Changed the top-left status UI to a dot-only LED that reveals `Connected`, `Simulation`, or `No Sensor connected` on hover or keyboard focus.
- Added root-level agent guidance in `agent.md` so future agents have repo-specific commands, architecture notes, testing expectations, and realtime-stream constraints.
- Added this `memory.md` as the short-lived project memory file. `agent.md` links here and the heartbeat should keep both files current.
- Added a release-note requirement: every GitHub release should include a bullet-point list of major user-facing changes.
- Reworked the top bar so the tare control uses a Lucide refresh icon and the update install action is an icon button.
- Refreshed `README.md` to match current versions, the icon-based topbar, release workflow expectations, and the ASCII-clean 8 kHz parser notes.
- Updated `agent.md` so future agents keep `README.md` aligned during the same heartbeat as `agent.md` and `memory.md`.

## Recent Repo Changes

- Prepared release `v0.1.4`.
- Published release `v0.1.3`.
- Reissued `v0.1.2` again for the hover-only status LED behavior.
- Reissued `v0.1.2` after the `v0.1.2` release commit.
- Improved GitHub release download description so users know to download the MSI and ignore updater-only assets.
- Published releases `v0.1.1` and `v0.1.2`.
- Fixed the release workflow build command and Tauri action version.
- Published release `v0.1.0`.
- Added Tauri auto-update support with signed updater metadata published through GitHub Releases.
- Updated the IMU FFT app UI and streaming path, including live charts, simulated fallback data, and status/model/FFT event handling.
- Tuned simulator noise, stabilized topbar values, and documented why the 8 kHz frame parser stays cheap at line rate.

## Current Architecture Notes

- Frontend: Vite + TypeScript in `src`, with ECharts for acceleration/FFT plots, Three.js for the IMU model view, and Lucide icons for icon-only controls.
- Backend: Tauri 2 + Rust in `src-tauri`, with serial discovery, frame parsing, sample buffering, simulation, orientation snapshots, and FFT analysis.
- Runtime stream: binary `0xAA 0x55` frames at `921600` baud, 160 frames/s, 50 samples/frame, 8000 samples/s.
- UI cadence: Rust emits model, acceleration, FFT, and status events on timers rather than per sample.
- Pose model: Rust applies an 8 Hz one-pole low-pass filter before computing the `model` event angles. The `Tilt X` / `Tilt Y` topbar readouts come from that same filtered snapshot, while charts and FFT stay raw.

## Keep In Mind

- Preserve the bounded, allocation-light stream path in `src-tauri/src/stream.rs`.
- Keep browser-preview simulation working when the frontend runs without Tauri internals.
- Keep release versions aligned across `package.json`, `package-lock.json`, `src-tauri/Cargo.toml`, and `src-tauri/tauri.conf.json`.
- Keep `README.md`, `agent.md`, and `memory.md` synchronized during the hourly heartbeat.
- Run `npm run build` for frontend/package changes and `npm test` for Rust stream, parser, simulator, orientation, or DSP changes.

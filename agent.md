# Agent Notes

## Project Shape

`imu-fft` is a small Tauri 2 desktop app for visualizing an ICM-42688-P IMU UART stream. The frontend is Vite + TypeScript with ECharts and Three.js. The backend is Rust under `src-tauri`, where the serial reader, frame parser, simulator, orientation model, and FFT analysis live.

The app expects binary `0xAA 0x55` frames at `921600` baud. If no serial port is available, the UI can run with bounded simulated data.

## Current Memory

Read [`memory.md`](memory.md) before making changes. It summarizes the latest repo work, recent release/versioning changes, and any open context that is easy to lose between sessions.

## Common Commands

Run from the repository root:

```powershell
npm install
npm run dev
npm run build
npm test
```

`npm run dev` starts the Vite frontend on `http://127.0.0.1:1420` and launches the Tauri desktop window. `npm run build` builds the frontend and Rust backend. `npm test` runs `cargo test --manifest-path src-tauri/Cargo.toml`.

For release packaging:

```powershell
npm run build:tauri
```

Local version bumps use:

```powershell
node scripts/bump-version.mjs --bump patch
```

## Important Files

- `src/main.ts` owns the browser/Tauri UI wiring, chart setup, simulated browser preview, update checks, and Tauri event listeners.
- `src/model.ts` owns the Three.js model view.
- `src/style.css` owns the application layout and visual system.
- `src-tauri/src/main.rs` registers Tauri commands and starts the stream controller.
- `src-tauri/src/stream.rs` owns serial discovery, simulation, event emission, frame parsing, sample buffering, and orientation snapshots.
- `src-tauri/src/dsp.rs` owns FFT constants, windowing, DC removal, peak detection, and DSP unit tests.
- `src-tauri/tauri.conf.json` owns app metadata, bundling, and updater settings.
- `.github/workflows/release.yml` publishes MSI releases and updater metadata.

## Engineering Constraints

Keep the streaming path cheap. The parser and sample ring are intentionally allocation-light and bounded because the IMU stream runs at 8000 samples/s. Avoid adding per-byte or per-sample heap allocation, logging, event emission, or UI work.

Keep UI updates cadence-based. The Rust backend emits model, acceleration, FFT, and status events on timed intervals; it should not emit one event per sample or frame.

Keep the browser preview useful. `src/main.ts` supports a non-Tauri preview path using simulated data; changes to the UI should continue to work when opened by Vite alone.

Preserve Tauri updater behavior. Version changes should stay coordinated across `package.json`, `package-lock.json`, `src-tauri/Cargo.toml`, and `src-tauri/tauri.conf.json`.

Every GitHub release must include a release-notes section with a bullet-point list of the major user-facing changes in that version. Keep the installer guidance, but do not publish a release body that only lists download instructions.

## Testing Expectations

For frontend or packaging changes, run:

```powershell
npm run build
```

For Rust stream, parser, simulator, orientation, or DSP changes, run:

```powershell
npm test
```

When touching release automation or versioning, also inspect the generated diff for version consistency.

## Repo Hygiene

Do not commit generated build output from `dist`, `dist-desktop`, `node_modules`, or Tauri target folders. Be careful with hardware-specific assumptions: the app chooses the first detected COM-style serial port on Windows, then falls back to any available serial port.

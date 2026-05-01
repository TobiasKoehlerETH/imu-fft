# One-Shot Codex Prompt: Minimal High-Performance Rebuild

You are Codex working in `C:\Code\apv-seb`. Rebuild this desktop app from scratch as a minimal, low-latency Tauri + Rust + vanilla TypeScript application for parsing the ICM-42688-P firmware UART stream, computing the existing FFT/peak behavior, and displaying live charts plus the existing 3D model mapping. Implement the change end to end in this repo.

## Goal

Replace the current Electron + React + Chart.js app with the smallest practical Tauri app:

- Rust backend handles serial input, parsing, fixed-size buffering, filtering, FFT, peak detection, orientation snapshots, and app events.
- Frontend uses vanilla TypeScript, Canvas 2D charts, and Three.js for the existing GLB model.
- UI is visually minimal, but it must keep every live chart and value card currently shown by the app: 3D view, accelerometer chart, FFT chart, dominant frequency/axis, and Ax/Ay/Az sensor readouts.
- Do not add functionality that is not already present in the current UI.
- Preserve the existing math and model mapping, but optimize the data path so 8 kHz serial input does not lag or grow memory.

## Sources To Read First

Read these local files before editing:

- `package.json`, `vite.config.ts`, `tsconfig.json`
- `src/main/serial/fast-parser.ts`
- `src/main/serial/fast-serial-service.ts`
- `src/main/fast-frequency-analysis.ts`
- `src/common/telemetry.ts`
- `src/renderer/App.tsx`
- `src/renderer/components/DataChart.tsx`
- `src/renderer/components/FftChart.tsx`
- `src/renderer/components/ModelViewer.tsx`
- `src/renderer/styles/app.css`
- `src/renderer/styles/global.css`
- `tests/fast-parser.test.ts`
- `tests/telemetry.test.ts`
- `fast.py`
- `log_accelerometer.py`

Also check the firmware repo:

- `https://github.com/TobiasKoehlerETH/icm42688p_driver`
- `https://raw.githubusercontent.com/TobiasKoehlerETH/icm42688p_driver/main/src/main.rs`
- `https://raw.githubusercontent.com/TobiasKoehlerETH/icm42688p_driver/main/src/driver/mod.rs`
- `https://raw.githubusercontent.com/TobiasKoehlerETH/icm42688p_driver/main/host/sample_rate.py`

## Firmware Protocol

Target the current firmware in `TobiasKoehlerETH/icm42688p_driver`.

Important: do not send `stop`, `config`, `start 32000`, or any other serial command. The current firmware initializes itself and streams immediately after boot. The old app sends commands because it targeted an older firmware path; remove that behavior.

Serial settings:

- Baud: `921600`
- Format: `8N1`
- Mode: binary only
- Sync: `0xAA 0x55`

Frame format:

```text
0xAA 0x55
u16 block_seq_le
50 * (ax:i16_le, ay:i16_le, az:i16_le)
```

Constants:

- `SAMPLES_PER_FRAME = 50`
- `SAMPLE_BYTES = 6`
- `FRAME_BYTES = 304`
- Current sample rate: `8000 Hz`
- Current frame rate: `160 frames/s`
- Current full-scale range: `AccelFs::Gpm2`
- Current scale: `g = raw / 16384`

Parser requirements:

- Open the first available serial port unless a minimal internal config chooses another.
- Clear the serial input buffer on connect.
- Find sync byte-by-byte.
- After sync, read the fixed payload size.
- Decode `seq` and 50 signed XYZ samples.
- Track sequence gaps and resyncs internally.
- If the next sync is missing, resync without growing memory.
- Do not allocate per sample and do not concatenate buffers.

## Backend Architecture

Use Tauri 2 if practical. Use Rust crates:

- `serialport` for UART
- `rustfft` for FFT
- `serde` for event payloads
- `thiserror` or simple custom errors
- A bounded channel or ring buffer implementation; a small hand-written ring buffer is acceptable and preferred if it keeps code shorter.

Keep backend modules minimal:

- `main.rs`: Tauri setup, commands, app state, event wiring.
- `stream.rs`: serial worker, parser, ring buffers, DSP, snapshot emission.
- Optional `dsp.rs` only if `stream.rs` becomes too large.

Runtime model:

- One serial worker thread owns the port and parser.
- One bounded sample ring stores the latest accelerometer samples for chart/FFT/model work.
- Emit frontend snapshots at bounded rates:
  - Accelerometer chart: about `20 Hz`
  - FFT: about `5 Hz`
  - Model/readout/status: up to `60 Hz`
- Never emit one frontend event per raw sample.
- Never store unbounded sample history.
- Dropped frames or sequence gaps should update internal metrics and status, not create a backlog.

Expose only the minimal Tauri surface:

```ts
type StatusSnapshot = {
  state: "live" | "searching" | "error"
  detail: string
  sampleRateHz: number
  frameRateHz: number
  sequenceGaps: number
  resyncs: number
}

type AccelSnapshot = {
  samples: number[] // flat [x0,y0,z0,x1,y1,z1,...] in g, fixed max length
}

type FftSnapshot = {
  freqs: number[]
  combinedDb: number[]
  peakHz: number
  peakAxis: "x" | "y" | "z"
}

type ModelSnapshot = {
  ax: number
  ay: number
  az: number
  roll: number
  pitch: number
  yaw: number
}
```

Use Tauri events for snapshots. Commands should be limited to:

- `start_stream()`
- `stop_stream()`

Start streaming automatically when the app launches. If no port is found, stay in `searching` and retry periodically.

## FFT And Peak Behavior

Preserve the Python prototype behavior from `fast.py` as canonical, not the current TypeScript axis-only FFT chart behavior.

Constants:

- `FFT_SIZE = 8192`
- `SAMPLE_RATE_HZ = 8000`
- `FFT_INTERVAL_MS = 200`
- `MIN_PEAK_HZ = 1`
- `THRESHOLD_DB = -70`
- `DISPLAY_MAX_HZ = 1000`

For each FFT run:

1. Take the latest 8192 samples per axis from the fixed ring.
2. Remove DC mean per axis.
3. Apply Hann window.
4. Run FFT per axis.
5. Use single-sided magnitudes.
6. Per-axis amplitude:

```text
amplitude = (2 / FFT_SIZE) * (magnitude / hann_mean)
normalized = amplitude / 8
db = 20 * log10(max(normalized, 1e-12))
```

7. Create a combined spectrum from per-axis linear amplitudes using the Python prototype's RMS-like intent:

```text
combined_amp = sqrt(mean([ax_amp^2, ay_amp^2, az_amp^2]))
combined_db = 20 * log10(max(combined_amp / 8, 1e-12))
```

8. Ignore bins below 1 Hz.
9. Peak is the max combined dB bin.
10. If peak dB is below `-70`, report `peakHz = 0`.
11. Dominant axis is the axis with the highest linear amplitude at the selected peak bin.

The FFT chart should display `combinedDb` versus `freqs`, up to 1000 Hz.

## Filtering And Orientation

Keep the existing despike/filter intent but keep it cheap:

- Use a small Hampel-style filter only if needed for stable display.
- Do not run expensive sorting on every raw sample if it causes load; it is acceptable to apply smoothing/downsampling only to the model/readout stream.

Preserve the current accelerometer-to-model mapping from `src/common/telemetry.ts` and `ModelViewer.tsx`:

```text
roll  = atan2(-ay, hypot(ax, az)) * RAD_TO_DEG
pitch = 0
yaw   = atan2(-ax, az) * RAD_TO_DEG
```

Frontend Three.js rotation:

```ts
new THREE.Euler(rollRad, pitchRad, yawRad, "ZYX")
```

The firmware stream is accelerometer-only, so do not invent gyroscope behavior. Do not add calibration, tare, recording, port picking, or settings UI.

## Minimal Frontend

Do not use React. Do not use Chart.js. Do not add a component library.

Use:

- `src/main.ts`
- `src/style.css`
- `src/model.ts`
- `three`

HTML/layout:

```text
header:
  Live/searching status
  stream/detail text
  Peak: 000.00 Hz X/Y/Z
  Ax Ay Az

main:
  left: 3D model view
  right top: acceleration canvas
  right bottom: FFT canvas
  bottom/right compact readouts:
    Frequency: Axis, Freq
    Sensors: Ax, Ay, Az
```

Visual style:

- Near-white background.
- Black and gray text.
- Thin neutral borders.
- No glass effect.
- No gradients.
- No rounded pill-heavy dashboard.
- No cards inside cards.
- No explanatory text beyond labels/readouts.
- App should fit one desktop viewport without scrolling.
- On narrow windows, stack model then charts.
- Value cards from the current UI should remain present but become plain compact readout cells with thin borders.

Required live UI elements:

- Status readout equivalent to the current `Live`, `Simulated`, `Disconnected`, `Error`, or `Initializing` header status. The new firmware path does not need simulator UI, but status text must still show whether data is live/searching/error.
- 3D model view equivalent to the current `3D` panel, including the current update-rate text if available.
- Accelerometer live chart equivalent to the current `Accelerometer` / `Accelerometer 8kHz` chart, showing X, Y, and Z.
- FFT live chart equivalent to the current `FFT` chart, showing the combined spectrum from the preserved Python-prototype peak logic.
- Frequency value card equivalent to the current `Frequency` card, with `Axis` and `Freq`.
- Sensors value card equivalent to the current `Sensors` card, with `Ax`, `Ay`, and `Az`.

Canvas chart requirements:

- Use fixed-size typed arrays or reused arrays.
- Draw axes, labels, and lines manually.
- Acceleration chart draws X, Y, Z over a fixed recent window.
- FFT chart draws combined dB from `-120` to `0` dB and `0` to `1000 Hz`.
- Redraw using `requestAnimationFrame`, consuming the latest snapshot refs.
- Do not put raw sample arrays into reactive state.

3D model:

- Load `public/Buffer_threads.glb`.
- Keep the simple lighting/camera/orbit behavior from the current app, but with less code.
- Use a fallback box/cylinder only if the GLB fails.
- Preserve model rotation mapping exactly.

## Files And Migration

Make the repo buildable as the new app. It is acceptable to remove or orphan the old Electron-specific source if the new Tauri build no longer uses it, but keep changes focused.

Expected package changes:

- Remove Electron, React, Chart.js, and related test dependencies if unused.
- Keep `vite`, `typescript`, and `three`.
- Add Tauri frontend/backend setup.
- Add Rust config under `src-tauri`.

Do not delete `public/Buffer_threads.glb`, `public/Buffer.glb`, `public/Buffer.3MF`, `public/AP.ico`, or this prompt file.

Update README only if needed to run the new app.

## Tests

Add or preserve tests for the behavior that matters:

Parser tests:

- Valid 304-byte frame decodes 50 samples.
- Noise before sync is ignored.
- Partial frame waits for more bytes.
- Bad/missing sync triggers resync.
- Signed little-endian values decode correctly.
- `gpm2` scaling uses `raw / 16384`.
- Sequence gaps are counted.

DSP tests:

- Hann window generation.
- DC removal.
- Amplitude scaling.
- Combined-spectrum peak detection.
- Ignore bins below 1 Hz.
- Below `-70 dB` reports `0 Hz`.
- Dominant axis is selected from amplitude at the peak bin.

Orientation tests:

- Orientation mapping matches the formulas above.
- Euler order remains `ZYX`.

Performance sanity:

- Simulate at least several seconds of 8 kHz samples.
- Confirm memory does not grow with sample count.
- Confirm frontend event rate is bounded and not per-sample.

## Verification Commands

Run the relevant checks before final response:

```powershell
npm install
npm run build
npm test
```

If the new project uses different Tauri commands, update `package.json` scripts so these commands work or clearly document the replacement in README.

## Acceptance Criteria

The work is complete when:

- The app builds and launches as a Tauri desktop app.
- It automatically connects to the current firmware stream without serial commands.
- It parses 304-byte frames at 921600 baud and handles resyncs safely.
- Live charts update smoothly from bounded snapshots.
- FFT/peak behavior matches the Python prototype.
- The 3D model uses the existing GLB and preserved orientation mapping.
- The UI is visually minimal but still contains all current live charts and all current value-card readouts.
- Memory stays bounded during long-running streams.
- Tests cover parser, DSP, and orientation behavior.

Keep the implementation small and direct. Prefer simple structs, fixed arrays, and explicit loops over abstractions. Do not add functionality beyond this prompt.

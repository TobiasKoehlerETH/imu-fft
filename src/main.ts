import { invoke } from "@tauri-apps/api/core";
import { listen } from "@tauri-apps/api/event";
import { ModelSnapshot, ModelView } from "./model";
import "./style.css";

type StatusSnapshot = {
  state: "live" | "searching" | "simulated" | "error";
  detail: string;
  sampleRateHz: number;
  frameRateHz: number;
  sequenceGaps: number;
  resyncs: number;
};

type AccelSnapshot = {
  samples: number[];
};

type FftSnapshot = {
  freqs: number[];
  combinedDb: number[];
  peakHz: number;
  peakAxis: "x" | "y" | "z";
};

const els = {
  statusDot: requireElement("status-dot"),
  statusText: requireElement("status-text"),
  detailText: requireElement("detail-text"),
  peakValue: requireElement("peak-value"),
  peakAxis: requireElement("peak-axis"),
  headAx: requireElement("head-ax"),
  headAy: requireElement("head-ay"),
  headAz: requireElement("head-az"),
  freqReadout: requireElement("freq-readout"),
  axisReadout: requireElement("axis-readout"),
  sensorReadout: requireElement("sensor-readout"),
  rateReadout: requireElement("rate-readout"),
  healthReadout: requireElement("health-readout"),
  modelRate: requireElement("model-rate"),
  modelView: requireElement("model-view"),
  accelCanvas: requireCanvas("accel-canvas"),
  fftCanvas: requireCanvas("fft-canvas"),
};

let latestAccel: AccelSnapshot = { samples: [] };
let latestFft: FftSnapshot = { freqs: [], combinedDb: [], peakHz: 0, peakAxis: "x" };
let latestModel: ModelSnapshot = { ax: 0, ay: 0, az: 0, roll: 0, pitch: 0, yaw: 0 };

const model = new ModelView(els.modelView, (rate) => {
  els.modelRate.textContent = `${rate.toFixed(0)} Hz`;
});

void listen<StatusSnapshot>("status", (event) => applyStatus(event.payload));
void listen<AccelSnapshot>("accel", (event) => {
  latestAccel = event.payload;
});
void listen<FftSnapshot>("fft", (event) => {
  latestFft = event.payload;
  applyFftReadouts(latestFft);
});
void listen<ModelSnapshot>("model", (event) => {
  latestModel = event.payload;
  model.applySnapshot(latestModel);
  applySensorReadouts(latestModel);
});

void invoke("start_stream").catch((error) => {
  applyStatus({
    state: "error",
    detail: String(error),
    sampleRateHz: 8000,
    frameRateHz: 160,
    sequenceGaps: 0,
    resyncs: 0,
  });
});

requestAnimationFrame(drawLoop);

function requireElement(id: string): HTMLElement {
  const element = document.getElementById(id);
  if (!element) {
    throw new Error(`Missing element: ${id}`);
  }
  return element;
}

function requireCanvas(id: string): HTMLCanvasElement {
  const element = requireElement(id);
  if (!(element instanceof HTMLCanvasElement)) {
    throw new Error(`Element is not a canvas: ${id}`);
  }
  return element;
}

function applyStatus(snapshot: StatusSnapshot): void {
  els.statusDot.className = `status-dot ${snapshot.state}`;
  els.statusText.textContent = snapshot.state[0].toUpperCase() + snapshot.state.slice(1);
  els.detailText.textContent = snapshot.detail;
  els.rateReadout.textContent = `${snapshot.sampleRateHz.toFixed(0)} sa/s`;
  els.healthReadout.textContent = `${snapshot.sequenceGaps} gaps, ${snapshot.resyncs} resyncs`;
}

function applyFftReadouts(snapshot: FftSnapshot): void {
  const axis = snapshot.peakAxis.toUpperCase();
  const freq = `${snapshot.peakHz.toFixed(2)} Hz`;
  els.peakValue.textContent = freq;
  els.peakAxis.textContent = axis;
  els.freqReadout.textContent = freq;
  els.axisReadout.textContent = `Axis ${axis}`;
}

function applySensorReadouts(snapshot: ModelSnapshot): void {
  els.headAx.textContent = snapshot.ax.toFixed(3);
  els.headAy.textContent = snapshot.ay.toFixed(3);
  els.headAz.textContent = snapshot.az.toFixed(3);
  els.sensorReadout.textContent =
    `${snapshot.ax.toFixed(3)} / ${snapshot.ay.toFixed(3)} / ${snapshot.az.toFixed(3)} g`;
}

function drawLoop(): void {
  drawAccel(els.accelCanvas, latestAccel.samples);
  drawFft(els.fftCanvas, latestFft.freqs, latestFft.combinedDb);
  requestAnimationFrame(drawLoop);
}

function resizeCanvas(canvas: HTMLCanvasElement): CanvasRenderingContext2D {
  const rect = canvas.getBoundingClientRect();
  const scale = Math.min(window.devicePixelRatio || 1, 2);
  const width = Math.max(1, Math.floor(rect.width * scale));
  const height = Math.max(1, Math.floor(rect.height * scale));
  if (canvas.width !== width || canvas.height !== height) {
    canvas.width = width;
    canvas.height = height;
  }
  const ctx = canvas.getContext("2d");
  if (!ctx) {
    throw new Error("Canvas 2D context unavailable");
  }
  ctx.setTransform(scale, 0, 0, scale, 0, 0);
  return ctx;
}

function drawAccel(canvas: HTMLCanvasElement, samples: number[]): void {
  const ctx = resizeCanvas(canvas);
  const width = canvas.clientWidth;
  const height = canvas.clientHeight;
  clearChart(ctx, width, height);
  drawGrid(ctx, width, height, "-2g", "2g");

  if (samples.length < 6) {
    return;
  }

  const count = Math.floor(samples.length / 3);
  drawSeries(ctx, width, height, count, (i) => samples[i * 3], -2, 2, "#111111");
  drawSeries(ctx, width, height, count, (i) => samples[i * 3 + 1], -2, 2, "#2563eb");
  drawSeries(ctx, width, height, count, (i) => samples[i * 3 + 2], -2, 2, "#b91c1c");
  drawLegend(ctx, [["X", "#111111"], ["Y", "#2563eb"], ["Z", "#b91c1c"]]);
}

function drawFft(canvas: HTMLCanvasElement, freqs: number[], db: number[]): void {
  const ctx = resizeCanvas(canvas);
  const width = canvas.clientWidth;
  const height = canvas.clientHeight;
  clearChart(ctx, width, height);
  drawGrid(ctx, width, height, "-120 dB", "0 dB");

  if (freqs.length < 2 || db.length < 2) {
    return;
  }

  ctx.beginPath();
  for (let i = 0; i < Math.min(freqs.length, db.length); i += 1) {
    const x = 34 + (Math.min(freqs[i], 1000) / 1000) * (width - 48);
    const y = 12 + ((0 - clamp(db[i], -120, 0)) / 120) * (height - 34);
    if (i === 0) {
      ctx.moveTo(x, y);
    } else {
      ctx.lineTo(x, y);
    }
  }
  ctx.strokeStyle = "#111111";
  ctx.lineWidth = 1.4;
  ctx.stroke();
  drawLegend(ctx, [["Combined", "#111111"]]);
}

function clearChart(ctx: CanvasRenderingContext2D, width: number, height: number): void {
  ctx.clearRect(0, 0, width, height);
  ctx.fillStyle = "#ffffff";
  ctx.fillRect(0, 0, width, height);
}

function drawGrid(ctx: CanvasRenderingContext2D, width: number, height: number, minLabel: string, maxLabel: string): void {
  const left = 34;
  const right = width - 14;
  const top = 12;
  const bottom = height - 22;

  ctx.strokeStyle = "#d8d8d8";
  ctx.lineWidth = 1;
  ctx.beginPath();
  for (let i = 0; i <= 4; i += 1) {
    const y = top + (i / 4) * (bottom - top);
    ctx.moveTo(left, y);
    ctx.lineTo(right, y);
  }
  for (let i = 0; i <= 4; i += 1) {
    const x = left + (i / 4) * (right - left);
    ctx.moveTo(x, top);
    ctx.lineTo(x, bottom);
  }
  ctx.stroke();

  ctx.strokeStyle = "#8b8b8b";
  ctx.strokeRect(left, top, right - left, bottom - top);
  ctx.fillStyle = "#555555";
  ctx.font = "11px system-ui, sans-serif";
  ctx.fillText(maxLabel, 6, top + 4);
  ctx.fillText(minLabel, 6, bottom);
}

function drawSeries(
  ctx: CanvasRenderingContext2D,
  width: number,
  height: number,
  count: number,
  getValue: (index: number) => number,
  min: number,
  max: number,
  color: string,
): void {
  const left = 34;
  const top = 12;
  const plotWidth = width - 48;
  const plotHeight = height - 34;

  ctx.beginPath();
  for (let i = 0; i < count; i += 1) {
    const x = left + (i / Math.max(1, count - 1)) * plotWidth;
    const normalized = (clamp(getValue(i), min, max) - min) / (max - min);
    const y = top + (1 - normalized) * plotHeight;
    if (i === 0) {
      ctx.moveTo(x, y);
    } else {
      ctx.lineTo(x, y);
    }
  }
  ctx.strokeStyle = color;
  ctx.lineWidth = 1.15;
  ctx.stroke();
}

function drawLegend(ctx: CanvasRenderingContext2D, items: Array<[string, string]>): void {
  ctx.font = "11px system-ui, sans-serif";
  let x = 42;
  for (const [label, color] of items) {
    ctx.fillStyle = color;
    ctx.fillRect(x, 8, 14, 2);
    ctx.fillText(label, x + 18, 12);
    x += 56;
  }
}

function clamp(value: number, min: number, max: number): number {
  return Math.min(max, Math.max(min, value));
}

import { invoke } from "@tauri-apps/api/core";
import { listen } from "@tauri-apps/api/event";
import { relaunch } from "@tauri-apps/plugin-process";
import { check, type DownloadEvent, type Update } from "@tauri-apps/plugin-updater";
import type { LineSeriesOption } from "echarts/charts";
import { LineChart } from "echarts/charts";
import type {
  GridComponentOption,
  MarkPointComponentOption,
  TooltipComponentOption,
} from "echarts/components";
import { GridComponent, MarkPointComponent, TooltipComponent } from "echarts/components";
import type { ComposeOption, ECharts } from "echarts/core";
import { init, use } from "echarts/core";
import { CanvasRenderer } from "echarts/renderers";
import type { IconNode } from "lucide";
import createElement from "lucide/dist/esm/createElement.mjs";
import Download from "lucide/dist/esm/icons/download.mjs";
import RefreshCcw from "lucide/dist/esm/icons/refresh-ccw.mjs";
import { ModelSnapshot, ModelView } from "./model";
import "./style.css";

use([LineChart, GridComponent, MarkPointComponent, TooltipComponent, CanvasRenderer]);

type LiveChartOption = ComposeOption<
  GridComponentOption | TooltipComponentOption | MarkPointComponentOption | LineSeriesOption
>;

declare global {
  interface Window {
    __TAURI_INTERNALS__?: unknown;
  }
}

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

type AccelAxis = "x" | "y" | "z";
type AxisLabelOption = {
  color: string;
  fontSize: number;
  formatter: (value: number) => string;
};

const accelAxes = ["x", "y", "z"] as const;
const chartAxisTextColor = "#14161a";

const els = {
  statusIndicator: requireElement("status-indicator"),
  statusDot: requireElement("status-dot"),
  peakValue: requireElement("peak-value"),
  peakAxis: requireElement("peak-axis"),
  headAx: requireElement("head-ax"),
  headAy: requireElement("head-ay"),
  headAz: requireElement("head-az"),
  modelRate: requireElement("model-rate"),
  modelView: requireElement("model-view"),
  accelChart: requireElement("accel-chart"),
  fftChart: requireElement("fft-chart"),
  simulationToggle: requireInputElement("simulation-toggle"),
  tareButton: requireElement("tare-button"),
  tareIcon: requireElement("tare-icon"),
  updateNotice: requireElement("update-notice"),
  updateText: requireElement("update-text"),
  updateInstallButton: requireButtonElement("update-install-button"),
  updateInstallIcon: requireElement("update-install-icon"),
  accelLegendItems: Array.from(document.querySelectorAll<HTMLElement>("[data-accel-axis]")),
};

mountIcon(els.tareIcon, RefreshCcw, "button-icon-svg");
mountIcon(els.updateInstallIcon, Download, "button-icon-svg");

els.tareButton.addEventListener("click", () => model.tare());
els.simulationToggle.addEventListener("change", () => {
  setSimulationEnabled(els.simulationToggle.checked);
});
els.updateInstallButton.addEventListener("click", () => {
  void installPendingUpdate();
});

let latestModel: ModelSnapshot = { ax: 0, ay: 0, az: 0, roll: 0, pitch: 0, yaw: 0 };
let pendingStatus: StatusSnapshot | null = null;
let pendingFft: FftSnapshot | null = null;
let pendingSensor: ModelSnapshot | null = null;
let simulationEnabled = false;
let currentStreamState: StatusSnapshot["state"] = "searching";
let pendingUpdate: Update | null = null;
let updateDownloadedBytes = 0;
let updateContentLength: number | null = null;

const model = new ModelView(els.modelView, (rate) => {
  els.modelRate.textContent = `${rate.toFixed(0)} Hz`;
});
let charts: LiveCharts | null = null;

function requireElement(id: string): HTMLElement {
  const element = document.getElementById(id);
  if (!element) {
    throw new Error(`Missing element: ${id}`);
  }
  return element;
}

function requireInputElement(id: string): HTMLInputElement {
  const element = document.getElementById(id);
  if (!(element instanceof HTMLInputElement)) {
    throw new Error(`Missing input element: ${id}`);
  }
  return element;
}

function requireButtonElement(id: string): HTMLButtonElement {
  const element = document.getElementById(id);
  if (!(element instanceof HTMLButtonElement)) {
    throw new Error(`Missing button element: ${id}`);
  }
  return element;
}

function mountIcon(target: HTMLElement, icon: IconNode, className: string): void {
  const svg = createElement(icon, {
    class: className,
    "aria-hidden": "true",
  });
  svg.setAttribute("focusable", "false");
  target.replaceChildren(svg);
}

function applyStatus(snapshot: StatusSnapshot): void {
  const label = getStatusLabel(snapshot.state);
  els.statusIndicator.className = `status-indicator ${snapshot.state}`;
  els.statusIndicator.setAttribute("aria-label", label);
  els.statusIndicator.dataset.tooltip = label;
  els.statusDot.className = `status-dot ${snapshot.state}`;
}

function getStatusLabel(state: StatusSnapshot["state"]): string {
  if (state === "live") {
    return "Connected";
  }
  if (state === "simulated") {
    return "Simulation";
  }
  if (state === "searching") {
    return "No Sensor connected";
  }
  return "Error";
}

function applyFftReadouts(snapshot: FftSnapshot): void {
  els.peakValue.textContent = `${snapshot.peakHz.toFixed(2)} Hz`;
  els.peakAxis.textContent = snapshot.peakAxis.toUpperCase();
}

function applySensorReadouts(snapshot: ModelSnapshot): void {
  els.headAx.textContent = snapshot.ax.toFixed(3);
  els.headAy.textContent = snapshot.ay.toFixed(3);
  els.headAz.textContent = snapshot.az.toFixed(3);
}

function setSimulationEnabled(enabled: boolean): void {
  simulationEnabled = enabled;

  if (window.__TAURI_INTERNALS__) {
    void invoke("set_simulation_enabled", { enabled }).catch((error) => {
      pendingStatus = {
        state: "error",
        detail: String(error),
        sampleRateHz: 8000,
        frameRateHz: 160,
        sequenceGaps: 0,
        resyncs: 0,
      };
    });
  }

  if (!enabled && currentStreamState !== "live") {
    clearDisplayedData();
    pendingStatus = {
      state: "searching",
      detail: "",
      sampleRateHz: 8000,
      frameRateHz: 160,
      sequenceGaps: 0,
      resyncs: 0,
    };
  } else if (enabled && !window.__TAURI_INTERNALS__ && currentStreamState !== "live") {
    pendingStatus = {
      state: "simulated",
      detail: "Browser preview; open the Tauri app for serial streaming",
      sampleRateHz: 8000,
      frameRateHz: 160,
      sequenceGaps: 0,
      resyncs: 0,
    };
  }
}

function startUpdateCheck(): void {
  void check({ timeout: 15000 })
    .then((update) => {
      if (!update) {
        return;
      }

      pendingUpdate = update;
      els.updateNotice.hidden = false;
      els.updateText.textContent = `Update ${update.version} available`;
      els.updateInstallButton.disabled = false;
      setUpdateInstallButtonLabel("Install update");
    })
    .catch((error) => {
      console.warn("Update check failed", error);
    });
}

async function installPendingUpdate(): Promise<void> {
  if (!pendingUpdate) {
    return;
  }

  const update = pendingUpdate;
  pendingUpdate = null;
  updateDownloadedBytes = 0;
  updateContentLength = null;
  els.updateNotice.hidden = false;
  els.updateInstallButton.disabled = true;
  setUpdateInstallButtonLabel("Installing update");
  els.updateText.textContent = `Downloading ${update.version}`;

  try {
    await update.downloadAndInstall((event) => applyUpdateDownloadEvent(event));
    els.updateText.textContent = "Restarting to finish update";
    await relaunch();
  } catch (error) {
    pendingUpdate = update;
    els.updateInstallButton.disabled = false;
    setUpdateInstallButtonLabel("Retry update");
    els.updateText.textContent = `Update failed: ${String(error)}`;
  }
}

function setUpdateInstallButtonLabel(label: string): void {
  els.updateInstallButton.setAttribute("aria-label", label);
  els.updateInstallButton.dataset.tooltip = label;
}

function applyUpdateDownloadEvent(event: DownloadEvent): void {
  if (event.event === "Started") {
    updateDownloadedBytes = 0;
    updateContentLength = event.data.contentLength ?? null;
    els.updateText.textContent = updateContentLength === null
      ? "Downloading update"
      : "Downloading update 0%";
    return;
  }

  if (event.event === "Progress") {
    updateDownloadedBytes += event.data.chunkLength;
    if (updateContentLength === null || updateContentLength <= 0) {
      els.updateText.textContent = `Downloaded ${formatBytes(updateDownloadedBytes)}`;
      return;
    }

    const percent = Math.min(100, Math.round((updateDownloadedBytes / updateContentLength) * 100));
    els.updateText.textContent = `Downloading update ${percent}%`;
    return;
  }

  els.updateText.textContent = "Installing update";
}

function formatBytes(bytes: number): string {
  if (bytes < 1024 * 1024) {
    return `${Math.max(1, Math.round(bytes / 1024))} KB`;
  }
  return `${(bytes / 1024 / 1024).toFixed(1)} MB`;
}

function shouldDisplayData(): boolean {
  return currentStreamState === "live" || (currentStreamState === "simulated" && simulationEnabled);
}

function clearDisplayedData(): void {
  charts?.updateAccel([]);
  charts?.updateFft([], []);
  latestModel = { ax: 0, ay: 0, az: 0, roll: 0, pitch: 0, yaw: 0 };
  model.applySnapshot(latestModel);
  pendingFft = { freqs: [], combinedDb: [], peakHz: 0, peakAxis: "x" };
  pendingSensor = latestModel;
}

class LiveCharts {
  private readonly accel: ECharts;
  private readonly fft: ECharts;
  private readonly hiddenAccelAxes = new Set<AccelAxis>();
  private latestAccelSamples: number[] = [];

  constructor(accelEl: HTMLElement, fftEl: HTMLElement) {
    this.accel = init(accelEl, null, { renderer: "canvas" });
    this.fft = init(fftEl, null, { renderer: "canvas" });

    this.accel.setOption(createBaseOption({
      unit: "g",
      showXAxisLabels: true,
      xAxisName: "Sample",
      yAxisName: "Acceleration (g)",
    }));
    this.fft.setOption(createBaseOption({
      unit: "dB",
      showXAxisLabels: true,
      xAxisName: "Frequency (Hz)",
      yAxisName: "Magnitude (dB)",
    }));
    this.updateAccel([]);
    this.updateFft([], []);

    const resizeObserver = new ResizeObserver(() => {
      this.accel.resize();
      this.fft.resize();
    });
    resizeObserver.observe(accelEl);
    resizeObserver.observe(fftEl);
    window.addEventListener("resize", () => {
      this.accel.resize();
      this.fft.resize();
    });
  }

  isAccelAxisVisible(axis: AccelAxis): boolean {
    return !this.hiddenAccelAxes.has(axis);
  }

  setAccelAxisVisible(axis: AccelAxis, visible: boolean): void {
    if (visible) {
      this.hiddenAccelAxes.delete(axis);
    } else {
      this.hiddenAccelAxes.add(axis);
    }
    this.updateAccel(this.latestAccelSamples);
  }

  updateAccel(samples: number[]): void {
    this.latestAccelSamples = samples;
    const count = Math.floor(samples.length / 3);
    const xData: Array<[number, number]> = [];
    const yData: Array<[number, number]> = [];
    const zData: Array<[number, number]> = [];
    const visibleValues: number[] = [];

    for (let i = 0; i < count; i += 1) {
      const x = samples[i * 3];
      const y = samples[i * 3 + 1];
      const z = samples[i * 3 + 2];

      xData.push([i, x]);
      yData.push([i, y]);
      zData.push([i, z]);

      if (this.isAccelAxisVisible("x") && Number.isFinite(x)) {
        visibleValues.push(x);
      }
      if (this.isAccelAxisVisible("y") && Number.isFinite(y)) {
        visibleValues.push(y);
      }
      if (this.isAccelAxisVisible("z") && Number.isFinite(z)) {
        visibleValues.push(z);
      }
    }

    this.accel.setOption(
      {
        xAxis: { min: 0, max: Math.max(1, count - 1) },
        yAxis: createAutoYAxis(visibleValues, "g"),
        series: [
          createLineSeries("X", this.isAccelAxisVisible("x") ? xData : [], "#e11d74"),
          createLineSeries("Y", this.isAccelAxisVisible("y") ? yData : [], "#7c3aed"),
          createLineSeries("Z", this.isAccelAxisVisible("z") ? zData : [], "#0ea5a4"),
        ],
      },
      { lazyUpdate: true, silent: true },
    );
  }

  updateFft(freqs: number[], db: number[]): void {
    const data: Array<[number, number]> = [];
    const count = Math.min(freqs.length, db.length);
    let peak: [number, number] | null = null;

    for (let i = 0; i < count; i += 1) {
      const freq = freqs[i];
      const value = db[i];
      if (Number.isFinite(freq) && Number.isFinite(value) && freq <= 1000) {
        data.push([freq, value]);
        if (peak === null || value > peak[1]) {
          peak = [freq, value];
        }
      }
    }

    this.fft.setOption(
      {
        yAxis: createAutoYAxis(data.map(([, value]) => value), "dB"),
        series: [createFftSeries(data, peak)],
      },
      { lazyUpdate: true, silent: true },
    );
  }
}

function setupAccelLegend(chartSet: LiveCharts): void {
  for (const item of els.accelLegendItems) {
    const axis = item.dataset.accelAxis;
    if (!isAccelAxis(axis)) {
      continue;
    }

    item.addEventListener("click", () => {
      const visible = !chartSet.isAccelAxisVisible(axis);
      chartSet.setAccelAxisVisible(axis, visible);
      item.classList.toggle("is-hidden", !visible);
      item.setAttribute("aria-pressed", String(visible));
    });
  }
}

function isAccelAxis(value: string | undefined): value is AccelAxis {
  return accelAxes.some((axis) => axis === value);
}

function createFftSeries(
  data: Array<[number, number]>,
  peak: [number, number] | null,
): LineSeriesOption {
  const series = createLineSeries("Combined", data, "#14161a");
  if (peak !== null && peak[0] > 0 && peak[1] > -119) {
    series.markPoint = {
      symbol: "circle",
      symbolSize: 16,
      itemStyle: { color: "#dc2626", borderColor: "#ffffff", borderWidth: 2 },
      label: { show: false },
      data: [{ name: "peak", coord: peak }],
    };
  }
  return series;
}

function createBaseOption({
  yMin,
  yMax,
  unit,
  showXAxisLabels,
  xAxisName,
  yAxisName,
}: {
  yMin?: number;
  yMax?: number;
  unit: string;
  showXAxisLabels: boolean;
  xAxisName: string;
  yAxisName: string;
}): LiveChartOption {
  const axisNameStyle = {
    color: chartAxisTextColor,
    fontSize: 11,
    fontWeight: 600 as const,
  };
  return {
    animation: false,
    backgroundColor: "hsl(0 0% 100%)",
    color: ["hsl(346 77% 49%)", "hsl(262 83% 58%)", "hsl(181 75% 35%)"],
    grid: {
      left: 76,
      right: 16,
      top: 16,
      bottom: 38,
      containLabel: true,
    },
    tooltip: {
      trigger: "axis",
      confine: true,
      transitionDuration: 0,
      axisPointer: {
        type: "line",
        lineStyle: { color: "hsl(240 3.8% 46.1%)", width: 1 },
      },
      backgroundColor: "hsl(0 0% 100%)",
      borderColor: "hsl(240 5.9% 90%)",
      textStyle: { color: "hsl(240 10% 3.9%)" },
      valueFormatter: (value) => typeof value === "number" ? `${value.toFixed(2)} ${unit}` : String(value),
    },
    xAxis: {
      type: "value",
      min: 0,
      max: showXAxisLabels ? 1000 : 1,
      name: xAxisName,
      nameLocation: "middle",
      nameGap: 24,
      nameTextStyle: axisNameStyle,
      axisLabel: {
        show: showXAxisLabels,
        color: chartAxisTextColor,
        fontSize: 11,
      },
      axisLine: { lineStyle: { color: "hsl(240 5.9% 90%)" } },
      axisTick: { show: showXAxisLabels, lineStyle: { color: "hsl(240 5.9% 90%)" } },
      splitLine: { lineStyle: { color: "hsl(240 5.9% 90%)" } },
    },
    yAxis: {
      type: "value",
      min: yMin,
      max: yMax,
      scale: yMin === undefined || yMax === undefined,
      name: yAxisName,
      nameLocation: "middle",
      nameGap: 56,
      nameTextStyle: axisNameStyle,
      axisLabel: {
        color: chartAxisTextColor,
        fontSize: 11,
        formatter: (value: number) => `${value}${unit === "g" ? "g" : ""}`,
      },
      axisLine: { show: true, lineStyle: { color: "hsl(240 5.9% 90%)" } },
      axisTick: { show: true, lineStyle: { color: "hsl(240 5.9% 90%)" } },
      splitLine: { lineStyle: { color: "hsl(240 5.9% 90%)" } },
    },
    series: [],
  };
}

function createAutoYAxis(values: number[], unit: string): LiveChartOption["yAxis"] {
  if (values.length === 0) {
    const emptyRange = unit === "g" ? { min: -2, max: 2 } : { min: -120, max: 0 };
    return {
      ...emptyRange,
      scale: true,
      axisLabel: createYAxisLabel(unit),
    };
  }

  let min = Math.min(...values);
  let max = Math.max(...values);

  if (min === max) {
    const padding = unit === "g" ? Math.max(0.01, Math.abs(min) * 0.02) : Math.max(1, Math.abs(min) * 0.05);
    min -= padding;
    max += padding;
  } else {
    const span = max - min;
    const padding = unit === "g" ? Math.max(0.005, span * 0.25) : span * 0.08;
    min -= padding;
    max += padding;
  }

  return {
    min,
    max,
    scale: true,
    axisLabel: createYAxisLabel(unit),
  };
}

function createYAxisLabel(unit: string): AxisLabelOption {
  return {
    color: chartAxisTextColor,
    fontSize: 11,
    formatter: (value: number) => unit === "g" ? `${value.toFixed(2)}g` : `${value.toFixed(0)}${unit}`,
  };
}

function createLineSeries(name: string, data: Array<[number, number]>, color: string): LineSeriesOption {
  return {
    name,
    type: "line",
    data,
    showSymbol: false,
    sampling: "lttb",
    lineStyle: {
      color,
      width: name === "Combined" ? 1.4 : 1.25,
    },
    itemStyle: { color },
    emphasis: { disabled: true },
  };
}

function startTauriStream(): void {
  void listen<StatusSnapshot>("status", (event) => {
    currentStreamState = event.payload.state;
    pendingStatus = normalizeStatus(event.payload);
    if (!shouldDisplayData()) {
      clearDisplayedData();
    }
  });
  void listen<AccelSnapshot>("accel", (event) => {
    if (!shouldDisplayData()) {
      return;
    }
    charts?.updateAccel(event.payload.samples);
  });
  void listen<FftSnapshot>("fft", (event) => {
    if (!shouldDisplayData()) {
      return;
    }
    charts?.updateFft(event.payload.freqs, event.payload.combinedDb);
    pendingFft = event.payload;
  });
  void listen<ModelSnapshot>("model", (event) => {
    if (!shouldDisplayData()) {
      return;
    }
    latestModel = event.payload;
    model.applySnapshot(latestModel);
    pendingSensor = latestModel;
  });

  void invoke("start_stream").catch((error) => {
    pendingStatus = {
      state: "error",
      detail: String(error),
      sampleRateHz: 8000,
      frameRateHz: 160,
      sequenceGaps: 0,
      resyncs: 0,
    };
  });
}

function normalizeStatus(snapshot: StatusSnapshot): StatusSnapshot {
  if (snapshot.state !== "simulated" || simulationEnabled) {
    return snapshot;
  }

  return {
    ...snapshot,
    state: "searching",
    detail: "",
  };
}

function startBrowserPreview(): void {
  pendingStatus = {
    state: "searching",
    detail: "",
    sampleRateHz: 8000,
    frameRateHz: 160,
    sequenceGaps: 0,
    resyncs: 0,
  };

  let sampleIndex = 0;
  window.setInterval(() => {
    currentStreamState = simulationEnabled ? "simulated" : "searching";
    if (!simulationEnabled) {
      return;
    }

    const samples: number[] = [];
    let latest: [number, number, number] = [0, 0, 1];

    for (let i = 0; i < 1000; i += 1) {
      latest = simulatedSample(sampleIndex + i);
      samples.push(...latest);
    }

    sampleIndex += 80;
    charts?.updateAccel(samples);
    latestModel = createModelSnapshot(latest);
    model.applySnapshot(latestModel);
    pendingSensor = latestModel;
  }, 50);

  window.setInterval(() => {
    if (!simulationEnabled) {
      return;
    }

    const snapshot = simulatedFftSnapshot();
    charts?.updateFft(snapshot.freqs, snapshot.combinedDb);
    pendingFft = snapshot;
  }, 200);
}

function simulatedSample(sampleIndex: number): [number, number, number] {
  const t = sampleIndex / 8000;
  const tau = 2 * Math.PI;
  return [
    simulatedAxisNoise(sampleIndex, 0),
    simulatedAxisNoise(sampleIndex, 1),
    1 + 0.05 * Math.sin(tau * 250 * t) + simulatedAxisNoise(sampleIndex, 2),
  ];
}

function simulatedAxisNoise(sampleIndex: number, axis: number): number {
  let value = Math.imul(sampleIndex >>> 0, 747796405) >>> 0;
  value = (value + Math.imul(axis >>> 0, 2891336453) + 2891336453) >>> 0;
  value = (value ^ (value >>> 16)) >>> 0;
  value = Math.imul(value, 2246822519) >>> 0;
  value = (value ^ (value >>> 13)) >>> 0;
  value = Math.imul(value, 3266489917) >>> 0;
  value = (value ^ (value >>> 16)) >>> 0;
  return ((value / 0xffffffff) * 2 - 1) * 0.001;
}

function simulatedFftSnapshot(): FftSnapshot {
  const freqs: number[] = [];
  const combinedDb: number[] = [];
  const peakHz = 250;

  for (let freq = 0; freq <= 1000; freq += 2) {
    freqs.push(freq);
    combinedDb.push(Math.max(
      -120,
      -100 + 70 * Math.exp(-((freq - peakHz) ** 2) / 18),
    ));
  }

  return { freqs, combinedDb, peakHz, peakAxis: "z" };
}

function createModelSnapshot([ax, ay, az]: [number, number, number]): ModelSnapshot {
  const roll = Math.atan2(ax, Math.sqrt(ay * ay + az * az)) * 180 / Math.PI;
  const yaw = Math.atan2(ay, az) * 180 / Math.PI;
  return { ax, ay, az, roll, pitch: 0, yaw };
}

window.setInterval(() => {
  if (pendingStatus) {
    applyStatus(pendingStatus);
    pendingStatus = null;
  }
  if (pendingFft) {
    applyFftReadouts(pendingFft);
    pendingFft = null;
  }
  if (pendingSensor) {
    applySensorReadouts(pendingSensor);
    pendingSensor = null;
  }
}, 50);

charts = new LiveCharts(els.accelChart, els.fftChart);
setupAccelLegend(charts);

if (window.__TAURI_INTERNALS__) {
  startTauriStream();
  startUpdateCheck();
} else {
  startBrowserPreview();
}

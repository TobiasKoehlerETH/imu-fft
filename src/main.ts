import { invoke } from "@tauri-apps/api/core";
import { listen } from "@tauri-apps/api/event";
import type { LineSeriesOption } from "echarts/charts";
import { LineChart } from "echarts/charts";
import type { GridComponentOption, TooltipComponentOption } from "echarts/components";
import { GridComponent, MarkLineComponent, MarkPointComponent, TooltipComponent } from "echarts/components";
import type { ComposeOption, ECharts } from "echarts/core";
import { init, use } from "echarts/core";
import { CanvasRenderer } from "echarts/renderers";
import { ModelSnapshot, ModelView } from "./model";
import "./style.css";

use([LineChart, GridComponent, MarkLineComponent, MarkPointComponent, TooltipComponent, CanvasRenderer]);

type LiveChartOption = ComposeOption<GridComponentOption | TooltipComponentOption | LineSeriesOption>;

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
  accelChart: requireElement("accel-chart"),
  fftChart: requireElement("fft-chart"),
};

let latestModel: ModelSnapshot = { ax: 0, ay: 0, az: 0, roll: 0, pitch: 0, yaw: 0 };
let pendingStatus: StatusSnapshot | null = null;
let pendingFft: FftSnapshot | null = null;
let pendingSensor: ModelSnapshot | null = null;

const model = new ModelView(els.modelView, (rate) => {
  els.modelRate.textContent = `${rate.toFixed(0)} Hz`;
});
let charts: LiveCharts | null = null;

void listen<StatusSnapshot>("status", (event) => {
  pendingStatus = event.payload;
});
void listen<AccelSnapshot>("accel", (event) => {
  charts?.updateAccel(event.payload.samples);
});
void listen<FftSnapshot>("fft", (event) => {
  charts?.updateFft(event.payload.freqs, event.payload.combinedDb, event.payload.peakHz);
  pendingFft = event.payload;
});
void listen<ModelSnapshot>("model", (event) => {
  latestModel = event.payload;
  model.applySnapshot(latestModel);
  pendingSensor = latestModel;
});

function requireElement(id: string): HTMLElement {
  const element = document.getElementById(id);
  if (!element) {
    throw new Error(`Missing element: ${id}`);
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

class LiveCharts {
  private readonly accel: ECharts;
  private readonly fft: ECharts;

  constructor(accelEl: HTMLElement, fftEl: HTMLElement) {
    this.accel = init(accelEl, null, { renderer: "canvas" });
    this.fft = init(fftEl, null, { renderer: "canvas" });

    this.accel.setOption(createBaseOption({ yMin: -2, yMax: 2, unit: "g", showXAxisLabels: false }));
    this.fft.setOption(createBaseOption({ unit: "dB", showXAxisLabels: true }));
    this.updateAccel([]);
    this.updateFft([], [], 0);

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

  updateAccel(samples: number[]): void {
    const count = Math.floor(samples.length / 3);
    const xData: Array<[number, number]> = [];
    const yData: Array<[number, number]> = [];
    const zData: Array<[number, number]> = [];

    for (let i = 0; i < count; i += 1) {
      xData.push([i, samples[i * 3]]);
      yData.push([i, samples[i * 3 + 1]]);
      zData.push([i, samples[i * 3 + 2]]);
    }

    this.accel.setOption(
      {
        xAxis: { min: 0, max: Math.max(1, count - 1) },
        series: [
          createLineSeries("X", xData, "#e11d74"),
          createLineSeries("Y", yData, "#7c3aed"),
          createLineSeries("Z", zData, "#0ea5a4"),
        ],
      },
      { lazyUpdate: true, silent: true },
    );
  }

  updateFft(freqs: number[], db: number[], peakHz: number): void {
    const data: Array<[number, number]> = [];
    const count = Math.min(freqs.length, db.length);

    for (let i = 0; i < count; i += 1) {
      const freq = freqs[i];
      const value = db[i];
      if (Number.isFinite(freq) && Number.isFinite(value) && freq <= 1000) {
        data.push([freq, value]);
      }
    }

    this.fft.setOption(
      {
        yAxis: createAutoYAxis(data.map(([, value]) => value), "dB"),
        series: [createFftSeries(data, peakHz)],
      },
      { lazyUpdate: true, silent: true },
    );
  }
}

function createFftSeries(data: Array<[number, number]>, peakHz: number): LineSeriesOption {
  const series = createLineSeries("Combined", data, "#14161a");
  const peak = findPeakPoint(data, peakHz);

  if (!peak) {
    return series;
  }

  return {
    ...series,
    markLine: {
      animation: false,
      silent: true,
      symbol: "none",
      data: [{ xAxis: peak[0] }],
      label: {
        show: true,
        formatter: `${peak[0].toFixed(2)} Hz`,
        color: "hsl(240 5.9% 10%)",
        fontSize: 11,
        fontWeight: 600,
        position: "insideEndTop",
        distance: 6,
      },
      lineStyle: {
        color: "hsl(346 77% 49%)",
        type: "dashed",
        width: 1.5,
      },
    },
    markPoint: {
      animation: false,
      silent: true,
      symbol: "circle",
      symbolSize: 8,
      data: [{ name: "Peak", coord: peak }],
      itemStyle: {
        color: "hsl(346 77% 49%)",
        borderColor: "hsl(0 0% 100%)",
        borderWidth: 2,
      },
      label: { show: false },
    },
  };
}

function findPeakPoint(data: Array<[number, number]>, peakHz: number): [number, number] | null {
  if (!Number.isFinite(peakHz) || peakHz <= 0 || data.length === 0) {
    return null;
  }

  let closest = data[0];
  let closestDistance = Math.abs(data[0][0] - peakHz);

  for (let i = 1; i < data.length; i += 1) {
    const distance = Math.abs(data[i][0] - peakHz);
    if (distance < closestDistance) {
      closest = data[i];
      closestDistance = distance;
    }
  }

  return closest[0] <= 1000 ? closest : null;
}

function createBaseOption({
  yMin,
  yMax,
  unit,
  showXAxisLabels,
}: {
  yMin?: number;
  yMax?: number;
  unit: string;
  showXAxisLabels: boolean;
}): LiveChartOption {
  return {
    animation: false,
    backgroundColor: "hsl(0 0% 100%)",
    color: ["hsl(346 77% 49%)", "hsl(262 83% 58%)", "hsl(181 75% 35%)"],
    grid: {
      left: 38,
      right: 14,
      top: 12,
      bottom: showXAxisLabels ? 28 : 18,
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
      axisLabel: {
        show: showXAxisLabels,
        color: "hsl(240 3.8% 46.1%)",
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
      axisLabel: {
        color: "hsl(240 3.8% 46.1%)",
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
    return {
      min: -120,
      max: 0,
      scale: true,
    };
  }

  let min = Math.min(...values);
  let max = Math.max(...values);

  if (min === max) {
    const padding = Math.max(1, Math.abs(min) * 0.05);
    min -= padding;
    max += padding;
  } else {
    const padding = (max - min) * 0.08;
    min -= padding;
    max += padding;
  }

  return {
    min,
    max,
    scale: true,
    axisLabel: {
      color: "hsl(240 3.8% 46.1%)",
      fontSize: 11,
      formatter: (value: number) => `${value.toFixed(0)}${unit}`,
    },
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

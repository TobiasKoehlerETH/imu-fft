use crate::dsp;
use serde::Serialize;
use std::io::{ErrorKind, Read};
use std::sync::{
    atomic::{AtomicBool, Ordering},
    Arc, Mutex,
};
use std::thread::{self, JoinHandle};
use std::time::{Duration, Instant};
use tauri::{AppHandle, Emitter};

pub const BAUD_RATE: u32 = 921_600;
pub const SAMPLES_PER_FRAME: usize = 50;
pub const SAMPLE_BYTES: usize = 6;
pub const FRAME_BYTES: usize = 304;
pub const PAYLOAD_BYTES: usize = FRAME_BYTES - 2;
pub const SAMPLE_RATE_HZ: f32 = 8000.0;
pub const FRAME_RATE_HZ: f32 = 160.0;
pub const GPM2_LSB_PER_G: f32 = 16384.0;
const RING_CAPACITY: usize = dsp::FFT_SIZE * 2;
const ACCEL_SNAPSHOT_SAMPLES: usize = 1000;
const SIMULATED_AXIS_NOISE_G: f32 = 0.001;

#[derive(Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct StatusSnapshot {
    state: String,
    detail: String,
    sample_rate_hz: f32,
    frame_rate_hz: f32,
    sequence_gaps: u64,
    resyncs: u64,
}

#[derive(Clone, Serialize)]
pub struct AccelSnapshot {
    samples: Vec<f32>,
}

#[derive(Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct FftSnapshot {
    freqs: Vec<f32>,
    combined_db: Vec<f32>,
    peak_hz: f32,
    peak_axis: String,
}

#[derive(Clone, Serialize)]
pub struct ModelSnapshot {
    ax: f32,
    ay: f32,
    az: f32,
    roll: f32,
    pitch: f32,
    yaw: f32,
}

#[derive(Clone, Debug)]
pub struct DecodedFrame {
    pub seq: u16,
    pub samples: [[f32; 3]; SAMPLES_PER_FRAME],
}

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
enum ParserState {
    Sync0,
    Sync1,
    Payload,
}

/// Streaming, allocation-free 8 kHz frame parser.
/// See `README.md` ("8 kHz frame parser") for the design notes.
pub struct FrameParser {
    state: ParserState,
    payload: [u8; PAYLOAD_BYTES],
    payload_idx: usize,
    previous_seq: Option<u16>,
    sequence_gaps: u64,
    resyncs: u64,
}

impl FrameParser {
    pub fn new() -> Self {
        Self {
            state: ParserState::Sync0,
            payload: [0; PAYLOAD_BYTES],
            payload_idx: 0,
            previous_seq: None,
            sequence_gaps: 0,
            resyncs: 0,
        }
    }

    pub fn feed(&mut self, byte: u8) -> Option<DecodedFrame> {
        match self.state {
            ParserState::Sync0 => {
                if byte == 0xAA {
                    self.state = ParserState::Sync1;
                } else {
                    self.resyncs = self.resyncs.saturating_add(1);
                }
                None
            }
            ParserState::Sync1 => {
                if byte == 0x55 {
                    self.payload_idx = 0;
                    self.state = ParserState::Payload;
                } else {
                    self.resyncs = self.resyncs.saturating_add(1);
                    self.state = if byte == 0xAA {
                        ParserState::Sync1
                    } else {
                        ParserState::Sync0
                    };
                }
                None
            }
            ParserState::Payload => {
                self.payload[self.payload_idx] = byte;
                self.payload_idx += 1;

                if self.payload_idx < PAYLOAD_BYTES {
                    return None;
                }

                self.state = ParserState::Sync0;
                self.payload_idx = 0;
                Some(self.decode_payload())
            }
        }
    }

    pub fn sequence_gaps(&self) -> u64 {
        self.sequence_gaps
    }

    pub fn resyncs(&self) -> u64 {
        self.resyncs
    }

    fn decode_payload(&mut self) -> DecodedFrame {
        let seq = u16::from_le_bytes([self.payload[0], self.payload[1]]);
        if let Some(previous) = self.previous_seq {
            let expected = previous.wrapping_add(1);
            if seq != expected {
                let missed = seq.wrapping_sub(expected).max(1) as u64;
                self.sequence_gaps = self.sequence_gaps.saturating_add(missed);
            }
        }
        self.previous_seq = Some(seq);

        let mut samples = [[0.0_f32; 3]; SAMPLES_PER_FRAME];
        for (i, sample) in samples.iter_mut().enumerate() {
            let offset = 2 + i * SAMPLE_BYTES;
            let ax = i16::from_le_bytes([self.payload[offset], self.payload[offset + 1]]);
            let ay = i16::from_le_bytes([self.payload[offset + 2], self.payload[offset + 3]]);
            let az = i16::from_le_bytes([self.payload[offset + 4], self.payload[offset + 5]]);
            *sample = [
                ax as f32 / GPM2_LSB_PER_G,
                ay as f32 / GPM2_LSB_PER_G,
                az as f32 / GPM2_LSB_PER_G,
            ];
        }

        DecodedFrame { seq, samples }
    }
}

pub fn orientation(ax: f32, ay: f32, az: f32) -> ModelSnapshot {
    let roll = (-ay).atan2(ax.hypot(az)).to_degrees();
    let pitch = 0.0;
    let yaw = (-ax).atan2(az).to_degrees();
    ModelSnapshot {
        ax,
        ay,
        az,
        roll,
        pitch,
        yaw,
    }
}

pub struct SampleRing {
    data: Vec<[f32; 3]>,
    next: usize,
    len: usize,
}

impl SampleRing {
    pub fn new(capacity: usize) -> Self {
        Self {
            data: vec![[0.0; 3]; capacity],
            next: 0,
            len: 0,
        }
    }

    pub fn push(&mut self, sample: [f32; 3]) {
        self.data[self.next] = sample;
        self.next = (self.next + 1) % self.data.len();
        self.len = (self.len + 1).min(self.data.len());
    }

    pub fn len(&self) -> usize {
        self.len
    }

    pub fn capacity(&self) -> usize {
        self.data.len()
    }

    pub fn latest(&self, count: usize) -> Vec<[f32; 3]> {
        let count = count.min(self.len);
        let start = (self.next + self.data.len() - count) % self.data.len();
        (0..count)
            .map(|i| self.data[(start + i) % self.data.len()])
            .collect()
    }
}

struct WorkerState {
    stop: Option<Arc<AtomicBool>>,
    handle: Option<JoinHandle<()>>,
}

pub struct StreamController {
    worker: Mutex<WorkerState>,
}

impl StreamController {
    pub fn new() -> Self {
        Self {
            worker: Mutex::new(WorkerState {
                stop: None,
                handle: None,
            }),
        }
    }

    pub fn start(&self, app: AppHandle) -> Result<(), String> {
        let mut worker = self.worker.lock().map_err(|_| "stream lock poisoned")?;
        if worker
            .handle
            .as_ref()
            .is_some_and(|handle| !handle.is_finished())
        {
            return Ok(());
        }

        let stop = Arc::new(AtomicBool::new(false));
        let thread_stop = stop.clone();
        let handle = thread::spawn(move || run_serial_worker(app, thread_stop));
        worker.stop = Some(stop);
        worker.handle = Some(handle);
        Ok(())
    }

    pub fn stop(&self) -> Result<(), String> {
        let mut worker = self.worker.lock().map_err(|_| "stream lock poisoned")?;
        if let Some(stop) = worker.stop.take() {
            stop.store(true, Ordering::Relaxed);
        }
        if let Some(handle) = worker.handle.take() {
            let _ = handle.join();
        }
        Ok(())
    }
}

fn run_serial_worker(app: AppHandle, stop: Arc<AtomicBool>) {
    let mut sequence_gaps = 0;
    let mut resyncs = 0;

    while !stop.load(Ordering::Relaxed) {
        let ports = match serialport::available_ports() {
            Ok(ports) => ports,
            Err(err) => {
                emit_status(&app, "error", format!("Serial scan failed: {err}"), sequence_gaps, resyncs);
                sleep_or_stop(&stop, Duration::from_secs(1));
                continue;
            }
        };

        let Some(port_info) = ports.first() else {
            run_simulator(&app, &stop, sequence_gaps, resyncs);
            continue;
        };

        let port_name = port_info.port_name.clone();
        let mut port = match serialport::new(&port_name, BAUD_RATE)
            .timeout(Duration::from_millis(20))
            .data_bits(serialport::DataBits::Eight)
            .parity(serialport::Parity::None)
            .stop_bits(serialport::StopBits::One)
            .flow_control(serialport::FlowControl::None)
            .open()
        {
            Ok(port) => port,
            Err(err) => {
                emit_status(
                    &app,
                    "error",
                    format!("Could not open {port_name}: {err}"),
                    sequence_gaps,
                    resyncs,
                );
                sleep_or_stop(&stop, Duration::from_secs(1));
                continue;
            }
        };

        let _ = port.clear(serialport::ClearBuffer::Input);
        emit_status(
            &app,
            "live",
            format!("{port_name} @ {BAUD_RATE} baud"),
            sequence_gaps,
            resyncs,
        );

        let mut parser = FrameParser::new();
        let mut ring = SampleRing::new(RING_CAPACITY);
        let mut latest = [0.0_f32; 3];
        let mut read_buf = [0u8; 4096];
        let mut last_status = Instant::now();
        let mut last_model = Instant::now();
        let mut last_accel = Instant::now();
        let mut last_fft = Instant::now();

        while !stop.load(Ordering::Relaxed) {
            match port.read(&mut read_buf) {
                Ok(bytes_read) => {
                    for byte in &read_buf[..bytes_read] {
                        if let Some(frame) = parser.feed(*byte) {
                            let _seq = frame.seq;
                            for sample in frame.samples {
                                latest = sample;
                                ring.push(sample);
                            }
                        }
                    }
                }
                Err(err) if err.kind() == ErrorKind::TimedOut => {}
                Err(err) => {
                    sequence_gaps = parser.sequence_gaps();
                    resyncs = parser.resyncs();
                    emit_status(
                        &app,
                        "error",
                        format!("{port_name} read failed: {err}"),
                        sequence_gaps,
                        resyncs,
                    );
                    break;
                }
            }

            let now = Instant::now();
            sequence_gaps = parser.sequence_gaps();
            resyncs = parser.resyncs();

            if now.duration_since(last_model) >= Duration::from_millis(16) {
                let _ = app.emit("model", orientation(latest[0], latest[1], latest[2]));
                last_model = now;
            }

            if now.duration_since(last_accel) >= Duration::from_millis(50) {
                emit_accel(&app, &ring);
                last_accel = now;
            }

            if now.duration_since(last_fft) >= Duration::from_millis(200) {
                emit_fft(&app, &ring);
                last_fft = now;
            }

            if now.duration_since(last_status) >= Duration::from_millis(500) {
                emit_status(
                    &app,
                    "live",
                    format!("{port_name} @ {BAUD_RATE} baud"),
                    sequence_gaps,
                    resyncs,
                );
                last_status = now;
            }
        }
    }
}

fn sleep_or_stop(stop: &AtomicBool, duration: Duration) {
    let start = Instant::now();
    while start.elapsed() < duration && !stop.load(Ordering::Relaxed) {
        thread::sleep(Duration::from_millis(25));
    }
}

fn run_simulator(app: &AppHandle, stop: &AtomicBool, sequence_gaps: u64, resyncs: u64) {
    let mut ring = SampleRing::new(RING_CAPACITY);
    let mut sample_index = 0usize;
    let mut latest = [0.0_f32; 3];
    let mut last_status = Instant::now() - Duration::from_secs(1);
    let mut last_model = Instant::now();
    let mut last_accel = Instant::now();
    let mut last_fft = Instant::now();
    let mut last_scan = Instant::now();

    loop {
        if stop.load(Ordering::Relaxed) {
            return;
        }

        if last_scan.elapsed() >= Duration::from_secs(1) {
            if serialport::available_ports()
                .map(|ports| !ports.is_empty())
                .unwrap_or(false)
            {
                return;
            }
            last_scan = Instant::now();
        }

        for _ in 0..80 {
            latest = simulated_sample(sample_index);
            ring.push(latest);
            sample_index = sample_index.wrapping_add(1);
        }

        let now = Instant::now();
        if now.duration_since(last_model) >= Duration::from_millis(16) {
            let _ = app.emit("model", orientation(latest[0], latest[1], latest[2]));
            last_model = now;
        }

        if now.duration_since(last_accel) >= Duration::from_millis(50) {
            emit_accel(app, &ring);
            last_accel = now;
        }

        if now.duration_since(last_fft) >= Duration::from_millis(200) {
            emit_fft(app, &ring);
            last_fft = now;
        }

        if now.duration_since(last_status) >= Duration::from_millis(500) {
            emit_status(
                app,
                "simulated",
                "No serial sensor found; showing simulated data".to_string(),
                sequence_gaps,
                resyncs,
            );
            last_status = now;
        }

        sleep_or_stop(stop, Duration::from_millis(10));
    }
}

fn simulated_sample(sample_index: usize) -> [f32; 3] {
    [
        simulated_axis_noise(sample_index, 0),
        simulated_axis_noise(sample_index, 1),
        simulated_axis_noise(sample_index, 2),
    ]
}

fn simulated_axis_noise(sample_index: usize, axis: u32) -> f32 {
    let mut value = (sample_index as u32)
        .wrapping_mul(747_796_405)
        .wrapping_add(axis.wrapping_mul(2_891_336_453))
        .wrapping_add(2_891_336_453);
    value ^= value >> 16;
    value = value.wrapping_mul(2_246_822_519);
    value ^= value >> 13;
    value = value.wrapping_mul(3_266_489_917);
    value ^= value >> 16;

    let normalized = value as f32 / u32::MAX as f32;
    (normalized * 2.0 - 1.0) * SIMULATED_AXIS_NOISE_G
}

fn emit_status(app: &AppHandle, state: &str, detail: String, sequence_gaps: u64, resyncs: u64) {
    let _ = app.emit(
        "status",
        StatusSnapshot {
            state: state.to_string(),
            detail,
            sample_rate_hz: SAMPLE_RATE_HZ,
            frame_rate_hz: FRAME_RATE_HZ,
            sequence_gaps,
            resyncs,
        },
    );
}

fn emit_accel(app: &AppHandle, ring: &SampleRing) {
    let mut samples = Vec::with_capacity(ACCEL_SNAPSHOT_SAMPLES * 3);
    for sample in ring.latest(ACCEL_SNAPSHOT_SAMPLES) {
        samples.extend_from_slice(&sample);
    }
    let _ = app.emit("accel", AccelSnapshot { samples });
}

fn emit_fft(app: &AppHandle, ring: &SampleRing) {
    if ring.len() < dsp::FFT_SIZE {
        return;
    }

    if let Some(result) = dsp::analyze_fft(&ring.latest(dsp::FFT_SIZE)) {
        let _ = app.emit(
            "fft",
            FftSnapshot {
                freqs: result.freqs,
                combined_db: result.combined_db,
                peak_hz: result.peak_hz,
                peak_axis: result.peak_axis.to_string(),
            },
        );
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    fn frame(seq: u16, sample: (i16, i16, i16)) -> [u8; FRAME_BYTES] {
        let mut bytes = [0u8; FRAME_BYTES];
        bytes[0] = 0xAA;
        bytes[1] = 0x55;
        bytes[2..4].copy_from_slice(&seq.to_le_bytes());
        for i in 0..SAMPLES_PER_FRAME {
            let offset = 4 + i * SAMPLE_BYTES;
            bytes[offset..offset + 2].copy_from_slice(&sample.0.to_le_bytes());
            bytes[offset + 2..offset + 4].copy_from_slice(&sample.1.to_le_bytes());
            bytes[offset + 4..offset + 6].copy_from_slice(&sample.2.to_le_bytes());
        }
        bytes
    }

    #[test]
    fn valid_frame_decodes_fifty_samples() {
        let mut parser = FrameParser::new();
        let mut decoded = None;
        for byte in frame(7, (16384, -16384, 8192)) {
            decoded = parser.feed(byte).or(decoded);
        }
        let decoded = decoded.unwrap();
        assert_eq!(decoded.seq, 7);
        assert_eq!(decoded.samples.len(), SAMPLES_PER_FRAME);
        assert!((decoded.samples[0][0] - 1.0).abs() < 1.0e-6);
        assert!((decoded.samples[0][1] + 1.0).abs() < 1.0e-6);
        assert!((decoded.samples[0][2] - 0.5).abs() < 1.0e-6);
    }

    #[test]
    fn noise_before_sync_is_ignored() {
        let mut parser = FrameParser::new();
        for byte in [1, 2, 3, 0xAA, 0x12] {
            assert!(parser.feed(byte).is_none());
        }
        let mut decoded = None;
        for byte in frame(1, (0, 0, 0)) {
            decoded = parser.feed(byte).or(decoded);
        }
        assert!(decoded.is_some());
        assert!(parser.resyncs() > 0);
    }

    #[test]
    fn partial_frame_waits_for_more_bytes() {
        let mut parser = FrameParser::new();
        let bytes = frame(2, (1, 2, 3));
        for byte in &bytes[..FRAME_BYTES - 1] {
            assert!(parser.feed(*byte).is_none());
        }
        assert!(parser.feed(bytes[FRAME_BYTES - 1]).is_some());
    }

    #[test]
    fn missing_sync_triggers_resync() {
        let mut parser = FrameParser::new();
        for byte in [0xAA, 0x00, 0x10, 0xAA, 0x55] {
            let _ = parser.feed(byte);
        }
        assert!(parser.resyncs() > 0);
    }

    #[test]
    fn signed_little_endian_values_decode() {
        let mut parser = FrameParser::new();
        let mut decoded = None;
        for byte in frame(0, (-2, 3, -4)) {
            decoded = parser.feed(byte).or(decoded);
        }
        let sample = decoded.unwrap().samples[0];
        assert!((sample[0] - (-2.0 / GPM2_LSB_PER_G)).abs() < 1.0e-8);
        assert!((sample[1] - (3.0 / GPM2_LSB_PER_G)).abs() < 1.0e-8);
        assert!((sample[2] - (-4.0 / GPM2_LSB_PER_G)).abs() < 1.0e-8);
    }

    #[test]
    fn sequence_gaps_are_counted() {
        let mut parser = FrameParser::new();
        for byte in frame(0, (0, 0, 0)) {
            let _ = parser.feed(byte);
        }
        for byte in frame(2, (0, 0, 0)) {
            let _ = parser.feed(byte);
        }
        assert_eq!(parser.sequence_gaps(), 1);
    }

    #[test]
    fn orientation_mapping_matches_model_formula() {
        let snapshot = orientation(1.0, -1.0, 1.0);
        let expected_roll = 1.0_f32.atan2(2.0_f32.sqrt()).to_degrees();
        let expected_yaw = (-1.0_f32).atan2(1.0).to_degrees();
        assert!((snapshot.roll - expected_roll).abs() < 1.0e-6);
        assert_eq!(snapshot.pitch, 0.0);
        assert!((snapshot.yaw - expected_yaw).abs() < 1.0e-6);
    }

    #[test]
    fn simulated_axis_noise_stays_within_one_mg() {
        for sample_index in 0..10_000 {
            for axis in 0..3 {
                assert!(simulated_axis_noise(sample_index, axis).abs() <= SIMULATED_AXIS_NOISE_G);
                assert!(simulated_axis_noise(sample_index, axis).abs() <= 0.001);
            }
        }
    }

    #[test]
    fn ring_memory_is_bounded_for_long_streams() {
        let mut ring = SampleRing::new(128);
        for i in 0..(SAMPLE_RATE_HZ as usize * 5) {
            ring.push([i as f32, 0.0, 0.0]);
        }
        assert_eq!(ring.len(), 128);
        assert_eq!(ring.capacity(), 128);
        assert_eq!(ring.latest(500).len(), 128);
    }
}

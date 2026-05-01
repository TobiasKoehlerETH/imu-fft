use rustfft::{num_complex::Complex, FftPlanner};

pub const FFT_SIZE: usize = 8192;
pub const SAMPLE_RATE_HZ: f32 = 8000.0;
pub const MIN_PEAK_HZ: f32 = 1.0;
pub const THRESHOLD_DB: f32 = -70.0;
pub const DISPLAY_MAX_HZ: f32 = 1000.0;

#[derive(Debug, Clone)]
pub struct FftResult {
    pub freqs: Vec<f32>,
    pub combined_db: Vec<f32>,
    pub peak_hz: f32,
    pub peak_axis: &'static str,
}

pub fn hann_window(size: usize) -> Vec<f32> {
    if size <= 1 {
        return vec![1.0; size];
    }

    let denom = (size - 1) as f32;
    (0..size)
        .map(|i| 0.5 * (1.0 - (2.0 * std::f32::consts::PI * i as f32 / denom).cos()))
        .collect()
}

pub fn remove_dc(values: &mut [f32]) {
    if values.is_empty() {
        return;
    }

    let mean = values.iter().sum::<f32>() / values.len() as f32;
    for value in values {
        *value -= mean;
    }
}

pub fn analyze_fft(samples: &[[f32; 3]]) -> Option<FftResult> {
    if samples.len() < FFT_SIZE {
        return None;
    }

    let start = samples.len() - FFT_SIZE;
    let window = hann_window(FFT_SIZE);
    let hann_mean = window.iter().sum::<f32>() / FFT_SIZE as f32;
    let bins = FFT_SIZE / 2 + 1;
    let mut planner = FftPlanner::<f32>::new();
    let fft = planner.plan_fft_forward(FFT_SIZE);
    let mut axis_amp = vec![vec![0.0_f32; bins]; 3];

    for axis in 0..3 {
        let mut values: Vec<f32> = samples[start..].iter().map(|s| s[axis]).collect();
        remove_dc(&mut values);

        let mut buffer: Vec<Complex<f32>> = values
            .iter()
            .zip(window.iter())
            .map(|(value, win)| Complex {
                re: value * win,
                im: 0.0,
            })
            .collect();

        fft.process(&mut buffer);

        for bin in 0..bins {
            let magnitude = buffer[bin].norm();
            axis_amp[axis][bin] = (2.0 / FFT_SIZE as f32) * (magnitude / hann_mean);
        }
    }

    let mut freqs = Vec::new();
    let mut combined_db = Vec::new();
    let mut peak_bin = 0usize;
    let mut peak_db = f32::NEG_INFINITY;

    for bin in 0..bins {
        let freq = bin as f32 * SAMPLE_RATE_HZ / FFT_SIZE as f32;
        if freq > DISPLAY_MAX_HZ {
            break;
        }

        let combined_amp =
            ((axis_amp[0][bin].powi(2) + axis_amp[1][bin].powi(2) + axis_amp[2][bin].powi(2))
                / 3.0)
                .sqrt();
        let db = 20.0 * ((combined_amp / 8.0).max(1.0e-12)).log10();

        freqs.push(freq);
        combined_db.push(db);

        if freq >= MIN_PEAK_HZ && db > peak_db {
            peak_db = db;
            peak_bin = bin;
        }
    }

    let peak_hz = if peak_db < THRESHOLD_DB {
        0.0
    } else {
        peak_bin as f32 * SAMPLE_RATE_HZ / FFT_SIZE as f32
    };

    let peak_axis = if peak_hz == 0.0 {
        "x"
    } else {
        let amps = [
            axis_amp[0][peak_bin],
            axis_amp[1][peak_bin],
            axis_amp[2][peak_bin],
        ];
        match amps
            .iter()
            .enumerate()
            .max_by(|a, b| a.1.total_cmp(b.1))
            .map(|(axis, _)| axis)
            .unwrap_or(0)
        {
            1 => "y",
            2 => "z",
            _ => "x",
        }
    };

    Some(FftResult {
        freqs,
        combined_db,
        peak_hz,
        peak_axis,
    })
}

#[cfg(test)]
mod tests {
    use super::*;

    fn sine_samples(freq: f32, axis: usize, amp: f32) -> Vec<[f32; 3]> {
        (0..FFT_SIZE)
            .map(|i| {
                let value =
                    amp * (2.0 * std::f32::consts::PI * freq * i as f32 / SAMPLE_RATE_HZ).sin();
                let mut sample = [0.0; 3];
                sample[axis] = value;
                sample
            })
            .collect()
    }

    #[test]
    fn hann_window_has_expected_shape() {
        let window = hann_window(8);
        assert!((window[0] - 0.0).abs() < 1.0e-6);
        assert!((window[7] - 0.0).abs() < 1.0e-6);
        assert!(window[3] > 0.9);
    }

    #[test]
    fn dc_removal_centers_values() {
        let mut values = [2.0, 4.0, 6.0];
        remove_dc(&mut values);
        assert!(values.iter().sum::<f32>().abs() < 1.0e-6);
    }

    #[test]
    fn fft_detects_combined_peak_and_axis() {
        let samples = sine_samples(125.0, 1, 1.0);
        let result = analyze_fft(&samples).unwrap();
        assert!((result.peak_hz - 125.0).abs() < 1.0);
        assert_eq!(result.peak_axis, "y");
        assert!(
            result
                .combined_db
                .iter()
                .copied()
                .fold(f32::NEG_INFINITY, f32::max)
                > -30.0
        );
    }

    #[test]
    fn fft_ignores_bins_below_one_hz() {
        let samples = sine_samples(SAMPLE_RATE_HZ / FFT_SIZE as f32, 0, 1.0);
        let result = analyze_fft(&samples).unwrap();
        assert!(result.peak_hz >= MIN_PEAK_HZ || result.peak_hz == 0.0);
    }

    #[test]
    fn fft_reports_zero_below_threshold() {
        let samples = sine_samples(60.0, 2, 0.00001);
        let result = analyze_fft(&samples).unwrap();
        assert_eq!(result.peak_hz, 0.0);
    }
}

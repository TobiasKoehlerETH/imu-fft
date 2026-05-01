mod dsp;
mod stream;

use std::sync::Arc;
use stream::StreamController;
use tauri::{AppHandle, State};

struct AppState {
    stream: Arc<StreamController>,
}

#[tauri::command]
fn start_stream(app: AppHandle, state: State<'_, AppState>) -> Result<(), String> {
    state.stream.start(app)
}

#[tauri::command]
fn stop_stream(state: State<'_, AppState>) -> Result<(), String> {
    state.stream.stop()
}

#[tauri::command]
fn set_simulation_enabled(enabled: bool, state: State<'_, AppState>) {
    state.stream.set_simulation_enabled(enabled);
}

fn main() {
    let stream = Arc::new(StreamController::new());
    let startup_stream = stream.clone();

    tauri::Builder::default()
        .manage(AppState { stream })
        .invoke_handler(tauri::generate_handler![
            start_stream,
            stop_stream,
            set_simulation_enabled,
        ])
        .setup(move |app| {
            let _ = startup_stream.start(app.handle().clone());
            Ok(())
        })
        .run(tauri::generate_context!())
        .expect("error while running IMU FFT");
}

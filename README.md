# IMU FFT

Minimal Tauri 2 app for the ICM-42688-P firmware UART stream.

## Run

```powershell
npm install
npm run dev
```

The app opens the first detected serial port at `921600` baud, clears the input buffer, and listens for binary `0xAA 0x55` frames. It does not send serial commands. If no serial port is present, the interface runs on bounded simulated data and keeps checking for a real sensor.

## Verify

```powershell
npm run build
npm test
```

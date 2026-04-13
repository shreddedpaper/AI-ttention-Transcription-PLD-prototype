# AI-ttention: Distributed Classroom Transcription

A system for accurately transcribing classroom discussions using students' personal devices as a distributed microphone array. Each device captures audio independently, and the system determines which device is nearest to the active speaker using signal-to-noise ratio (SNR) ranking, producing a single deduplicated audio stream suitable for downstream speech-to-text processing.

## Motivation

In active classroom discussions, capturing who said what is hard. A single microphone can't cover an entire room reliably, and traditional mic arrays are expensive and inflexible. But every student already has a device with a microphone. This project treats those devices as a distributed, ad-hoc microphone array: when someone speaks, the device closest to them captures the cleanest audio, and the system identifies that device automatically.

The long-term goal is a full pipeline: distributed capture, deduplication, transcription (via ElevenLabs Scribe v2), and speaker attribution, producing a timestamped, speaker-labelled transcript of classroom discussions in near real-time.

## Current State: Audio Capture Prototype

The current build is a working prototype focused on validating the core premise: **can we reliably identify which device is closest to a speaker using SNR-based ranking?**

### How It Works

Each device opens a web page in the browser, grants microphone access, and begins two parallel streams:

**Continuous metrics (every 100ms):** The device computes RMS amplitude from the mic input via the Web Audio API, maintains a rolling adaptive noise floor (10th percentile of the last 30 seconds of readings), and derives an SNR value in dB. This metadata is sent to the server continuously over WebSocket.

**Voice Activity Detection + audio capture:** Silero VAD runs in-browser via ONNX Runtime Web (with an energy-based fallback if ONNX fails to load). When speech is detected, the device buffers audio via MediaRecorder. When speech ends, the audio chunk is sent to the server along with its timestamps.

**Server-side scoring:** When the server receives an audio chunk, it looks at the SNR metadata from *all* connected devices during that chunk's time window. For each 100ms frame, it ranks devices by SNR and awards points (3 for rank 1, 2 for rank 2, 1 for rank 3). The device with the highest cumulative score wins that speech segment. A confidence percentage indicates how dominant the winner was.

**Teacher dashboard:** A monitoring interface shows all connected devices with live SNR bars, VAD indicators, and rankings. A timeline of speech events displays the winner, confidence, and includes audio playback for verification.

### Architecture

```
Student Devices (Browser)                    Server (Node.js)
┌──────────────────────┐                    ┌──────────────────────┐
│ Web Audio API        │   metadata/100ms   │ Device registry      │
│   AnalyserNode (RMS) │ ────────────────>  │ SNR buffer per device│
│   Noise floor est.   │                    │                      │
│   SNR computation    │                    │ On audio chunk:      │
│                      │   audio chunks     │   Score against all  │
│ Silero VAD (ONNX)    │ ────────────────>  │   devices' SNR data  │
│   or Energy VAD      │                    │   Tag winner         │
│                      │                    │                      │
│ MediaRecorder        │   rank updates     │ Broadcast live state │
│   Opus/AAC chunks    │ <────────────────  │   to dashboard       │
└──────────────────────┘                    └──────────────────────┘
                                                     │
                                                     ▼
                                            ┌──────────────────────┐
                                            │ Teacher Dashboard    │
                                            │   Live device grid   │
                                            │   Speech event log   │
                                            │   Audio playback     │
                                            └──────────────────────┘
```

## Setup

Requires Node.js 18+.

```bash
npm install
node server.js
```

The server starts on port 3000 (or `$PORT` if set).

For deployment, any platform that supports Node.js and WebSockets works. The project is tested with Railway. Connect the GitHub repo, deploy, generate a public domain, and devices can connect immediately via HTTPS (required for browser mic access on non-localhost origins).

### Usage

- **Devices:** Open the root URL in Chrome/Safari. Enter a device name, tap Join, and grant mic access.
- **Dashboard:** Open `/dashboard` on a laptop browser to monitor all connected devices and review speech events.

## Technical Notes

**SNR normalisation across hardware:** Each device computes SNR relative to its own adaptive noise floor, making values comparable across different microphone hardware (iPads, MacBooks, Chromebooks) without explicit calibration.

**VAD strategy:** The system attempts to load Silero VAD via `@ricky0123/vad-web` (ONNX Runtime Web). If loading fails, it falls back to a simple energy-based VAD using the SNR threshold. The active mode is displayed on each device's UI.

**No fixed recording intervals:** Devices don't record on a timer. Audio capture is entirely VAD-driven, producing variable-length chunks bounded by natural speech onset and offset. This minimises bandwidth and ensures chunks align with actual utterances.

**Clock alignment:** Devices use their local clocks for timestamps. Apple and most modern devices sync via NTP, so timestamps are sufficiently aligned for the scoring window comparisons. For production use, a server-side clock sync handshake would improve precision.

**Audio format:** MediaRecorder output format is browser-dependent (WebM/Opus on Chrome, MP4/AAC on Safari). Both are supported for playback on the dashboard.

## Planned Pipeline

The full system design (documented separately) extends this prototype with:

- **ElevenLabs Scribe v2** for speech-to-text, with built-in speaker diarisation (up to 32 speakers) and adaptive keyterm prompting using lesson-specific vocabulary
- **Cross-correlation deduplication** for matching overlapping captures across devices at the audio signal level
- **Voice embedding enrolment** for robust speaker identification independent of device proximity
- **Source separation** (e.g. Meta Demucs) for handling simultaneous speakers

## Stack

| Component | Technology |
|---|---|
| Server | Node.js, Express, Socket.io |
| Client audio | Web Audio API, MediaRecorder |
| Voice activity detection | Silero VAD (ONNX Runtime Web) with energy-based fallback |
| Transport | WebSocket (Socket.io) |
| Target STT (planned) | ElevenLabs Scribe v2 |
| Target diarisation (planned) | Scribe v2 built-in + pyannote.audio 4.0 |

## License

MIT


# Classroom Mic

Distributed audio capture prototype for classroom transcription research. Students join on their iPads/devices, the system detects speech, and identifies which device is closest to the speaker using SNR-based ranking.

## What it does

- Each device opens a web page, grants mic access, and starts streaming audio metrics
- Every 100ms, each device computes its signal-to-noise ratio (SNR) and sends it to the server
- An energy-based Voice Activity Detector (VAD) detects when someone is speaking
- When speech ends, the audio chunk is sent to the server with timestamps
- The server scores each chunk against all devices' SNR data during that time window
- The device with the highest SNR score "wins" that speech segment
- The teacher dashboard shows live device rankings and a timeline of speech events with playback

## Quick Start (Deploy to Railway)

This is the recommended approach for the Thursday experiment. No local setup needed.

### Step 1: Push to GitHub

1. Create a GitHub account if you don't have one: https://github.com
2. Create a new repository (e.g., `classroom-mic`)
3. Upload all the files in this project to the repo. You can drag and drop them into the GitHub web interface.

### Step 2: Deploy to Railway

1. Go to https://railway.com and sign up with your GitHub account
2. Click **"New Project"**
3. Click **"Deploy from GitHub Repo"**
4. Select your `classroom-mic` repository
5. Railway auto-detects Node.js and starts deploying
6. Wait ~1-2 minutes for the build to finish
7. Click **"Settings"** > **"Networking"** > **"Generate Domain"** to get a public URL
8. You'll get something like `classroom-mic-production.up.railway.app`

### Step 3: Use It Thursday

- **iPads:** Open `https://your-app.up.railway.app` in Safari. Enter a name (e.g., "iPad 1"), tap Join, allow mic access.
- **Teacher dashboard:** Open `https://your-app.up.railway.app/dashboard` on a laptop browser.

That's it!

## Running Locally (Alternative)

```bash
npm install
node server.js
```

Then open `http://localhost:3000` in your browser. 

**Note:** For iPads to connect to a local server, they need to be on the same network AND the connection must be HTTPS (browsers require HTTPS for mic access on non-localhost origins). The Railway deployment handles HTTPS automatically, which is why it's recommended.

## How the Scoring Works

When a device sends an audio chunk to the server, the server evaluates it:

1. Look at the chunk's time window (e.g., 1.2s to 3.5s)
2. For every 100ms frame in that window, rank ALL devices by their SNR
3. Award points: 3 for rank 1, 2 for rank 2, 1 for rank 3, 0 for everyone else
4. Sum the points across all frames
5. The device with the highest total score wins that speech segment

Confidence = (device's score / maximum possible score) * 100%

A high confidence (>70%) means the device was consistently the loudest throughout the speech segment. Low confidence means the signal was ambiguous (speaker might have been between two devices, or moving).

## Files

```
classroom-mic/
├── package.json          # Dependencies (express + socket.io)
├── server.js             # Node.js server with scoring logic
├── public/
│   ├── index.html        # iPad/device client page
│   └── dashboard.html    # Teacher monitoring dashboard
└── README.md             # This file
```

## Technical Notes

- **VAD:** Uses energy-based voice activity detection (SNR threshold). This works well for controlled experiments. For noisier environments, Silero VAD can be integrated via the `@ricky0123/vad-web` package (the code is structured to make this swap straightforward).
- **Audio format:** Chunks are recorded via MediaRecorder. The format depends on the browser (WebM/Opus on Chrome, MP4/AAC on Safari). Both are supported for playback.
- **Clock sync:** The prototype uses raw device timestamps. Since Apple devices sync via NTP, this is accurate enough for the experiment. For production, add a clock sync handshake.
- **SNR normalization:** Each device computes SNR against its own rolling noise floor (10th percentile of the last 30 seconds). This makes SNR comparable across different hardware. For this experiment with identical iPads, raw amplitude would also work, but SNR is more robust.
- **Scaling:** This prototype handles ~10-15 devices comfortably. The 200ms state broadcast and 100ms metadata streams are lightweight. For 30+ devices, you'd want to batch metadata updates and reduce broadcast frequency.

## Next Steps (After Thursday)

If the experiment shows the SNR ranking approach works:

1. **Add STT:** Send winning audio chunks to ElevenLabs Scribe v2 for transcription
2. **Adaptive keyterms:** Feed lesson-specific vocabulary to Scribe v2's keyterm prompting
3. **Silero VAD:** Swap in neural VAD for better speech boundary detection
4. **Speaker diarization:** Use Scribe v2's built-in diarization or pyannote.audio for voice-based speaker identification
5. **Cross-correlation dedup:** For the full multi-device system, add audio fingerprinting to detect when multiple devices captured the same utterance

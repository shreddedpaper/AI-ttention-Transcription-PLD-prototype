const express = require("express");
const http = require("http");
const { Server } = require("socket.io");
const path = require("path");

const app = express();
const server = http.createServer(app);
const io = new Server(server, {
  maxHttpBufferSize: 5e6, // 5MB max for audio chunks
  cors: { origin: "*" },
});

app.use(express.static(path.join(__dirname, "public")));
app.get("/dashboard", (req, res) => {
  res.sendFile(path.join(__dirname, "public", "dashboard.html"));
});

// ---------------------------------------------------------------------------
// State
// ---------------------------------------------------------------------------

const devices = new Map(); // deviceId -> { name, socketId, metadata[] }
const speechEvents = []; // Array of speech events with audio + scores
const METADATA_BUFFER_SEC = 60;
const METADATA_INTERVAL_MS = 100;
const BUFFER_SIZE = (METADATA_BUFFER_SEC * 1000) / METADATA_INTERVAL_MS;

// Scoring: top-k devices get points per frame
const POINTS = [3, 2, 1]; // rank 1 gets 3, rank 2 gets 2, rank 3 gets 1

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function generateId() {
  return Date.now().toString(36) + Math.random().toString(36).slice(2, 8);
}

// Get the SNR readings for ALL devices at a specific time index
function getSnrSnapshot(time) {
  const snapshot = {};
  for (const [deviceId, device] of devices) {
    // Find the metadata entry closest to the requested time
    let closest = null;
    let closestDiff = Infinity;
    for (const entry of device.metadata) {
      const diff = Math.abs(entry.serverTime - time);
      if (diff < closestDiff) {
        closestDiff = diff;
        closest = entry;
      }
    }
    // Only include if within 150ms of requested time
    if (closest && closestDiff < 150) {
      snapshot[deviceId] = closest.snr;
    }
  }
  return snapshot;
}

// Score a device's audio chunk against all devices during its time window
function scoreChunk(deviceId, startTime, endTime) {
  const frameCount = Math.max(1, Math.round((endTime - startTime) / METADATA_INTERVAL_MS));
  let totalPoints = 0;
  let maxPossible = frameCount * POINTS[0];
  let framesRanked = 0;

  for (let i = 0; i < frameCount; i++) {
    const t = startTime + i * METADATA_INTERVAL_MS;
    const snapshot = getSnrSnapshot(t);
    const deviceIds = Object.keys(snapshot);

    if (deviceIds.length === 0) continue;
    framesRanked++;

    // Rank devices by SNR (highest first)
    deviceIds.sort((a, b) => snapshot[b] - snapshot[a]);

    const rank = deviceIds.indexOf(deviceId);
    if (rank >= 0 && rank < POINTS.length) {
      totalPoints += POINTS[rank];
    }
  }

  if (framesRanked === 0) return { score: 0, confidence: 0, rank: -1 };

  maxPossible = framesRanked * POINTS[0];
  const confidence = Math.round((totalPoints / maxPossible) * 100);

  // Compute average rank
  return { score: totalPoints, confidence, framesRanked };
}

// Find an existing speech event that overlaps the given time window
function findOverlappingEvent(startTime, endTime) {
  const duration = endTime - startTime;
  for (const event of speechEvents) {
    const overlapStart = Math.max(event.startTime, startTime);
    const overlapEnd = Math.min(event.endTime, endTime);
    const overlap = overlapEnd - overlapStart;
    if (overlap > duration * 0.3) return event;
  }
  return null;
}

// ---------------------------------------------------------------------------
// Socket.io
// ---------------------------------------------------------------------------

io.on("connection", (socket) => {
  let deviceId = null;

  // --- Dashboard joins ---
  socket.on("join-dashboard", () => {
    socket.join("dashboard");
    // Send existing events to newly connected dashboard
    for (const event of speechEvents.slice(-50)) {
      broadcastSpeechEvent(event);
    }
    console.log("[dashboard] connected");
  });

  // --- Device joins the session ---
  socket.on("join", (data) => {
    deviceId = generateId();
    devices.set(deviceId, {
      name: data.name,
      socketId: socket.id,
      metadata: [],
      joinedAt: Date.now(),
    });
    socket.join("devices");
    socket.emit("joined", { deviceId });
    broadcastDeviceList();
    console.log(`[+] ${data.name} joined (${deviceId})`);
  });

  // --- Continuous metadata stream (every ~100ms) ---
  socket.on("metadata", (data) => {
    if (!deviceId || !devices.has(deviceId)) return;
    const device = devices.get(deviceId);

    const entry = {
      snr: data.snr || 0,
      rms: data.rms || 0,
      vadActive: data.vadActive || false,
      clientTime: data.timestamp,
      serverTime: Date.now(),
    };

    device.metadata.push(entry);

    // Trim buffer to keep last N entries
    while (device.metadata.length > BUFFER_SIZE) {
      device.metadata.shift();
    }
  });

  // --- Audio chunk from VAD speech end ---
  socket.on("audio-chunk", (data) => {
    if (!deviceId || !devices.has(deviceId)) return;
    const device = devices.get(deviceId);

    const { startTime, endTime, audioBase64, mimeType } = data;

    // Score this chunk
    const { score, confidence } = scoreChunk(deviceId, startTime, endTime);

    const chunkInfo = {
      deviceId,
      deviceName: device.name,
      startTime,
      endTime,
      score,
      confidence,
      audioBase64,
      mimeType,
    };

    // Find or create a speech event
    let event = findOverlappingEvent(startTime, endTime);

    if (event) {
      // Add chunk to existing event
      event.chunks.push(chunkInfo);
      // Expand event time window
      event.startTime = Math.min(event.startTime, startTime);
      event.endTime = Math.max(event.endTime, endTime);
      // Update winner if this chunk scored higher
      if (score > event.winnerScore) {
        event.winnerId = deviceId;
        event.winnerName = device.name;
        event.winnerScore = score;
        event.winnerConfidence = confidence;
        event.winnerAudio = audioBase64;
        event.winnerMimeType = mimeType;
      }
    } else {
      // Create new speech event
      event = {
        id: generateId(),
        startTime,
        endTime,
        chunks: [chunkInfo],
        winnerId: deviceId,
        winnerName: device.name,
        winnerScore: score,
        winnerConfidence: confidence,
        winnerAudio: audioBase64,
        winnerMimeType: mimeType,
        createdAt: Date.now(),
      };
      speechEvents.push(event);
    }

    // Tell the sending device its score
    socket.emit("chunk-scored", {
      score,
      confidence,
      isWinner: event.winnerId === deviceId,
      eventId: event.id,
    });

    // Broadcast event to dashboard
    broadcastSpeechEvent(event);

    console.log(
      `[audio] ${device.name}: ${((endTime - startTime) / 1000).toFixed(1)}s, ` +
      `score=${score}, confidence=${confidence}%, ` +
      `winner=${event.winnerName}`
    );
  });

  // --- Disconnect ---
  socket.on("disconnect", () => {
    if (deviceId && devices.has(deviceId)) {
      const name = devices.get(deviceId).name;
      devices.delete(deviceId);
      broadcastDeviceList();
      console.log(`[-] ${name} disconnected (${deviceId})`);
    }
  });
});

// ---------------------------------------------------------------------------
// Broadcasts
// ---------------------------------------------------------------------------

function broadcastDeviceList() {
  const list = [];
  for (const [id, device] of devices) {
    list.push({ id, name: device.name, joinedAt: device.joinedAt });
  }
  io.emit("device-list", list);
}

function broadcastSpeechEvent(event) {
  // Send event summary (without all audio data from non-winners)
  io.to("dashboard").emit("speech-event", {
    id: event.id,
    startTime: event.startTime,
    endTime: event.endTime,
    winnerId: event.winnerId,
    winnerName: event.winnerName,
    winnerConfidence: event.winnerConfidence,
    winnerAudio: event.winnerAudio,
    winnerMimeType: event.winnerMimeType,
    chunkCount: event.chunks.length,
    chunks: event.chunks.map((c) => ({
      deviceId: c.deviceId,
      deviceName: c.deviceName,
      score: c.score,
      confidence: c.confidence,
    })),
  });
}

// Broadcast live state to dashboard every 200ms
setInterval(() => {
  const state = {};
  for (const [id, device] of devices) {
    const latest = device.metadata[device.metadata.length - 1];
    state[id] = {
      name: device.name,
      snr: latest ? latest.snr : 0,
      rms: latest ? latest.rms : 0,
      vadActive: latest ? latest.vadActive : false,
    };
  }

  // Compute current rankings
  const ranked = Object.entries(state)
    .filter(([_, d]) => d.snr > 0)
    .sort((a, b) => b[1].snr - a[1].snr)
    .map(([id], i) => ({ id, rank: i + 1 }));

  io.to("dashboard").emit("live-state", { devices: state, rankings: ranked });

  // Also tell each device its current rank
  for (const { id, rank } of ranked) {
    const device = devices.get(id);
    if (device) {
      io.to(device.socketId).emit("rank-update", {
        rank,
        total: ranked.length,
        isTop: rank === 1,
      });
    }
  }
}, 200);

// ---------------------------------------------------------------------------
// Start
// ---------------------------------------------------------------------------

const PORT = process.env.PORT || 3000;
server.listen(PORT, () => {
  console.log(`\n  Classroom Mic Server running on port ${PORT}`);
  console.log(`  Client:    http://localhost:${PORT}`);
  console.log(`  Dashboard: http://localhost:${PORT}/dashboard\n`);
});

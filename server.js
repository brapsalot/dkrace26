// ============================================================
//  DK RAP CHAOS SERVER v2
//  Run: npm start (or node server.js)
//  Deploy free to Railway: https://railway.app
// ============================================================

const express  = require('express');
const { WebSocketServer, WebSocket } = require('ws');
const http     = require('http');
const https    = require('https');
const net      = require('net');
const crypto   = require('crypto');
const fs       = require('fs');
const path     = require('path');
const { CrowdControlClient } = require('./cc-client');
const { io: ioClient } = require('socket.io-client');

const app    = express();
const server = http.createServer(app);
const wss    = new WebSocketServer({ server });

app.use(express.json());

// ── Security Headers ─────────────────────────────────────────
// Trust Railway's proxy so req.ip returns the real client IP (for rate limiting only, never exposed)
app.set('trust proxy', 1);

app.use((_req, res, next) => {
  // Prevent clickjacking — only allow our own domain to frame us
  res.setHeader('X-Frame-Options', 'SAMEORIGIN');
  // Prevent MIME sniffing
  res.setHeader('X-Content-Type-Options', 'nosniff');
  // Basic XSS protection
  res.setHeader('X-XSS-Protection', '1; mode=block');
  // Don't leak referrer to external sites
  res.setHeader('Referrer-Policy', 'same-origin');
  // Prevent browser features we don't need
  res.setHeader('Permissions-Policy', 'geolocation=(), camera=(), microphone=()');
  next();
});

// ── Rate Limiting (in-memory, no dependencies) ───────────────
// Each call to rateLimit() creates its own isolated bucket map,
// so /bizhawk/heartbeat traffic doesn't block /trigger or /streamlabs.
function rateLimit(maxPerMinute) {
  const buckets = new Map(); // ip → { count, resetAt }
  // Clean up stale entries every 5 minutes
  setInterval(() => {
    const now = Date.now();
    for (const [ip, entry] of buckets) {
      if (now > entry.resetAt) buckets.delete(ip);
    }
  }, 300000);

  return (req, res, next) => {
    const ip = req.ip || 'unknown';
    const now = Date.now();
    let entry = buckets.get(ip);
    if (!entry || now > entry.resetAt) {
      entry = { count: 0, resetAt: now + 60000 };
      buckets.set(ip, entry);
    }
    entry.count++;
    if (entry.count > maxPerMinute) {
      return res.status(429).json({ error: 'Too many requests' });
    }
    next();
  };
}

app.use(express.static(path.join(__dirname, 'public'), {
  setHeaders: (res, filePath) => {
    if (filePath.endsWith('.html') || filePath.endsWith('.css') || filePath.endsWith('.js')) {
      res.setHeader('Cache-Control', 'no-cache, must-revalidate');
    }
  }
}));

// ── Config ──────────────────────────────────────────────────
const CONFIG_PATH  = path.join(__dirname, 'config.json');
const COUNTER_PATH = path.join(__dirname, 'dk_rap_count.json');

let config;
try {
  config = JSON.parse(fs.readFileSync(CONFIG_PATH, 'utf8'));
} catch {
  config = {
    streamers: [],
    twitchParentDomains: ['localhost'],
    crowdControl: {},
    minDonation: 5,
    takeControlDonationSingle: 1,
    takeControlDonationAll: 3,
    takeControlDurationMs: 30000,
    dkRapDurationMs: 208000
  };
}

const TRIGGER_SECRET = process.env.TRIGGER_SECRET || 'dkrap2024';
const MIN_DONATION   = parseFloat(process.env.MIN_DONATION) || config.minDonation || 5;

// ── Streamer authentication keys ────────────────────────────
function loadStreamerKeys() {
  try {
    if (process.env.STREAMER_KEYS) {
      return new Map(Object.entries(JSON.parse(process.env.STREAMER_KEYS)));
    }
    const keysPath = path.join(__dirname, 'streamer_keys.json');
    return new Map(Object.entries(JSON.parse(fs.readFileSync(keysPath, 'utf8'))));
  } catch {
    return new Map(); // No keys = auth disabled (dev mode)
  }
}
const streamerKeys = loadStreamerKeys();

function validateStreamerKey(name, key) {
  if (streamerKeys.size === 0) return true;  // no keys configured = auth disabled
  return streamerKeys.get(name) === key;
}

// ── State ───────────────────────────────────────────────────
const streamers       = new Map();  // ws → streamer name (Python clients)
const viewers         = new Set();  // ws connections for viewer page
const bizhawkClients  = new Map();  // tcp socket → { name, buffer }
const httpBizhawk     = new Map();  // streamerName → { lastSeen, commandQueue: [] }
const raceProgress    = new Map();  // streamerName → progress data
const controlSessions = new Map();  // streamerName → { sessionId, viewerWs, donorName, expiresAt, timer }
const claimCodes      = new Map();  // code → { ws, target, createdAt }
const pendingClaims   = new Map();  // claimId → { ws, target, donorName, amount, createdAt }
const pianoSessions   = new Map();  // sessionId → { viewerWs, donorName, expiresAt, timer }
let dkRapActive       = false;
let dkRapTimer        = null;
let ccClient          = null;
let ccEffectLog       = [];         // Recent CC effects for viewer catch-up
const CC_LOG_MAX      = 100;

// ── DK Rap Counter ──────────────────────────────────────────
function readCounter() {
  try {
    return JSON.parse(fs.readFileSync(COUNTER_PATH, 'utf8')).count || 0;
  } catch {
    return 0;
  }
}

function incrementCounter() {
  const count = readCounter() + 1;
  fs.writeFileSync(COUNTER_PATH, JSON.stringify({ count }));
  return count;
}

// ── Helpers ─────────────────────────────────────────────────
function streamerNames() {
  return [...streamers.values()];
}

function safeSend(ws, obj) {
  if (ws.readyState === WebSocket.OPEN) ws.send(JSON.stringify(obj));
}

function tcpSend(socket, obj) {
  try {
    socket.write(JSON.stringify(obj) + '\n');
  } catch { /* ignore dead sockets */ }
}

function findBizhawkSocket(name) {
  for (const [socket, info] of bizhawkClients) {
    if (info.name === name) return socket;
  }
  return null;
}

function isBizhawkConnected(name) {
  // Check TCP clients
  if (findBizhawkSocket(name)) return true;
  // Check HTTP clients (considered connected if seen in last 10 seconds)
  const hb = httpBizhawk.get(name);
  return hb && (Date.now() - hb.lastSeen < 10000);
}

function allBizhawkNames() {
  const names = new Set([...bizhawkClients.values()].map(b => b.name));
  for (const [name, hb] of httpBizhawk) {
    if (Date.now() - hb.lastSeen < 10000) names.add(name);
  }
  return [...names];
}

function queueHttpCommand(name, cmd) {
  const hb = httpBizhawk.get(name);
  if (hb) hb.commandQueue.push(cmd);
}

function broadcastStatus() {
  const bizhawkNames = allBizhawkNames();
  const payload = {
    type: 'STATUS',
    streamers: streamerNames(),
    bizhawkConnected: bizhawkNames,
    minDonation: MIN_DONATION,
    takeControlDonationSingle: config.takeControlDonationSingle || 1,
    takeControlDonationAll: config.takeControlDonationAll || 3,
    dkRapCount: readCounter(),
    dkRapActive,
    configStreamers: config.streamers,
    crowdControlConnected: ccClient ? ccClient.getStatus().connected : false,
    crowdControlInteractUrl: ccClient ? ccClient.getInteractUrl() : ''
  };
  wss.clients.forEach(client => safeSend(client, payload));
}

function broadcastStandings() {
  const standings = [...raceProgress.entries()]
    .map(([name, data]) => ({
      name,
      levelName: data.levelName || 'Unknown',
      worldIndex: data.worldIndex || 0,
      levelIndex: data.levelIndex || 0,
      progressIndex: data.progressIndex || 0,
      connected: isBizhawkConnected(name)
    }))
    .sort((a, b) => b.progressIndex - a.progressIndex)
    .map((s, i) => ({ ...s, position: i + 1 }));

  // Add any config streamers not yet reporting progress
  const reportedNames = new Set(standings.map(s => s.name));
  for (const cs of config.streamers) {
    if (!reportedNames.has(cs.name)) {
      standings.push({
        name: cs.name,
        levelName: 'Not started',
        worldIndex: -1,
        levelIndex: -1,
        progressIndex: -1,
        connected: !!findBizhawkSocket(cs.name),
        position: standings.length + 1
      });
    }
  }

  const msg = { type: 'RACE_STANDINGS', standings };
  viewers.forEach(ws => safeSend(ws, msg));
}

function broadcastControlStatus() {
  const sessions = [];
  for (const [key, session] of controlSessions) {
    sessions.push({
      targetStreamer: key,
      controllerName: session.donorName,
      remainingMs: Math.max(0, session.expiresAt - Date.now()),
      active: true,
      isAll: session.isAll || false,
      targets: session.targets || [key]
    });
  }
  const msg = { type: 'CONTROL_ACTIVE', sessions };
  viewers.forEach(ws => safeSend(ws, msg));
}

// ── DK Rap ──────────────────────────────────────────────────
function fireDKRap(donorName, amount) {
  const count = incrementCounter();
  const startTimestamp = Date.now();
  const rap = { type: 'DK_RAP', donorName, amount, timestamp: startTimestamp };

  // Notify all Python streamer clients
  let fired = 0;
  streamers.forEach((name, ws) => {
    safeSend(ws, rap);
    console.log(`  DK Rap fired -> ${name}`);
    fired++;
  });

  // Notify all BizHawk clients to lock out (TCP)
  bizhawkClients.forEach((info, socket) => {
    tcpSend(socket, { type: 'DK_RAP_LOCKOUT', active: true, durationMs: config.dkRapDurationMs || 208000, startTimestamp });
  });
  // Notify HTTP BizHawk clients
  for (const [name, hb] of httpBizhawk) {
    hb.commandQueue.push({ type: 'DK_RAP_LOCKOUT', active: true, durationMs: config.dkRapDurationMs || 208000, startTimestamp });
  }

  // Set DK Rap active state
  dkRapActive = true;
  if (dkRapTimer) clearTimeout(dkRapTimer);
  dkRapTimer = setTimeout(() => {
    dkRapActive = false;
    ruffRapActive = false;
    dkRapTimer = null;
    // Unlock BizHawk clients (TCP)
    bizhawkClients.forEach((info, socket) => {
      tcpSend(socket, { type: 'DK_RAP_LOCKOUT', active: false });
    });
    // Unlock HTTP BizHawk clients
    for (const [name, hb] of httpBizhawk) {
      hb.commandQueue.push({ type: 'DK_RAP_LOCKOUT', active: false });
    }
    broadcastStatus();
  }, config.dkRapDurationMs || 208000);

  // Reset tug-of-war and tetris state for minigame
  ruffRapTowScore = 0;
  ruffRapTowLocked = false;
  ruffRapTetrisLines = 0;
  ruffRapTetrisLineTarget = 40;
  ruffRapTetrisUsers.clear();
  ruffRapActive = true;
  if (ruffRapDecayInterval) { clearInterval(ruffRapDecayInterval); ruffRapDecayInterval = null; }

  // Notify viewer page (includes startTimestamp for OBS audio sync + minigame targets)
  viewers.forEach(ws => safeSend(ws, {
    type: 'TRIGGERED', donorName, amount, dkRapCount: count, startTimestamp,
    durationMs: config.dkRapDurationMs || 208000,
    towTarget: RUFF_RAP_TOW_TARGET, tetrisLineTarget: ruffRapTetrisLineTarget
  }));

  broadcastStatus();
  console.log(`  DK RAP triggered by "${donorName}" ($${amount}) -> ${fired} streamers | Total count: ${count}`);
  return fired;
}

// ── Take Control ────────────────────────────────────────────
function grantControl(viewerWs, targetStreamer, donorName, amount) {
  const isAll = targetStreamer === 'ALL';

  if (dkRapActive) {
    return { error: 'DK Rap is playing! Try again when it ends.' };
  }

  // Check for existing sessions
  if (controlSessions.size > 0) {
    if (isAll || controlSessions.has('__ALL__')) {
      return { error: 'Someone is already controlling streamers!' };
    }
    if (!isAll && controlSessions.has(targetStreamer)) {
      return { error: 'Someone is already controlling this streamer!' };
    }
  }

  if (isAll) {
    // ALL mode: verify all BizHawks connected, min $3
    const minAmount = config.takeControlDonationAll || 3;
    if (amount < minAmount) {
      return { error: `Minimum donation is $${minAmount} to control all streamers` };
    }
    const connected = allBizhawkNames();
    if (connected.length === 0) {
      return { error: 'No BizHawk emulators are connected' };
    }

    const sessionId  = crypto.randomUUID();
    const durationMs = config.takeControlDurationMs || 30000;
    const expiresAt  = Date.now() + durationMs;
    const targets    = connected;

    const timer = setTimeout(() => endControlSession('__ALL__'), durationMs);

    controlSessions.set('__ALL__', {
      sessionId, viewerWs, donorName, expiresAt, timer, isAll: true, targets
    });

    safeSend(viewerWs, {
      type: 'CONTROL_GRANTED',
      targetStreamer: '__ALL__', sessionId, expiresAt, durationMs,
      isAll: true, targets
    });

    broadcastControlStatus();
    console.log(`  CONTROL: ${donorName} took control of ALL (${targets.join(', ')}) for ${durationMs / 1000}s`);
    return { success: true };

  } else {
    // Single mode: min $1
    const minAmount = config.takeControlDonationSingle || 1;
    if (amount < minAmount) {
      return { error: `Minimum donation is $${minAmount}` };
    }
    if (!isBizhawkConnected(targetStreamer)) {
      return { error: `${targetStreamer} has no BizHawk connection` };
    }

    const sessionId  = crypto.randomUUID();
    const durationMs = config.takeControlDurationMs || 30000;
    const expiresAt  = Date.now() + durationMs;
    const targets    = [targetStreamer];

    const timer = setTimeout(() => endControlSession(targetStreamer), durationMs);

    controlSessions.set(targetStreamer, {
      sessionId, viewerWs, donorName, expiresAt, timer, isAll: false, targets
    });

    safeSend(viewerWs, {
      type: 'CONTROL_GRANTED',
      targetStreamer, sessionId, expiresAt, durationMs,
      isAll: false, targets
    });

    broadcastControlStatus();
    console.log(`  CONTROL: ${donorName} took control of ${targetStreamer} for ${durationMs / 1000}s`);
    return { success: true };
  }
}

function endControlSession(sessionKey) {
  const session = controlSessions.get(sessionKey);
  if (!session) return;

  clearTimeout(session.timer);
  controlSessions.delete(sessionKey);

  // Clear inputs on ALL targets
  const targets = session.targets || [sessionKey];
  for (const name of targets) {
    const bhSocket = findBizhawkSocket(name);
    if (bhSocket) {
      tcpSend(bhSocket, { type: 'INJECT_INPUT', buttons: {} });
    }
    queueHttpCommand(name, { type: 'INJECT_INPUT', buttons: {} });
  }

  // Notify the viewer who had control
  safeSend(session.viewerWs, {
    type: 'CONTROL_ENDED', targetStreamer: sessionKey
  });

  broadcastControlStatus();
  console.log(`  CONTROL: Session ended for ${sessionKey}${session.isAll ? ' (ALL)' : ''}`);
}

// ── Piano Sessions ──────────────────────────────────────────
function grantPiano(viewerWs, donorName, amount) {
  const minAmount = config.pianoDonation || 5;
  if (amount < minAmount) {
    return { error: `Minimum donation is $${minAmount} for Piano Time` };
  }

  // Only one piano session at a time
  if (pianoSessions.size > 0) {
    return { error: 'Someone is already playing piano!' };
  }

  const sessionId  = crypto.randomUUID();
  const durationMs = config.pianoDurationMs || 60000;
  const expiresAt  = Date.now() + durationMs;

  const timer = setTimeout(() => endPianoSession(sessionId), durationMs);

  pianoSessions.set(sessionId, {
    sessionId, viewerWs, donorName, expiresAt, timer
  });

  safeSend(viewerWs, {
    type: 'PIANO_GRANTED',
    sessionId, expiresAt, durationMs
  });

  console.log(`  PIANO: ${donorName} started piano session for ${durationMs / 1000}s`);
  return { success: true };
}

function endPianoSession(sessionId) {
  const session = pianoSessions.get(sessionId);
  if (!session) return;

  clearTimeout(session.timer);
  pianoSessions.delete(sessionId);

  safeSend(session.viewerWs, { type: 'PIANO_ENDED' });

  console.log(`  PIANO: Session ended for ${session.donorName}`);
}

// ── WebSocket handling (viewers + Python streamer clients) ───
wss.on('connection', (ws) => {

  ws.on('message', (raw) => {
    try {
      const msg = JSON.parse(raw.toString());

      if (msg.type === 'REGISTER_STREAMER') {
        if (!validateStreamerKey(msg.name, msg.key)) {
          safeSend(ws, { type: 'AUTH_FAILED', error: 'Invalid streamer key' });
          ws.close(4401, 'Invalid streamer key');
          console.log(`  Streamer auth FAILED: ${msg.name}`);
          return;
        }
        streamers.set(ws, msg.name);
        console.log(`  Streamer joined: ${msg.name}`);
        broadcastStatus();

      } else if (msg.type === 'REGISTER_VIEWER') {
        viewers.add(ws);
        safeSend(ws, {
          type: 'STATUS',
          streamers: streamerNames(),
          bizhawkConnected: allBizhawkNames(),
          minDonation: MIN_DONATION,
          takeControlDonationSingle: config.takeControlDonationSingle || 1,
          takeControlDonationAll: config.takeControlDonationAll || 3,
          dkRapCount: readCounter(),
          dkRapActive,
          configStreamers: config.streamers
        });
        broadcastStandings();
        broadcastControlStatus();

        // Send CC status + recent effect history
        if (ccClient) {
          safeSend(ws, { type: 'CC_STATUS', ...ccClient.getStatus() });
          if (ccEffectLog.length > 0) {
            safeSend(ws, { type: 'CC_EFFECT_HISTORY', events: ccEffectLog.slice(-20) });
          }
        }

      } else if (msg.type === 'REQUEST_CONTROL') {
        const result = grantControl(ws, msg.targetStreamer, msg.donorName || 'Anonymous', msg.amount || 0);
        if (result.error) {
          safeSend(ws, { type: 'CONTROL_ERROR', error: result.error });
        }

      } else if (msg.type === 'REQUEST_PIANO') {
        const result = grantPiano(ws, msg.donorName || 'Anonymous', msg.amount || 0);
        if (result.error) {
          safeSend(ws, { type: 'CONTROL_ERROR', error: result.error });
        }

      } else if (msg.type === 'DRAW') {
        // Rate limit: max 30 DRAW messages/second per connection
        if (!ws._drawTimestamps) ws._drawTimestamps = [];
        const now = Date.now();
        ws._drawTimestamps.push(now);
        while (ws._drawTimestamps.length > 0 && ws._drawTimestamps[0] < now - 1000) {
          ws._drawTimestamps.shift();
        }
        if (ws._drawTimestamps.length <= 30) {
          // Relay to all other viewers
          viewers.forEach(v => {
            if (v !== ws) safeSend(v, msg);
          });
        }

      } else if (msg.type === 'ACTIVATE_CONTROL') {
        // Viewer clicked "Activate" after webhook confirmed donation
        const pending = pendingClaims.get(msg.claimId);
        if (!pending || pending.ws !== ws) {
          safeSend(ws, { type: 'CONTROL_ERROR', error: 'Invalid or expired claim' });
        } else {
          pendingClaims.delete(msg.claimId);
          if (pending.target === 'PIANO') {
            const result = grantPiano(ws, pending.donorName, pending.amount);
            if (result.error) {
              safeSend(ws, { type: 'CONTROL_ERROR', error: result.error });
            }
          } else {
            const result = grantControl(ws, pending.target, pending.donorName, pending.amount);
            if (result.error) {
              safeSend(ws, { type: 'CONTROL_ERROR', error: result.error });
            }
          }
        }

      } else if (msg.type === 'REGISTER_CLAIM_CODE') {
        // Remove any previous code for this viewer
        for (const [code, entry] of claimCodes) {
          if (entry.ws === ws) claimCodes.delete(code);
        }
        if (msg.code) {
          claimCodes.set(msg.code.toUpperCase(), {
            ws,
            target: msg.target || 'ALL',
            createdAt: Date.now()
          });
        }

      } else if (msg.type === 'INPUT') {
        // Validate session
        const session = [...controlSessions.values()].find(s => s.sessionId === msg.sessionId);
        if (!session || session.viewerWs !== ws) return;
        if (Date.now() > session.expiresAt) return;

        // Forward to ALL targets in the session
        const targets = session.targets || [];
        for (const name of targets) {
          const bhSocket = findBizhawkSocket(name);
          if (bhSocket) {
            tcpSend(bhSocket, { type: 'INJECT_INPUT', buttons: msg.buttons || {} });
          }
          const httpHb = httpBizhawk.get(name);
          if (httpHb) {
            httpHb.commandQueue = httpHb.commandQueue.filter(c => c.type !== 'INJECT_INPUT');
            httpHb.commandQueue.push({ type: 'INJECT_INPUT', buttons: msg.buttons || {} });
          }
        }

      } else if (msg.type === 'PIANO_NOTE') {
        // Validate piano session exists for this viewer
        const pianoSession = [...pianoSessions.values()].find(s => s.viewerWs === ws);
        if (!pianoSession || Date.now() > pianoSession.expiresAt) return;

        // Broadcast to ALL viewers (including sender, so all hear the sound)
        viewers.forEach(v => {
          if (v !== ws) {
            safeSend(v, { type: 'PIANO_NOTE', note: msg.note, action: msg.action });
          }
        });

      } else if (msg.type === 'RUFF_RAP_SKIP_CLICK') {
        if (!ruffRapActive || ruffRapTowLocked) return;
        // Rate limit: max 10 clicks/sec per viewer
        if (!ws._skipTimestamps) ws._skipTimestamps = [];
        const now = Date.now();
        ws._skipTimestamps = ws._skipTimestamps.filter(t => now - t < 1000);
        if (ws._skipTimestamps.length >= 10) return;
        ws._skipTimestamps.push(now);

        ruffRapTowScore = Math.min(ruffRapTowScore + 1, RUFF_RAP_TOW_TARGET);
        broadcastTowUpdate();

        if (ruffRapTowScore >= RUFF_RAP_TOW_TARGET) {
          skipRuffRap();
        }

      } else if (msg.type === 'RUFF_RAP_KEEP_CLICK') {
        if (!ruffRapActive || ruffRapTowLocked) return;
        if (!ws._keepTimestamps) ws._keepTimestamps = [];
        const now = Date.now();
        ws._keepTimestamps = ws._keepTimestamps.filter(t => now - t < 1000);
        if (ws._keepTimestamps.length >= 10) return;
        ws._keepTimestamps.push(now);

        ruffRapTowScore = Math.max(ruffRapTowScore - 1, -RUFF_RAP_TOW_TARGET);
        broadcastTowUpdate();

        if (ruffRapTowScore <= -RUFF_RAP_TOW_TARGET) {
          // Keep wins — lock the rap, it plays to completion
          ruffRapTowLocked = true;
          viewers.forEach(v => safeSend(v, { type: 'RUFF_RAP_LOCKED' }));
        }

      } else if (msg.type === 'RUFF_RAP_TETRIS_LINES') {
        if (!ruffRapActive) return;
        const cleared = parseInt(msg.lines) || 0;
        if (cleared <= 0 || cleared > 4) return; // max 4 lines at once

        // Track unique users who clear lines — increase target per new user
        const wsId = ws._wsId || (ws._wsId = Math.random().toString(36).slice(2));
        if (!ruffRapTetrisUsers.has(wsId)) {
          ruffRapTetrisUsers.add(wsId);
          ruffRapTetrisLineTarget = 40 + ruffRapTetrisUsers.size * 10;
        }

        ruffRapTetrisLines = Math.min(ruffRapTetrisLines + cleared, ruffRapTetrisLineTarget);

        // Broadcast tetris progress with dynamic target
        viewers.forEach(v => safeSend(v, {
          type: 'RUFF_RAP_TETRIS_UPDATE', lines: ruffRapTetrisLines, target: ruffRapTetrisLineTarget
        }));

        // Check if tetris line target reached
        if (ruffRapTetrisLines >= ruffRapTetrisLineTarget) {
          skipRuffRap();
        }
      } else if (msg.type === 'BINGO_WIN') {
        // Rate limit: 1 bingo win per 5 seconds per viewer
        const now = Date.now();
        if (!ws._lastBingoWin || now - ws._lastBingoWin > 5000) {
          ws._lastBingoWin = now;
          const username = (msg.username || 'Anonymous').slice(0, 20);
          viewers.forEach(v => safeSend(v, { type: 'BINGO_WIN', username }));
          console.log(`  BINGO WIN: ${username}`);
        }

      } else if (msg.type === 'BINGO_NEW_GAME') {
        // Rate limit: 1 new game per 3 seconds
        const now = Date.now();
        if (!ws._lastBingoNew || now - ws._lastBingoNew > 3000) {
          ws._lastBingoNew = now;
          viewers.forEach(v => safeSend(v, { type: 'BINGO_NEW_GAME' }));
          console.log('  BINGO: New game started');
        }
      }
    } catch {
      // ignore malformed messages
    }
  });

  ws.on('close', () => {
    if (streamers.has(ws)) {
      console.log(`  Streamer left: ${streamers.get(ws)}`);
      streamers.delete(ws);
      broadcastStatus();
    }
    viewers.delete(ws);

    // End any control sessions this viewer had
    for (const [sessionKey, session] of [...controlSessions]) {
      if (session.viewerWs === ws) {
        endControlSession(sessionKey);
      }
    }

    // End any piano sessions this viewer had
    for (const [sid, session] of [...pianoSessions]) {
      if (session.viewerWs === ws) {
        endPianoSession(sid);
      }
    }

    // Clean up claim codes and pending claims for this viewer
    for (const [code, entry] of [...claimCodes]) {
      if (entry.ws === ws) claimCodes.delete(code);
    }
    for (const [id, claim] of [...pendingClaims]) {
      if (claim.ws === ws) pendingClaims.delete(id);
    }
  });
});

// ── TCP Server for BizHawk Lua scripts ──────────────────────
const tcpServer = net.createServer((socket) => {
  let buffer = '';
  let streamerName = null;

  socket.on('data', (data) => {
    buffer += data.toString();
    let nl;
    while ((nl = buffer.indexOf('\n')) !== -1) {
      const line = buffer.slice(0, nl).trim();
      buffer = buffer.slice(nl + 1);
      if (!line) continue;

      try {
        const msg = JSON.parse(line);

        if (msg.type === 'REGISTER_BIZHAWK') {
          if (!validateStreamerKey(msg.name, msg.key)) {
            tcpSend(socket, { type: 'AUTH_FAILED', error: 'Invalid streamer key' });
            socket.destroy();
            console.log(`  BizHawk auth FAILED: ${msg.name}`);
            return;
          }
          streamerName = msg.name;
          bizhawkClients.set(socket, { name: msg.name });
          console.log(`  BizHawk connected: ${msg.name}`);
          broadcastStatus();

        } else if (msg.type === 'PROGRESS_UPDATE' && streamerName) {
          raceProgress.set(streamerName, {
            levelId: msg.levelId,
            levelName: msg.levelName,
            worldIndex: msg.worldIndex,
            levelIndex: msg.levelIndex,
            progressIndex: msg.progressIndex,
            exitTaken: msg.exitTaken,
            levelStatus: msg.levelStatus,
            timestamp: msg.timestamp
          });
          broadcastStandings();
        }
      } catch {
        // ignore malformed JSON
      }
    }
  });

  socket.on('close', () => {
    if (streamerName) {
      console.log(`  BizHawk disconnected: ${streamerName}`);
      bizhawkClients.delete(socket);
      broadcastStatus();
      broadcastStandings();
    }
  });

  socket.on('error', () => {
    bizhawkClients.delete(socket);
  });
});

// ── REST endpoints ──────────────────────────────────────────

// Public config (no secrets)
app.get('/config', (_req, res) => {
  res.json({
    streamers: config.streamers,
    twitchParentDomains: config.twitchParentDomains,
    crowdControlInteractUrl: ccClient ? ccClient.getInteractUrl() : '',
    crowdControlConnected: ccClient ? ccClient.getStatus().connected : false,
    crowdControlHost: (config.crowdControl || {}).hostStreamer || '',
    streamlabsTipUrl: config.streamlabsTipUrl || '',
    minDonation: MIN_DONATION,
    takeControlDonationSingle: config.takeControlDonationSingle || 1,
    takeControlDonationAll: config.takeControlDonationAll || 3,
    takeControlDurationMs: config.takeControlDurationMs || 30000,
    dkRapDurationMs: config.dkRapDurationMs || 208000,
    pianoDonation: config.pianoDonation || 5,
    pianoDurationMs: config.pianoDurationMs || 60000
  });
});

// Trigger DK Rap (secret required for manual trigger from non-Streamlabs sources)
const MAX_DONATION = 10000;
let lastTriggerTime = 0;
const TRIGGER_COOLDOWN_MS = 10000; // 10 seconds between triggers (global)

app.post('/trigger', rateLimit(10), (req, res) => {
  const { donorName, amount, secret } = req.body;

  // Secret is optional — if provided, it must match
  if (secret && secret !== TRIGGER_SECRET)
    return res.status(403).json({ error: 'Wrong secret code' });

  // If no secret, require that the request comes from Streamlabs webhook flow
  if (!secret && !req.body._fromStreamlabs)
    return res.status(403).json({ error: 'Donation required — use the Donate button' });

  // Block while DK Rap is already playing
  if (dkRapActive)
    return res.status(409).json({ error: 'DK Rap is already playing! Wait for it to finish.' });

  // Global cooldown — 10s between any triggers
  const now = Date.now();
  const cooldownRemaining = Math.ceil((TRIGGER_COOLDOWN_MS - (now - lastTriggerTime)) / 1000);
  if (now - lastTriggerTime < TRIGGER_COOLDOWN_MS)
    return res.status(429).json({ error: `Cooldown active — wait ${cooldownRemaining}s before triggering again` });

  if (streamers.size === 0 && allBizhawkNames().length === 0)
    return res.status(400).json({ error: 'No streamers are connected right now' });

  const parsedAmount = parseFloat(amount) || 0;
  if (parsedAmount < MIN_DONATION)
    return res.status(400).json({ error: `Minimum donation is $${MIN_DONATION}` });

  // Cap donation amount
  if (parsedAmount > MAX_DONATION)
    return res.status(400).json({ error: `Maximum donation amount is $${MAX_DONATION.toLocaleString()}` });

  lastTriggerTime = Date.now();
  const fired = fireDKRap(donorName || 'Anonymous', parsedAmount);
  res.json({ success: true, streamerCount: fired });
});

// ── Ruff Mode DK Rap (free trigger, viewer-only overlay) ─────
let ruffRapActive = false;
let ruffRapTimer = null;
const RUFF_RAP_COOLDOWN_MS = 30000; // 30s cooldown between ruff raps
let lastRuffRapTime = 0;
let ruffRapTowScore = 0;       // -500 (keep wins) to +500 (skip wins)
let ruffRapTowLocked = false;  // true when keep side maxes out
let ruffRapTetrisLines = 0;
const RUFF_RAP_TOW_TARGET = 500;
let ruffRapTetrisLineTarget = 40;
let ruffRapTetrisUsers = new Set(); // unique ws IDs that cleared lines
let ruffRapDecayInterval = null;

app.post('/ruff-rap', rateLimit(10), (req, res) => {
  const { triggerName } = req.body;

  if (ruffRapActive)
    return res.status(409).json({ error: 'DK Rap is already playing!' });

  const now = Date.now();
  if (now - lastRuffRapTime < RUFF_RAP_COOLDOWN_MS) {
    const wait = Math.ceil((RUFF_RAP_COOLDOWN_MS - (now - lastRuffRapTime)) / 1000);
    return res.status(429).json({ error: `Cooldown — wait ${wait}s` });
  }

  lastRuffRapTime = Date.now();
  ruffRapActive = true;
  const startTimestamp = Date.now();
  const durationMs = config.dkRapDurationMs || 208000;

  // Reset tug-of-war and tetris state
  ruffRapTowScore = 0;
  ruffRapTowLocked = false;
  ruffRapTetrisLines = 0;
  ruffRapTetrisLineTarget = 40;
  ruffRapTetrisUsers.clear();

  // Broadcast to all viewers
  viewers.forEach(ws => safeSend(ws, {
    type: 'RUFF_RAP', triggerName: triggerName || 'A viewer', startTimestamp, durationMs,
    towTarget: RUFF_RAP_TOW_TARGET, tetrisLineTarget: ruffRapTetrisLineTarget
  }));

  // No decay interval for tug-of-war (balanced by keep presses)
  if (ruffRapDecayInterval) { clearInterval(ruffRapDecayInterval); ruffRapDecayInterval = null; }

  if (ruffRapTimer) clearTimeout(ruffRapTimer);
  ruffRapTimer = setTimeout(() => {
    endRuffRap();
  }, durationMs);

  console.log(`  RUFF RAP triggered by "${triggerName || 'Anonymous'}"`);
  res.json({ success: true });
});

function endRuffRap() {
  ruffRapActive = false;
  ruffRapTowScore = 0;
  ruffRapTowLocked = false;
  if (ruffRapTimer) { clearTimeout(ruffRapTimer); ruffRapTimer = null; }
  if (ruffRapDecayInterval) { clearInterval(ruffRapDecayInterval); ruffRapDecayInterval = null; }
}

function broadcastTowUpdate() {
  viewers.forEach(v => safeSend(v, {
    type: 'RUFF_RAP_TOW_UPDATE', score: ruffRapTowScore, target: RUFF_RAP_TOW_TARGET
  }));
}

function skipRuffRap() {
  viewers.forEach(v => safeSend(v, { type: 'RUFF_RAP_SKIPPED' }));
  console.log('  RUFF RAP skipped by viewers!');
  endRuffRap();

  // Also cancel the donation DK Rap if active — unlock streamers early
  if (dkRapActive) {
    dkRapActive = false;
    if (dkRapTimer) { clearTimeout(dkRapTimer); dkRapTimer = null; }
    // Unlock BizHawk clients (TCP)
    bizhawkClients.forEach((info, socket) => {
      tcpSend(socket, { type: 'DK_RAP_LOCKOUT', active: false });
    });
    // Unlock HTTP BizHawk clients
    for (const [name, hb] of httpBizhawk) {
      hb.commandQueue.push({ type: 'DK_RAP_LOCKOUT', active: false });
    }
    broadcastStatus();
    console.log('  DK Rap lockout cancelled early by skip!');
  }
}

// ── Donation Processing (shared by webhook + socket) ────────
// Parses donation message for effect type
// Message format: "DK RAP" (default) or "CONTROL:StreamerName:CODE"
function processDonation(name, amount, message, source) {
  const parsedAmount = parseFloat(amount) || 0;
  const msg = (message || '').trim().toUpperCase();

  // Check if it's a Piano donation
  // Format: PIANO or PIANO:CLAIMCODE
  const pianoMatch = msg.match(/^PIANO(?:[:\s]+([A-Z0-9]{4,8}))?$/i);
  if (pianoMatch) {
    const minAmt = config.pianoDonation || 5;
    if (parsedAmount >= minAmt) {
      const claimCode = pianoMatch[1] ? pianoMatch[1].toUpperCase() : null;
      if (claimCode && claimCodes.has(claimCode)) {
        const entry = claimCodes.get(claimCode);
        if (entry.target === 'PIANO') {
          const claimId = crypto.randomUUID();
          claimCodes.delete(claimCode);
          pendingClaims.set(claimId, {
            ws: entry.ws,
            target: 'PIANO',
            donorName: name,
            amount: parsedAmount,
            createdAt: Date.now()
          });
          console.log(`  ${source} PIANO (claimed ${claimCode}, pending ${claimId}): ${name} ($${amount})`);
          safeSend(entry.ws, {
            type: 'CONTROL_READY',
            claimId,
            target: 'PIANO',
            donorName: name,
            amount: parsedAmount
          });
        }
      } else {
        console.log(`  ${source} PIANO (no code): ${name} ($${amount})`);
      }
    }
    return;
  }

  // Check if it's a Take Control donation
  // Format: CONTROL:Target or CONTROL:Target:CLAIMCODE
  const controlMatch = msg.match(/^CONTROL[:\s]+(\S+?)(?:[:\s]+([A-Z0-9]{4,8}))?$/i);
  if (controlMatch) {
    const targetName = controlMatch[1].trim();
    const claimCode = controlMatch[2] ? controlMatch[2].toUpperCase() : null;

    // Resolve target for both ALL and single
    const isAll = targetName.toUpperCase() === 'ALL';
    const minAmt = isAll ? (config.takeControlDonationAll || 3) : (config.takeControlDonationSingle || 1);
    let resolvedTarget = null;

    if (isAll && parsedAmount >= minAmt) {
      resolvedTarget = 'ALL';
    } else if (!isAll && parsedAmount >= minAmt) {
      const streamerMatch = config.streamers.find(s =>
        s.name.toUpperCase() === targetName.toUpperCase()
      );
      if (streamerMatch && isBizhawkConnected(streamerMatch.name)) {
        resolvedTarget = streamerMatch.name;
      }
    }

    if (resolvedTarget && claimCode && claimCodes.has(claimCode)) {
      const entry = claimCodes.get(claimCode);
      const codeTargetMatch = isAll
        ? entry.target === 'ALL'
        : entry.target.toUpperCase() === resolvedTarget.toUpperCase();

      if (codeTargetMatch) {
        // Claim code matched — store pending claim, send CONTROL_READY
        const claimId = crypto.randomUUID();
        claimCodes.delete(claimCode);
        pendingClaims.set(claimId, {
          ws: entry.ws,
          target: resolvedTarget,
          donorName: name,
          amount: parsedAmount,
          createdAt: Date.now()
        });
        console.log(`  ${source} CONTROL (claimed ${claimCode}, pending ${claimId}): ${name} -> ${resolvedTarget} ($${amount})`);
        safeSend(entry.ws, {
          type: 'CONTROL_READY',
          claimId,
          target: resolvedTarget,
          donorName: name,
          amount: parsedAmount
        });
      } else {
        console.log(`  ${source} CONTROL (code mismatch): ${name} -> ${resolvedTarget} ($${amount})`);
        viewers.forEach(ws => safeSend(ws, {
          type: 'TRIGGERED_CONTROL', donorName: name, amount: parsedAmount, targetStreamer: resolvedTarget
        }));
      }
    } else if (resolvedTarget) {
      // No valid claim code — broadcast notification only
      console.log(`  ${source} CONTROL (no code): ${name} -> ${resolvedTarget} ($${amount})`);
      viewers.forEach(ws => safeSend(ws, {
        type: 'TRIGGERED_CONTROL', donorName: name, amount: parsedAmount, targetStreamer: resolvedTarget
      }));
    }
  } else if (parsedAmount >= MIN_DONATION) {
    // Default: DK Rap trigger (block if already playing)
    if (dkRapActive) {
      console.log(`  ${source} DK Rap BLOCKED (already active): ${name} ($${amount})`);
      return;
    }
    if (parsedAmount > MAX_DONATION) {
      console.log(`  ${source} DK Rap BLOCKED (amount $${amount} > max $${MAX_DONATION}): ${name}`);
      return;
    }
    fireDKRap(name, parsedAmount);
  }
}

// Streamlabs webhook (legacy fallback)
app.post('/streamlabs', rateLimit(30), (req, res) => {
  try {
    const events = req.body?.data?.events || [];
    events.forEach(event => {
      if (event.type === 'donation') {
        processDonation(event.name, event.amount, event.message, 'Webhook');
      }
    });
  } catch { /* ignore */ }
  res.json({ ok: true });
});

// ── BizHawk HTTP heartbeat (for BizHawk versions without luasocket) ──
// BizHawk POSTs progress every few frames, gets back pending commands.
app.post('/bizhawk/heartbeat', rateLimit(1500), (req, res) => {
  const { name, key, levelId, levelName, worldIndex, levelIndex, progressIndex,
          exitTaken, levelStatus, timestamp } = req.body;

  if (!name) return res.status(400).json({ error: 'Missing streamer name' });
  if (!validateStreamerKey(name, key)) {
    return res.status(403).json({ error: 'Invalid streamer key' });
  }

  // Register or update HTTP BizHawk client
  if (!httpBizhawk.has(name)) {
    httpBizhawk.set(name, { lastSeen: Date.now(), commandQueue: [] });
    console.log(`  BizHawk connected (HTTP): ${name}`);
    broadcastStatus();
  }
  const hb = httpBizhawk.get(name);
  hb.lastSeen = Date.now();

  // Update race progress if level data provided
  if (levelId != null) {
    raceProgress.set(name, {
      levelId, levelName, worldIndex, levelIndex,
      progressIndex, exitTaken, levelStatus, timestamp
    });
    broadcastStandings();
  }

  // Drain command queue and return pending commands
  const commands = hb.commandQueue.splice(0);
  res.json({ ok: true, commands });
});

// Clean up stale HTTP BizHawk clients every 15 seconds
setInterval(() => {
  for (const [name, hb] of httpBizhawk) {
    if (Date.now() - hb.lastSeen > 15000) {
      httpBizhawk.delete(name);
      console.log(`  BizHawk disconnected (HTTP timeout): ${name}`);
      broadcastStatus();
      broadcastStandings();
    }
  }
}, 15000);

// Broadcast race standings every ~10 seconds for viewers
setInterval(() => {
  if (raceProgress.size > 0) {
    broadcastStandings();
  }
}, 10000);

// Clean up expired claim codes (10 min TTL) and pending claims (5 min TTL)
setInterval(() => {
  const now = Date.now();
  for (const [code, entry] of claimCodes) {
    if (now - entry.createdAt > 600000) claimCodes.delete(code);
  }
  for (const [id, claim] of pendingClaims) {
    if (now - claim.createdAt > 300000) {
      pendingClaims.delete(id);
      safeSend(claim.ws, { type: 'CONTROL_CLAIM_EXPIRED', claimId: id });
    }
  }
}, 60000);

// ── CrowdControl Admin Endpoints ─────────────────────────────
app.get('/admin/cc/auth', (_req, res) => {
  if (!ccClient) return res.status(400).json({ error: 'CrowdControl not configured' });
  const url = ccClient.getAuthUrl();
  if (url) {
    res.json({ authUrl: url });
  } else {
    res.json({ status: 'already authenticated', interactUrl: ccClient.getInteractUrl() });
  }
});

app.post('/admin/cc/start', (_req, res) => {
  if (!ccClient) return res.status(400).json({ error: 'CrowdControl not configured' });
  ccClient.startGameSession()
    .then(() => res.json({ success: true }))
    .catch(err => res.status(500).json({ error: err.message }));
});

app.post('/admin/cc/stop', (_req, res) => {
  if (!ccClient) return res.status(400).json({ error: 'CrowdControl not configured' });
  ccClient.stopGameSession()
    .then(() => res.json({ success: true }))
    .catch(err => res.status(500).json({ error: err.message }));
});

app.get('/admin/cc/status', (_req, res) => {
  if (!ccClient) return res.json({ configured: false });
  res.json({ configured: true, ...ccClient.getStatus() });
});

// ── CC Effects Catalog (public, cached) ─────────────────────
let ccEffectsCache = null;
let ccEffectsCacheTime = 0;
const CC_EFFECTS_TTL = 300000; // 5 minute cache

app.get('/cc/effects', async (_req, res) => {
  const gamePackID = (config.crowdControl || {}).gamePackID;
  if (!gamePackID) return res.json({ effects: [], categories: [] });

  // Return cached if fresh
  if (ccEffectsCache && Date.now() - ccEffectsCacheTime < CC_EFFECTS_TTL) {
    return res.json(ccEffectsCache);
  }

  try {
    const data = await new Promise((resolve, reject) => {
      https.get(`https://openapi.crowdcontrol.live/games/${gamePackID}/packs`, {
        headers: { 'Accept': 'application/json', 'User-Agent': 'DKRapChaos/2.0' }
      }, (resp) => {
        let body = '';
        resp.on('data', chunk => body += chunk);
        resp.on('end', () => {
          try { resolve(JSON.parse(body)); }
          catch { reject(new Error('Invalid JSON')); }
        });
      }).on('error', reject);
    });

    // Parse effects from the first pack
    const pack = Array.isArray(data) ? data[0] : data;
    const rawEffects = (pack && pack.effects && pack.effects.game) || {};
    const effects = [];
    const categorySet = new Set();

    for (const [id, fx] of Object.entries(rawEffects)) {
      if (fx.inactive) continue;
      const cats = fx.category || [];
      cats.forEach(c => categorySet.add(c));
      effects.push({
        id,
        name: fx.name || id,
        description: fx.description || '',
        price: fx.price || 0,
        categories: cats,
        duration: fx.duration ? fx.duration.value : 0,
        image: fx.image || '',
        quantity: fx.quantity || null
      });
    }

    // Sort by category, then price
    effects.sort((a, b) => {
      const catA = a.categories[0] || 'zzz';
      const catB = b.categories[0] || 'zzz';
      if (catA !== catB) return catA.localeCompare(catB);
      return a.price - b.price;
    });

    const result = {
      effects,
      categories: [...categorySet].sort(),
      gameName: (pack && pack.game && pack.game.name) || gamePackID,
      interactUrl: ccClient ? ccClient.getInteractUrl() : ''
    };

    ccEffectsCache = result;
    ccEffectsCacheTime = Date.now();
    res.json(result);
  } catch (err) {
    console.error('  CC Effects fetch error:', err.message);
    if (ccEffectsCache) return res.json(ccEffectsCache); // stale cache fallback
    res.status(500).json({ error: 'Failed to fetch effects' });
  }
});

// Health / status check
app.get('/status', (_req, res) => {
  res.json({
    streamers: streamerNames(),
    bizhawkConnected: allBizhawkNames(),
    minDonation: MIN_DONATION,
    dkRapCount: readCounter(),
    dkRapActive
  });
});

// ── OBS Audio Overlay & Media ─────────────────────────────────
app.get('/obs-audio', (_req, res) => {
  res.sendFile(path.join(__dirname, 'obs-audio.html'));
});

app.get('/obs-piano', (_req, res) => {
  res.sendFile(path.join(__dirname, 'obs-piano.html'));
});

// Serve DK Rap media files (audio for OBS overlay, MP4 fallback)
app.get('/media/dkrap_audio.m4a', (_req, res) => {
  const audioPath = path.join(__dirname, 'bizhawk', 'dkrap_audio.m4a');
  if (fs.existsSync(audioPath)) {
    res.sendFile(audioPath);
  } else {
    res.status(404).json({ error: 'Audio not extracted yet. Run: node extract-frames.js' });
  }
});

app.get('/media/dkrap360.mp4', (_req, res) => {
  const mp4Path = path.join(__dirname, 'dkrap360.mp4');
  if (fs.existsSync(mp4Path)) {
    res.sendFile(mp4Path);
  } else {
    res.status(404).json({ error: 'dkrap360.mp4 not found' });
  }
});

// Serve index.html at root
app.get('/health', (_req, res) => res.json({ status: 'ok' }));

app.get('/', (_req, res) => {
  res.setHeader('Cache-Control', 'no-cache, must-revalidate');
  res.sendFile(path.join(__dirname, 'index.html'));
});

// ── CrowdControl Client Init ─────────────────────────────────
const ccConfig = config.crowdControl || {};
if (ccConfig.gamePackID) {
  ccClient = new CrowdControlClient({
    tokenPath: path.join(__dirname, 'cc_token.json'),
    gamePackID: ccConfig.gamePackID,

    onEffectRequest: (event) => {
      const msg = { type: 'CC_EFFECT_EVENT', ...event };

      ccEffectLog.push(msg);
      if (ccEffectLog.length > CC_LOG_MAX) ccEffectLog.shift();

      viewers.forEach(ws => safeSend(ws, msg));
      console.log(`  CC EFFECT: ${event.effectName} by ${event.viewerName}`);
    },

    onStatusChange: (status) => {
      viewers.forEach(ws => safeSend(ws, { type: 'CC_STATUS', ...status }));
    },

    onAuthRequired: (authUrl) => {
      console.log(`\n  !! CrowdControl auth required !!`);
      console.log(`  Open this URL in your browser:`);
      console.log(`  ${authUrl}\n`);
    }
  });

  ccClient.connect();
}

// ── Streamlabs Socket API (real-time donation listener) ─────
const STREAMLABS_SOCKET_TOKEN = process.env.STREAMLABS_SOCKET_TOKEN || '';

function connectStreamlabs() {
  if (!STREAMLABS_SOCKET_TOKEN) {
    console.log('    Streamlabs    : DISABLED (no STREAMLABS_SOCKET_TOKEN)');
    return;
  }

  const sl = ioClient('https://sockets.streamlabs.com', {
    query: { token: STREAMLABS_SOCKET_TOKEN },
    transports: ['websocket']
  });

  sl.on('connect', () => {
    console.log('    Streamlabs    : Connected to socket API');
  });

  sl.on('event', (eventData) => {
    try {
      // Donation events have no 'for' property and type === 'donation'
      if (!eventData.for && eventData.type === 'donation') {
        const donations = eventData.message || [];
        donations.forEach(d => {
          console.log(`  Streamlabs donation: $${d.formatted_amount || d.amount} from ${d.name || d.from} — "${d.message || ''}"`);
          processDonation(
            d.name || d.from || 'Anonymous',
            d.amount,
            d.message || '',
            'Streamlabs'
          );
        });
      }
    } catch (err) {
      console.error('  Streamlabs event error:', err.message);
    }
  });

  sl.on('disconnect', (reason) => {
    console.log(`    Streamlabs    : Disconnected (${reason})`);
  });

  sl.on('connect_error', (err) => {
    console.error(`    Streamlabs    : Connection error — ${err.message}`);
  });
}

// ── Start ───────────────────────────────────────────────────
const PORT     = process.env.PORT || 3000;
const TCP_PORT = process.env.TCP_PORT || 3001;

server.listen(PORT, '0.0.0.0', () => {
  console.log(`\n  DK Rap Chaos Server v2 running on port ${PORT}`);
  console.log(`    Trigger secret : ${TRIGGER_SECRET}`);
  console.log(`    Min donation   : $${MIN_DONATION}`);
  console.log(`    Auth keys      : ${streamerKeys.size > 0 ? streamerKeys.size + ' streamers' : 'DISABLED (no keys)'}`);
  console.log(`    Viewer page    : http://localhost:${PORT}`);
  connectStreamlabs();
});

tcpServer.listen(TCP_PORT, () => {
  console.log(`    BizHawk TCP    : port ${TCP_PORT}\n`);
});
tcpServer.on('error', (err) => {
  console.log(`    BizHawk TCP    : UNAVAILABLE (${err.code || err.message}) — use HTTP bridge instead\n`);
});

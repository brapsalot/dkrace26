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

// ── CrowdControl Full Reverse Proxy ──────────────────────────
// Proxies all CrowdControl domains through our server so we can
// embed their interact page in an iframe (their CSP blocks external framing).
// Also forwards cookies and injects JS to route API calls through proxy.
const CC_DOMAINS = {
  'interact.crowdcontrol.live': '/cc-proxy',
  'api.crowdcontrol.live': '/cc-api',
  'auth.crowdcontrol.live': '/cc-auth',
  'crowdcontrol.live': '/cc-root'
};

// Reverse map: proxy prefix → upstream origin
const CC_PROXY_MAP = {};
for (const [domain, prefix] of Object.entries(CC_DOMAINS)) {
  CC_PROXY_MAP[prefix] = 'https://' + domain;
}

function rewriteUrl(url) {
  // Rewrite full CC URLs to go through our proxy
  for (const [domain, prefix] of Object.entries(CC_DOMAINS)) {
    if (url.includes('://' + domain)) {
      return url.replace('https://' + domain, prefix).replace('http://' + domain, prefix);
    }
  }
  return url;
}

// Injected into proxied HTML pages to route fetch/XHR/WebSocket through our proxy
// and catch OAuth auth tokens from popups
const CC_INJECT_SCRIPT = `<script>
(function() {
  var domains = ${JSON.stringify(CC_DOMAINS)};
  function rewrite(url) {
    if (typeof url !== 'string') url = String(url);
    for (var d in domains) {
      if (url.indexOf('://' + d) !== -1) {
        return url.replace('https://' + d, domains[d]).replace('http://' + d, domains[d]);
      }
    }
    return url;
  }
  // Override fetch
  var _fetch = window.fetch;
  window.fetch = function(input, init) {
    if (typeof input === 'string') input = rewrite(input);
    else if (input && input.url) input = new Request(rewrite(input.url), input);
    return _fetch.call(this, input, init);
  };
  // Override XMLHttpRequest.open
  var _xhrOpen = XMLHttpRequest.prototype.open;
  XMLHttpRequest.prototype.open = function(method, url) {
    arguments[1] = rewrite(url);
    return _xhrOpen.apply(this, arguments);
  };
  // Override window.open — track auth popups and auto-reload when they close
  var _windowOpen = window.open;
  window.open = function(url) {
    // Don't rewrite OAuth provider URLs (Twitch, Google, Discord) — they must
    // stay on the real domain for OAuth to work. Only rewrite CC domain URLs.
    if (url) arguments[0] = rewrite(url);
    var popup = _windowOpen.apply(this, arguments);
    // Poll for popup close — when auth completes, reload to pick up new state
    if (popup) {
      var pollTimer = setInterval(function() {
        try {
          if (popup.closed) {
            clearInterval(pollTimer);
            console.log('[CC Proxy] Auth popup closed, reloading...');
            // Give CC a moment to process the auth callback
            setTimeout(function() { location.reload(); }, 800);
          }
        } catch(e) { clearInterval(pollTimer); }
      }, 500);
    }
    return popup;
  };
  // Listen for postMessage from auth popups (CC may send tokens this way)
  window.addEventListener('message', function(event) {
    // Accept messages from any CC domain
    var isCC = false;
    for (var d in domains) {
      if (event.origin.indexOf(d) !== -1) { isCC = true; break; }
    }
    if (!isCC) return;
    // Store any auth-related data CC sends us
    if (event.data && typeof event.data === 'object') {
      console.log('[CC Proxy] Received postMessage from CC:', event.data.type || 'unknown');
      // Try to store token if present
      if (event.data.token || event.data.access_token || event.data.auth) {
        try {
          var key = 'cc_auth_data';
          localStorage.setItem(key, JSON.stringify(event.data));
          console.log('[CC Proxy] Stored auth data, reloading...');
          setTimeout(function() { location.reload(); }, 300);
        } catch(e) {}
      }
    }
  });
})();
</script>`;

function proxyCC(req, res, upstreamOrigin, remotePath) {
  const targetUrl = upstreamOrigin + remotePath;

  // Forward cookies from browser to upstream
  const reqHeaders = {
    'User-Agent': req.headers['user-agent'] || 'DKRapChaos/2.0',
    'Accept': req.headers['accept'] || '*/*',
    'Accept-Encoding': 'identity',
    'Referer': upstreamOrigin + '/',
    'Origin': upstreamOrigin
  };
  if (req.headers.cookie) {
    reqHeaders['Cookie'] = req.headers.cookie;
  }

  https.get(targetUrl, { headers: reqHeaders }, (upstream) => {
    // Rewrite redirect locations through our proxy
    if (upstream.statusCode >= 300 && upstream.statusCode < 400 && upstream.headers.location) {
      let loc = upstream.headers.location;
      loc = rewriteUrl(loc);
      // Also handle relative redirects
      if (loc.startsWith('/') && !loc.startsWith('/cc-')) {
        const prefix = Object.values(CC_DOMAINS).find(p =>
          req.originalUrl.startsWith(p)
        ) || '/cc-proxy';
        loc = prefix + loc;
      }
      res.redirect(upstream.statusCode, loc);
      return;
    }

    res.status(upstream.statusCode);

    const skip = new Set([
      'content-security-policy', 'content-security-policy-report-only',
      'x-frame-options', 'strict-transport-security', 'content-length',
      'transfer-encoding'
    ]);

    for (const [k, v] of Object.entries(upstream.headers)) {
      const kl = k.toLowerCase();
      if (skip.has(kl)) continue;
      // Pass Set-Cookie through (cookies will be on our domain)
      if (kl === 'set-cookie') {
        // Strip Domain attribute so cookies apply to our domain
        const cookies = Array.isArray(v) ? v : [v];
        const cleaned = cookies.map(c =>
          c.replace(/;\s*[Dd]omain=[^;]*/g, '')
           .replace(/;\s*[Ss]ame[Ss]ite=[^;]*/g, '; SameSite=Lax')
        );
        res.setHeader('Set-Cookie', cleaned);
        continue;
      }
      // Rewrite CORS headers
      if (kl === 'access-control-allow-origin') {
        res.setHeader(k, req.headers.origin || '*');
        continue;
      }
      res.setHeader(k, v);
    }

    const ct = (upstream.headers['content-type'] || '').toLowerCase();

    if (ct.includes('text/html')) {
      let body = '';
      upstream.on('data', chunk => { body += chunk.toString(); });
      upstream.on('end', () => {
        // Inject our fetch/XHR override script right after <head>
        body = body.replace(/<head([^>]*)>/i, '<head$1>' + CC_INJECT_SCRIPT);
        // Rewrite absolute-path src/href to go through proxy
        const prefix = Object.values(CC_DOMAINS).find(p =>
          req.originalUrl.startsWith(p)
        ) || '/cc-proxy';
        body = body.replace(/((?:src|href|action)\s*=\s*["'])\/(?!\/)/g, `$1${prefix}/`);
        // Rewrite full CC domain URLs in HTML attributes
        for (const [domain, pfx] of Object.entries(CC_DOMAINS)) {
          body = body.replace(new RegExp('https://' + domain.replace('.', '\\.'), 'g'), pfx);
        }
        res.send(body);
      });
    } else {
      upstream.pipe(res);
    }
  }).on('error', (err) => {
    console.error('  CC Proxy error:', err.message);
    if (!res.headersSent) res.status(502).send('Proxy error');
  });
}

// Register proxy routes for each CC domain
for (const [domain, prefix] of Object.entries(CC_DOMAINS)) {
  const origin = 'https://' + domain;
  app.get(prefix, (req, res) => proxyCC(req, res, origin, '/'));
  app.get(prefix + '/*', (req, res) => {
    proxyCC(req, res, origin, '/' + (req.params[0] || ''));
  });
  app.post(prefix + '/*', (req, res) => {
    // For POST requests (API calls), pipe the body through
    const url = new URL(origin + '/' + (req.params[0] || ''));
    const postHeaders = {
      'Content-Type': req.headers['content-type'] || 'application/json',
      'User-Agent': req.headers['user-agent'] || 'DKRapChaos/2.0',
      'Accept': req.headers['accept'] || '*/*',
      'Origin': origin,
      'Referer': origin + '/'
    };
    if (req.headers.cookie) postHeaders['Cookie'] = req.headers.cookie;
    if (req.headers.authorization) postHeaders['Authorization'] = req.headers.authorization;

    const body = JSON.stringify(req.body);
    postHeaders['Content-Length'] = Buffer.byteLength(body);

    const postReq = https.request({
      hostname: url.hostname,
      port: 443,
      path: url.pathname + url.search,
      method: 'POST',
      headers: postHeaders
    }, (upstream) => {
      res.status(upstream.statusCode);
      const skip = new Set([
        'content-security-policy', 'content-security-policy-report-only',
        'x-frame-options', 'strict-transport-security', 'transfer-encoding'
      ]);
      for (const [k, v] of Object.entries(upstream.headers)) {
        if (!skip.has(k.toLowerCase())) {
          if (k.toLowerCase() === 'access-control-allow-origin') {
            res.setHeader(k, req.headers.origin || '*');
          } else {
            res.setHeader(k, v);
          }
        }
      }
      upstream.pipe(res);
    });
    postReq.on('error', (err) => {
      if (!res.headersSent) res.status(502).json({ error: 'Proxy error' });
    });
    postReq.write(body);
    postReq.end();
  });
}

app.use(express.static(path.join(__dirname, 'public')));

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
    takeControlDonationSingle: 2.5,
    takeControlDonationAll: 10,
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
    takeControlDonationSingle: config.takeControlDonationSingle || 2.5,
    takeControlDonationAll: config.takeControlDonationAll || 10,
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

  // Notify viewer page (includes startTimestamp for OBS audio sync)
  viewers.forEach(ws => safeSend(ws, {
    type: 'TRIGGERED', donorName, amount, dkRapCount: count, startTimestamp
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
    // ALL mode: verify all BizHawks connected, min $10
    const minAmount = config.takeControlDonationAll || 10;
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
    // Single mode: min $2.50
    const minAmount = config.takeControlDonationSingle || 2.5;
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
          takeControlDonationSingle: config.takeControlDonationSingle || 2.5,
          takeControlDonationAll: config.takeControlDonationAll || 10,
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
          const result = grantControl(ws, pending.target, pending.donorName, pending.amount);
          if (result.error) {
            safeSend(ws, { type: 'CONTROL_ERROR', error: result.error });
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
    takeControlDonationSingle: config.takeControlDonationSingle || 2.5,
    takeControlDonationAll: config.takeControlDonationAll || 10,
    takeControlDurationMs: config.takeControlDurationMs || 30000,
    dkRapDurationMs: config.dkRapDurationMs || 208000
  });
});

// Trigger DK Rap (secret required for manual trigger from non-Streamlabs sources)
app.post('/trigger', rateLimit(10), (req, res) => {
  const { donorName, amount, secret } = req.body;

  // Secret is optional — if provided, it must match
  if (secret && secret !== TRIGGER_SECRET)
    return res.status(403).json({ error: 'Wrong secret code' });

  // If no secret, require that the request comes from Streamlabs webhook flow
  if (!secret && !req.body._fromStreamlabs)
    return res.status(403).json({ error: 'Donation required — use the Donate button' });

  if (streamers.size === 0 && allBizhawkNames().length === 0)
    return res.status(400).json({ error: 'No streamers are connected right now' });

  const parsedAmount = parseFloat(amount) || 0;
  if (parsedAmount < MIN_DONATION)
    return res.status(400).json({ error: `Minimum donation is $${MIN_DONATION}` });

  const fired = fireDKRap(donorName || 'Anonymous', parsedAmount);
  res.json({ success: true, streamerCount: fired });
});

// ── Donation Processing (shared by webhook + socket) ────────
// Parses donation message for effect type
// Message format: "DK RAP" (default) or "CONTROL:StreamerName:CODE"
function processDonation(name, amount, message, source) {
  const parsedAmount = parseFloat(amount) || 0;
  const msg = (message || '').trim().toUpperCase();

  // Check if it's a Take Control donation
  // Format: CONTROL:Target or CONTROL:Target:CLAIMCODE
  const controlMatch = msg.match(/^CONTROL[:\s]+(\S+?)(?:[:\s]+([A-Z0-9]{4,8}))?$/i);
  if (controlMatch) {
    const targetName = controlMatch[1].trim();
    const claimCode = controlMatch[2] ? controlMatch[2].toUpperCase() : null;

    // Resolve target for both ALL and single
    const isAll = targetName.toUpperCase() === 'ALL';
    const minAmt = isAll ? (config.takeControlDonationAll || 10) : (config.takeControlDonationSingle || 2.5);
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
    // Default: DK Rap trigger
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

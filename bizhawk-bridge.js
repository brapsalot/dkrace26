// ── BizHawk <-> Server Bridge ─────────────────────────────────
// Bridges between the Lua script (file I/O) and the HTTP server.
// Run: node bizhawk-bridge.js [streamerName]
//
// The Lua script writes progress to bizhawk/state_{name}.json
// This bridge reads it, POSTs to the server, and writes commands
// back to bizhawk/commands_{name}.json for the Lua script to read.

const fs = require('fs');
const path = require('path');
const http = require('http');
const https = require('https');

const name = process.argv[2] || 'Deth';
const serverUrl = process.env.SERVER_URL || 'http://localhost:3000/bizhawk/heartbeat';
const streamerKey = process.env.STREAMER_KEY || '';
const pollInterval = parseInt(process.env.POLL_MS) || 50;  // ms between polls

const DIR = path.join(__dirname, 'bizhawk');
const STATE_FILE = path.join(DIR, `state_${name}.json`);
const CMD_FILE = path.join(DIR, `commands_${name}.json`);

// Ensure bizhawk dir exists
if (!fs.existsSync(DIR)) fs.mkdirSync(DIR, { recursive: true });

// Clear old files on start
try { fs.writeFileSync(CMD_FILE, '[]'); } catch {}
try { fs.unlinkSync(STATE_FILE); } catch {}

let lastStateContent = '';
let connected = false;
let errorCount = 0;

console.log(`\n  BizHawk Bridge for "${name}"`);
console.log(`  Server:     ${serverUrl}`);
console.log(`  Auth key:   ${streamerKey ? '****' + streamerKey.slice(-4) : 'NOT SET'}`);
console.log(`  State file: ${STATE_FILE}`);
console.log(`  Cmd file:   ${CMD_FILE}`);
console.log(`  Poll rate:  ${pollInterval}ms\n`);

function postToServer(body) {
  return new Promise((resolve, reject) => {
    const url = new URL(serverUrl);
    const transport = url.protocol === 'https:' ? https : http;
    const options = {
      hostname: url.hostname,
      port: url.port || (url.protocol === 'https:' ? 443 : 80),
      path: url.pathname,
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'Content-Length': Buffer.byteLength(body)
      },
      timeout: 2000
    };

    const req = transport.request(options, (res) => {
      let data = '';
      res.on('data', chunk => data += chunk);
      res.on('end', () => {
        try {
          resolve(JSON.parse(data));
        } catch {
          resolve(null);
        }
      });
    });

    req.on('error', reject);
    req.on('timeout', () => { req.destroy(); reject(new Error('timeout')); });
    req.write(body);
    req.end();
  });
}

async function poll() {
  try {
    // Read state file from Lua script
    let stateBody;
    try {
      const content = fs.readFileSync(STATE_FILE, 'utf8');
      if (content && content !== lastStateContent) {
        lastStateContent = content;
        // Inject key into state payload
        try {
          const stateObj = JSON.parse(content);
          stateObj.key = streamerKey;
          stateBody = JSON.stringify(stateObj);
        } catch {
          stateBody = content;  // fallback: send raw if parse fails
        }
      } else {
        // No new state — still send a heartbeat with just the name
        stateBody = JSON.stringify({ name, key: streamerKey });
      }
    } catch {
      // File doesn't exist yet — send heartbeat with just name
      stateBody = JSON.stringify({ name, key: streamerKey });
    }

    // POST to server
    const result = await postToServer(stateBody);

    if (result) {
      // Check for auth failure
      if (result.error === 'Invalid streamer key') {
        if (connected || errorCount === 0) {
          console.log('\n  !! AUTH FAILED — invalid streamer key !!');
          console.log('  Check your STREAMER_KEY environment variable.\n');
          connected = false;
        }
        errorCount++;
        return;
      }

      if (!connected) {
        connected = true;
        errorCount = 0;
        console.log('  Connected to server!');
      }

      // Write commands for Lua to read
      if (result.commands && result.commands.length > 0) {
        fs.writeFileSync(CMD_FILE, JSON.stringify(result.commands));
        for (const cmd of result.commands) {
          if (cmd.type === 'DK_RAP_LOCKOUT') {
            console.log(cmd.active
              ? `  >> DK RAP LOCKOUT ACTIVE (video + audio sync, ts: ${cmd.startTimestamp})`
              : '  >> Lockout ended');
          } else if (cmd.type === 'INJECT_INPUT') {
            const pressed = Object.entries(cmd.buttons || {}).filter(([,v]) => v).map(([k]) => k);
            if (pressed.length) console.log(`  >> Input: [${pressed.join(', ')}]`);
          }
        }
      } else {
        // Clear commands file if no new commands
        fs.writeFileSync(CMD_FILE, '[]');
      }
    }
  } catch (err) {
    errorCount++;
    if (connected && errorCount > 5) {
      connected = false;
      console.log('  Lost connection to server — retrying...');
    }
    if (errorCount % 20 === 0) {
      console.log(`  Still trying to connect... (${err.message})`);
    }
  }
}

// Start polling loop
setInterval(poll, pollInterval);
console.log('  Bridge running. Press Ctrl+C to stop.\n');

// Keep alive
process.on('SIGINT', () => {
  console.log('\n  Bridge stopped.');
  try { fs.unlinkSync(STATE_FILE); } catch {}
  try { fs.writeFileSync(CMD_FILE, '[]'); } catch {}
  process.exit(0);
});

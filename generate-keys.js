// ── Streamer Key Generator ────────────────────────────────────
// Generates unique secret keys for each streamer in config.json.
// Run once: node generate-keys.js
//
// Output:
//   1. streamer_keys.json (local dev — gitignored)
//   2. STREAMER_KEYS env var value (for Railway)
//   3. Individual keys to DM each streamer
// ──────────────────────────────────────────────────────────────

const crypto = require('crypto');
const fs = require('fs');
const path = require('path');

const config = JSON.parse(fs.readFileSync(path.join(__dirname, 'config.json'), 'utf8'));
const keys = {};

for (const s of config.streamers) {
  keys[s.name] = crypto.randomBytes(32).toString('hex');
}

// Save to local file (gitignored)
const keysPath = path.join(__dirname, 'streamer_keys.json');
fs.writeFileSync(keysPath, JSON.stringify(keys, null, 2));
console.log(`\n  Saved to: ${keysPath}\n`);

// Print Railway env var value
console.log('  === STREAMER_KEYS env var (set this on Railway) ===');
console.log(`  ${JSON.stringify(keys)}\n`);

// Print individual keys for DM-ing
console.log('  === Individual keys (DM each streamer their key) ===');
for (const [name, key] of Object.entries(keys)) {
  console.log(`    ${name.padEnd(20)} ${key}`);
}
console.log('');

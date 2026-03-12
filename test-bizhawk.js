// ── Fake BizHawk client for local testing ────────────────────
// Usage: node test-bizhawk.js [streamerName]
// Connects to the TCP server and registers as a BizHawk client.
// Run multiple instances with different names to simulate all 4 streamers.

const net = require('net');

const name = process.argv[2] || 'Smile';
const port = process.env.TCP_PORT || 3001;

const client = net.createConnection(port, 'localhost', () => {
  console.log(`Connected as "${name}" on port ${port}`);
  send({ type: 'REGISTER_BIZHAWK', name });

  // Send a fake progress update so the leaderboard shows something
  send({
    type: 'PROGRESS_UPDATE',
    levelId: 0x16,
    levelName: 'Jungle Hijinxs',
    worldIndex: 0,
    levelIndex: 0,
    progressIndex: 0,
    exitTaken: false,
    levelStatus: 'playing',
    timestamp: Date.now()
  });
});

function send(obj) {
  client.write(JSON.stringify(obj) + '\n');
}

client.on('data', (data) => {
  const lines = data.toString().split('\n').filter(l => l.trim());
  for (const line of lines) {
    try {
      const msg = JSON.parse(line);
      console.log(`  << ${msg.type}`, JSON.stringify(msg, null, 2));

      if (msg.type === 'INJECT_INPUT') {
        const pressed = Object.entries(msg.buttons || {})
          .filter(([, v]) => v)
          .map(([k]) => k);
        if (pressed.length) {
          console.log(`  BUTTONS: [${pressed.join(', ')}]`);
        }
      }

      if (msg.type === 'DK_RAP_LOCKOUT') {
        console.log(msg.active ? '  LOCKED OUT — DK Rap playing!' : '  UNLOCKED — DK Rap ended');
      }
    } catch {
      console.log('  << raw:', line);
    }
  }
});

client.on('close', () => {
  console.log('Disconnected');
  process.exit(0);
});

client.on('error', (err) => {
  console.error('Connection error:', err.message);
  process.exit(1);
});

// Keep alive
setInterval(() => {}, 60000);
console.log('Press Ctrl+C to disconnect.\n');

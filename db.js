// ============================================================
//  Credits Database (SQLite via better-sqlite3)
// ============================================================
const Database = require('better-sqlite3');
const crypto   = require('crypto');
const path     = require('path');
const fs       = require('fs');

let db;

function initDb(dbPath) {
  const dir = path.dirname(dbPath || './data/credits.db');
  if (!fs.existsSync(dir)) fs.mkdirSync(dir, { recursive: true });

  db = new Database(dbPath || './data/credits.db');
  db.pragma('journal_mode = WAL');
  db.pragma('foreign_keys = ON');

  db.exec(`
    CREATE TABLE IF NOT EXISTS users (
      twitch_id    TEXT PRIMARY KEY,
      twitch_name  TEXT NOT NULL,
      balance      REAL NOT NULL DEFAULT 0,
      created_at   TEXT NOT NULL DEFAULT (datetime('now')),
      updated_at   TEXT NOT NULL DEFAULT (datetime('now'))
    );

    CREATE TABLE IF NOT EXISTS transactions (
      id           INTEGER PRIMARY KEY AUTOINCREMENT,
      twitch_id    TEXT NOT NULL REFERENCES users(twitch_id),
      type         TEXT NOT NULL,
      amount       REAL NOT NULL,
      effect       TEXT,
      donation_id  TEXT,
      created_at   TEXT NOT NULL DEFAULT (datetime('now'))
    );

    CREATE TABLE IF NOT EXISTS sessions (
      token        TEXT PRIMARY KEY,
      twitch_id    TEXT NOT NULL REFERENCES users(twitch_id),
      created_at   TEXT NOT NULL DEFAULT (datetime('now')),
      expires_at   TEXT NOT NULL
    );
  `);

  // Unique index on donation_id for idempotency (ignore NULLs)
  db.exec(`
    CREATE UNIQUE INDEX IF NOT EXISTS idx_donation_id
      ON transactions(donation_id) WHERE donation_id IS NOT NULL;
  `);

  console.log('    Credits DB    : Initialized');
  return db;
}

// ── Users ────────────────────────────────────────────────────

function upsertUser(twitchId, twitchName) {
  const stmt = db.prepare(`
    INSERT INTO users (twitch_id, twitch_name)
    VALUES (?, ?)
    ON CONFLICT(twitch_id) DO UPDATE SET
      twitch_name = excluded.twitch_name,
      updated_at = datetime('now')
  `);
  stmt.run(twitchId, twitchName);
  return db.prepare('SELECT * FROM users WHERE twitch_id = ?').get(twitchId);
}

function getUser(twitchId) {
  return db.prepare('SELECT * FROM users WHERE twitch_id = ?').get(twitchId) || null;
}

// ── Sessions ─────────────────────────────────────────────────

function getUserBySessionToken(token) {
  if (!token) return null;
  const row = db.prepare(`
    SELECT u.* FROM users u
    JOIN sessions s ON s.twitch_id = u.twitch_id
    WHERE s.token = ? AND s.expires_at > datetime('now')
  `).get(token);
  return row || null;
}

function createSession(twitchId) {
  const token = crypto.randomBytes(32).toString('hex');
  const expiresAt = new Date(Date.now() + 30 * 24 * 60 * 60 * 1000).toISOString();
  db.prepare(`
    INSERT INTO sessions (token, twitch_id, expires_at)
    VALUES (?, ?, ?)
  `).run(token, twitchId, expiresAt);
  return token;
}

function deleteSession(token) {
  if (!token) return;
  db.prepare('DELETE FROM sessions WHERE token = ?').run(token);
}

function cleanExpiredSessions() {
  const info = db.prepare("DELETE FROM sessions WHERE expires_at <= datetime('now')").run();
  if (info.changes > 0) console.log(`    Credits DB    : Cleaned ${info.changes} expired sessions`);
}

// ── Credits ──────────────────────────────────────────────────

const depositTx = (db) => db.transaction((twitchId, amount, donationId) => {
  // Idempotency check
  if (donationId) {
    const existing = db.prepare(
      'SELECT id FROM transactions WHERE donation_id = ?'
    ).get(donationId);
    if (existing) return { success: false, reason: 'duplicate' };
  }

  db.prepare(`
    INSERT INTO transactions (twitch_id, type, amount, donation_id)
    VALUES (?, 'deposit', ?, ?)
  `).run(twitchId, amount, donationId);

  db.prepare(`
    UPDATE users SET balance = balance + ?, updated_at = datetime('now')
    WHERE twitch_id = ?
  `).run(amount, twitchId);

  const user = db.prepare('SELECT balance FROM users WHERE twitch_id = ?').get(twitchId);
  return { success: true, newBalance: user.balance };
});

function deposit(twitchId, amount, donationId) {
  return depositTx(db)(twitchId, amount, donationId);
}

const redeemTx = (db) => db.transaction((twitchId, amount, effectName) => {
  const user = db.prepare('SELECT balance FROM users WHERE twitch_id = ?').get(twitchId);
  if (!user || user.balance < amount) {
    return { success: false, reason: 'insufficient', balance: user ? user.balance : 0 };
  }

  db.prepare(`
    INSERT INTO transactions (twitch_id, type, amount, effect)
    VALUES (?, 'redeem', ?, ?)
  `).run(twitchId, amount, effectName);

  db.prepare(`
    UPDATE users SET balance = balance - ?, updated_at = datetime('now')
    WHERE twitch_id = ?
  `).run(amount, twitchId);

  const updated = db.prepare('SELECT balance FROM users WHERE twitch_id = ?').get(twitchId);
  return { success: true, newBalance: updated.balance };
});

function redeem(twitchId, amount, effectName) {
  return redeemTx(db)(twitchId, amount, effectName);
}

function getBalance(twitchId) {
  const user = db.prepare('SELECT balance FROM users WHERE twitch_id = ?').get(twitchId);
  return user ? user.balance : 0;
}

function getTransactions(twitchId, limit = 20) {
  return db.prepare(`
    SELECT type, amount, effect, created_at FROM transactions
    WHERE twitch_id = ? ORDER BY id DESC LIMIT ?
  `).all(twitchId, limit);
}

module.exports = {
  initDb,
  upsertUser,
  getUser,
  getUserBySessionToken,
  createSession,
  deleteSession,
  cleanExpiredSessions,
  deposit,
  redeem,
  getBalance,
  getTransactions
};

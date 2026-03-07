// ============================================================
//  CrowdControl PubSub WebSocket Client
//  Connects to wss://pubsub.crowdcontrol.live/
//  Handles auth, subscriptions, and effect event relay.
// ============================================================

const WebSocket = require('ws');
const https = require('https');
const fs = require('fs');
const path = require('path');

const CC_WS_URL = 'wss://pubsub.crowdcontrol.live/';
const CC_API_URL = 'https://openapi.crowdcontrol.live';
const CC_AUTH_URL = 'https://auth.crowdcontrol.live/';

class CrowdControlClient {
  constructor(opts) {
    this.tokenPath = opts.tokenPath || path.join(__dirname, 'cc_token.json');
    this.gamePackID = opts.gamePackID || '';
    this.onEffectRequest = opts.onEffectRequest || (() => {});
    this.onStatusChange = opts.onStatusChange || (() => {});
    this.onAuthRequired = opts.onAuthRequired || (() => {});

    this.ws = null;
    this.token = null;
    this.ccUID = null;
    this.originID = null;
    this.profileType = null;
    this.connectionID = null;
    this.gameSessionID = null;
    this.gameSessionActive = false;

    this.reconnectDelay = 1000;
    this.reconnectTimer = null;
    this.intentionalClose = false;
  }

  // ── Token Persistence ──────────────────────────────
  _loadToken() {
    try {
      const data = JSON.parse(fs.readFileSync(this.tokenPath, 'utf8'));
      if (!data.token) return false;

      const payload = this._decodeJWT(data.token);
      if (!payload) return false;

      // Check expiry (with 60s buffer)
      if (payload.exp && Date.now() / 1000 > payload.exp - 60) {
        console.log('  CC: Saved token has expired, need re-auth');
        return false;
      }

      this.token = data.token;
      this.ccUID = payload.ccUID || data.ccUID;
      this.originID = payload.originID || data.originID;
      this.profileType = payload.profileType || data.profileType;
      return true;
    } catch {
      return false;
    }
  }

  _saveToken() {
    const data = {
      token: this.token,
      ccUID: this.ccUID,
      originID: this.originID,
      profileType: this.profileType,
      savedAt: Date.now()
    };
    try {
      fs.writeFileSync(this.tokenPath, JSON.stringify(data, null, 2));
    } catch (err) {
      console.error('  CC: Failed to save token:', err.message);
    }
  }

  _decodeJWT(token) {
    try {
      const parts = token.split('.');
      if (parts.length !== 3) return null;
      return JSON.parse(Buffer.from(parts[1], 'base64').toString());
    } catch {
      return null;
    }
  }

  // ── Connection ─────────────────────────────────────
  connect() {
    if (this.ws && this.ws.readyState === WebSocket.OPEN) return;

    this.intentionalClose = false;

    try {
      this.ws = new WebSocket(CC_WS_URL, {
        headers: { 'User-Agent': 'DKRapChaos/2.0' }
      });
    } catch (err) {
      console.error('  CC: WebSocket creation failed:', err.message);
      this._scheduleReconnect();
      return;
    }

    this.ws.on('open', () => {
      console.log('  CC: Connected to PubSub');
      this.reconnectDelay = 1000;

      // If we have a saved token, go straight to subscribe
      if (this._loadToken()) {
        console.log('  CC: Using saved token for', this.profileType + '/' + this.originID);
        this._subscribe();
      } else {
        // Need auth — send whoami to get connectionID
        this._send({ action: 'whoami' });
      }
    });

    this.ws.on('message', (raw) => {
      try {
        const msg = JSON.parse(raw.toString());
        this._handleMessage(msg);
      } catch {
        // ignore malformed
      }
    });

    this.ws.on('close', () => {
      if (!this.intentionalClose) {
        console.log('  CC: PubSub disconnected, reconnecting...');
        this._scheduleReconnect();
      }
      this._emitStatus();
    });

    this.ws.on('error', (err) => {
      console.error('  CC: WebSocket error:', err.message);
    });
  }

  disconnect() {
    this.intentionalClose = true;
    if (this.reconnectTimer) {
      clearTimeout(this.reconnectTimer);
      this.reconnectTimer = null;
    }
    if (this.ws) {
      this.ws.close();
      this.ws = null;
    }
  }

  _scheduleReconnect() {
    if (this.intentionalClose) return;
    if (this.reconnectTimer) clearTimeout(this.reconnectTimer);
    this.reconnectTimer = setTimeout(() => {
      this.reconnectTimer = null;
      this.connect();
    }, this.reconnectDelay);
    this.reconnectDelay = Math.min(this.reconnectDelay * 2, 30000);
  }

  _send(obj) {
    if (this.ws && this.ws.readyState === WebSocket.OPEN) {
      this.ws.send(JSON.stringify(obj));
    }
  }

  // ── Message Handling ───────────────────────────────
  _handleMessage(msg) {
    // whoami response — contains connectionID
    const connID = msg.connectionID || (msg.type === 'whoami' && msg.payload?.connectionID);
    if (connID) {
      this.connectionID = connID;
      const authUrl = CC_AUTH_URL + '?connectionID=' + this.connectionID;
      console.log('  CC: Awaiting auth. Connection ID:', this.connectionID);
      this.onAuthRequired(authUrl);
      this._emitStatus();
      return;
    }

    // login-success — JWT token received
    if (msg.domain === 'direct' && msg.type === 'login-success' && msg.payload?.token) {
      this.token = msg.payload.token;
      const payload = this._decodeJWT(this.token);
      if (payload) {
        this.ccUID = payload.ccUID;
        this.originID = payload.originID;
        this.profileType = payload.profileType;
        console.log('  CC: Authenticated as', payload.name, '(' + this.profileType + '/' + this.originID + ')');
        this._saveToken();
        this._subscribe();
      }
      return;
    }

    // Subscription confirmation
    if (msg.type === 'subscription-result') {
      const success = msg.payload?.success || msg.success;
      if (success && success.length > 0) {
        console.log('  CC: Subscribed to', success.length, 'topic(s)');
      } else {
        console.error('  CC: Subscription failed:', JSON.stringify(msg));
      }
      this._emitStatus();
      return;
    }

    // Effect request from a viewer purchase
    if (msg.domain === 'pub' && msg.type === 'effect-request' && msg.payload) {
      this._handleEffectRequest(msg.payload);
      return;
    }

    // Game session events
    if (msg.type === 'game-session-start') {
      this.gameSessionActive = true;
      this.gameSessionID = msg.payload?.gameSessionID || this.gameSessionID;
      console.log('  CC: Game session started');
      this._emitStatus();
      return;
    }

    if (msg.type === 'game-session-stop') {
      this.gameSessionActive = false;
      this.gameSessionID = null;
      console.log('  CC: Game session stopped');
      this._emitStatus();
      return;
    }
  }

  _subscribe() {
    if (!this.token || !this.ccUID) return;
    this._send({
      action: 'subscribe',
      data: {
        token: this.token,
        topics: ['pub/' + this.ccUID]
      }
    });
    this._emitStatus();
  }

  _handleEffectRequest(payload) {
    const event = {
      requestID: payload.requestID,
      effectID: payload.effect?.effectID || 'unknown',
      effectName: payload.effect?.name || 'Unknown Effect',
      effectType: payload.effect?.type || 'game',
      duration: payload.effect?.duration || 0,
      viewerName: payload.target?.name || 'Someone',
      timestamp: Date.now()
    };

    this.onEffectRequest(event);
  }

  // ── Game Session Management ────────────────────────
  startGameSession() {
    if (!this.token || !this.gamePackID) {
      return Promise.reject(new Error('Not authenticated or no gamePackID configured'));
    }
    return this._apiRequest('/game-session/start', 'POST', {
      gamePackID: this.gamePackID,
      effectReportArgs: []
    }).then(res => {
      this.gameSessionID = res.gameSessionID;
      this.gameSessionActive = true;
      console.log('  CC: Game session started:', this.gameSessionID);
      this._emitStatus();
      return res;
    });
  }

  stopGameSession() {
    if (!this.gameSessionID) {
      return Promise.reject(new Error('No active game session'));
    }
    return this._apiRequest('/game-session/stop', 'POST', {
      gameSessionID: this.gameSessionID
    }).then(res => {
      this.gameSessionActive = false;
      this.gameSessionID = null;
      console.log('  CC: Game session stopped');
      this._emitStatus();
      return res;
    });
  }

  // ── HTTP API Helper ────────────────────────────────
  _apiRequest(endpoint, method, body) {
    return new Promise((resolve, reject) => {
      const url = new URL(endpoint, CC_API_URL);
      const data = JSON.stringify(body);

      const req = https.request(url, {
        method,
        headers: {
          'Content-Type': 'application/json',
          'Authorization': 'cc-auth-token ' + this.token,
          'User-Agent': 'DKRapChaos/2.0',
          'Accept': 'application/json',
          'Content-Length': Buffer.byteLength(data)
        }
      }, (res) => {
        let chunks = '';
        res.on('data', d => chunks += d);
        res.on('end', () => {
          try {
            const parsed = JSON.parse(chunks);
            if (res.statusCode >= 400) {
              reject(new Error(parsed.error || parsed.message || `HTTP ${res.statusCode}`));
            } else {
              resolve(parsed);
            }
          } catch {
            if (res.statusCode >= 400) {
              reject(new Error(`HTTP ${res.statusCode}: ${chunks}`));
            } else {
              resolve({});
            }
          }
        });
      });

      req.on('error', reject);
      req.write(data);
      req.end();
    });
  }

  // ── Public Getters ─────────────────────────────────
  getInteractUrl() {
    if (!this.profileType || !this.originID) return '';
    return 'https://interact.crowdcontrol.live/#/' + this.profileType + '/' + this.originID;
  }

  getAuthUrl() {
    if (this.token && this.ccUID) return null; // already authenticated
    if (this.connectionID) {
      return CC_AUTH_URL + '?connectionID=' + this.connectionID;
    }
    return null;
  }

  getStatus() {
    return {
      connected: !!(this.ws && this.ws.readyState === WebSocket.OPEN),
      authenticated: !!this.token,
      gameSessionActive: this.gameSessionActive,
      interactUrl: this.getInteractUrl(),
      hostProfile: this.profileType ? this.profileType + '/' + this.originID : ''
    };
  }

  _emitStatus() {
    this.onStatusChange(this.getStatus());
  }
}

module.exports = { CrowdControlClient };

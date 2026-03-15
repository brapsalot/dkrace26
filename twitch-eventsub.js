// ============================================================
//  Twitch EventSub WebSocket Client
//  Connects to wss://eventsub.wss.twitch.tv/ws
//  Subscribes to channel.cheer events and relays to callback.
// ============================================================

const WebSocket = require('ws');
const https = require('https');
const fs = require('fs');
const path = require('path');
const crypto = require('crypto');

const EVENTSUB_WS_URL = 'wss://eventsub.wss.twitch.tv/ws';
const TWITCH_AUTH_URL = 'https://id.twitch.tv/oauth2';
const TWITCH_API_URL = 'https://api.twitch.tv/helix';

class TwitchEventSubClient {
  constructor(opts) {
    this.clientId = opts.clientId || '';
    this.clientSecret = opts.clientSecret || '';
    this.redirectUri = opts.redirectUri || '';
    this.tokenPath = opts.tokenPath || path.join(__dirname, 'twitch_eventsub_tokens.json');

    this.onCheer = opts.onCheer || (() => {});
    this.onStatusChange = opts.onStatusChange || (() => {});
    this.onAuthRequired = opts.onAuthRequired || (() => {});

    this.accessToken = null;
    this.refreshToken = null;
    this.broadcasterId = null;

    this.ws = null;
    this.sessionId = null;
    this.keepaliveTimeoutMs = 30000; // default, updated from welcome message
    this.keepaliveTimer = null;

    this.reconnectDelay = 1000;
    this.reconnectTimer = null;
    this.intentionalClose = false;
    this._reconnectUrl = null; // set during session_reconnect
  }

  // ── Token Persistence ──────────────────────────────

  _loadTokens() {
    try {
      const data = JSON.parse(fs.readFileSync(this.tokenPath, 'utf8'));
      if (!data.access_token || !data.refresh_token || !data.broadcaster_id) return false;
      this.accessToken = data.access_token;
      this.refreshToken = data.refresh_token;
      this.broadcasterId = data.broadcaster_id;
      return true;
    } catch {
      return false;
    }
  }

  _saveTokens() {
    const data = {
      access_token: this.accessToken,
      refresh_token: this.refreshToken,
      broadcaster_id: this.broadcasterId,
      savedAt: Date.now()
    };
    try {
      fs.writeFileSync(this.tokenPath, JSON.stringify(data, null, 2));
    } catch (err) {
      console.error('  TwitchES: Failed to save tokens:', err.message);
    }
  }

  // ── OAuth ──────────────────────────────────────────

  getAuthUrl() {
    const state = crypto.randomUUID();
    this._pendingState = state;
    const params = new URLSearchParams({
      client_id: this.clientId,
      redirect_uri: this.redirectUri,
      response_type: 'code',
      scope: 'bits:read',
      state
    });
    return `${TWITCH_AUTH_URL}/authorize?${params}`;
  }

  async handleCallback(code, state) {
    if (this._pendingState && state !== this._pendingState) {
      throw new Error('Invalid OAuth state');
    }
    this._pendingState = null;

    // Exchange code for tokens
    const tokenData = await this._httpsPost('id.twitch.tv', '/oauth2/token', null, new URLSearchParams({
      client_id: this.clientId,
      client_secret: this.clientSecret,
      code,
      grant_type: 'authorization_code',
      redirect_uri: this.redirectUri
    }).toString(), 'application/x-www-form-urlencoded');

    if (!tokenData.access_token) {
      throw new Error('Token exchange failed');
    }

    this.accessToken = tokenData.access_token;
    this.refreshToken = tokenData.refresh_token;

    // Fetch broadcaster user ID
    const userRes = await this._helixGet('/users');
    const user = userRes.data?.[0];
    if (!user) throw new Error('Failed to fetch Twitch user');

    this.broadcasterId = user.id;
    console.log(`  TwitchES: Authenticated as ${user.display_name} (ID ${user.id})`);
    this._saveTokens();

    // Now connect the EventSub WebSocket
    this.connect();
    return user;
  }

  async _refreshAccessToken() {
    if (!this.refreshToken) return false;
    try {
      const data = await this._httpsPost('id.twitch.tv', '/oauth2/token', null, new URLSearchParams({
        client_id: this.clientId,
        client_secret: this.clientSecret,
        grant_type: 'refresh_token',
        refresh_token: this.refreshToken
      }).toString(), 'application/x-www-form-urlencoded');

      if (!data.access_token) return false;
      this.accessToken = data.access_token;
      this.refreshToken = data.refresh_token || this.refreshToken;
      this._saveTokens();
      console.log('  TwitchES: Token refreshed');
      return true;
    } catch (err) {
      console.error('  TwitchES: Token refresh failed:', err.message);
      return false;
    }
  }

  async _ensureValidToken() {
    if (!this.accessToken) return false;
    try {
      // Validate current token
      const res = await this._httpsGet('id.twitch.tv', '/oauth2/validate', this.accessToken);
      if (res.client_id) return true;
    } catch {
      // Token invalid, try refresh
    }
    return this._refreshAccessToken();
  }

  // ── WebSocket Connection ───────────────────────────

  async connect() {
    if (!this.clientId || !this.clientSecret) {
      console.log('    Twitch Bits   : DISABLED (no TWITCH_CLIENT_ID / TWITCH_CLIENT_SECRET)');
      this._emitStatus();
      return;
    }

    // Load saved tokens if we don't have them
    if (!this.accessToken && !this._loadTokens()) {
      const authUrl = this.getAuthUrl();
      console.log('    Twitch Bits   : NEEDS AUTH');
      this.onAuthRequired(authUrl);
      this._emitStatus();
      return;
    }

    // Validate/refresh token
    const valid = await this._ensureValidToken();
    if (!valid) {
      this.accessToken = null;
      this.refreshToken = null;
      const authUrl = this.getAuthUrl();
      console.log('    Twitch Bits   : NEEDS RE-AUTH (token expired)');
      this.onAuthRequired(authUrl);
      this._emitStatus();
      return;
    }

    this._connectWs();
  }

  _connectWs(url) {
    if (this.ws && this.ws.readyState === WebSocket.OPEN && !this._reconnectUrl) return;
    this.intentionalClose = false;

    const wsUrl = url || this._reconnectUrl || EVENTSUB_WS_URL;
    this._reconnectUrl = null;

    try {
      this.ws = new WebSocket(wsUrl);
    } catch (err) {
      console.error('  TwitchES: WebSocket creation failed:', err.message);
      this._scheduleReconnect();
      return;
    }

    this.ws.on('open', () => {
      this.reconnectDelay = 1000;
      // Wait for session_welcome — don't log connected yet
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
      this._clearKeepaliveTimer();
      if (!this.intentionalClose) {
        console.log('  TwitchES: Disconnected, reconnecting...');
        this._scheduleReconnect();
      }
      this._emitStatus();
    });

    this.ws.on('error', (err) => {
      console.error('  TwitchES: WebSocket error:', err.message);
    });
  }

  disconnect() {
    this.intentionalClose = true;
    this._clearKeepaliveTimer();
    if (this.reconnectTimer) {
      clearTimeout(this.reconnectTimer);
      this.reconnectTimer = null;
    }
    if (this.ws) {
      this.ws.close();
      this.ws = null;
    }
    this.sessionId = null;
  }

  _scheduleReconnect() {
    if (this.intentionalClose) return;
    if (this.reconnectTimer) clearTimeout(this.reconnectTimer);
    this.reconnectTimer = setTimeout(() => {
      this.reconnectTimer = null;
      this._connectWs();
    }, this.reconnectDelay);
    this.reconnectDelay = Math.min(this.reconnectDelay * 2, 30000);
  }

  // ── Message Handling ───────────────────────────────

  _handleMessage(msg) {
    const type = msg.metadata?.message_type;

    if (type === 'session_welcome') {
      this.sessionId = msg.payload?.session?.id;
      const keepaliveTimeout = msg.payload?.session?.keepalive_timeout_seconds;
      if (keepaliveTimeout) {
        // Add buffer — if no keepalive within timeout + 10s, reconnect
        this.keepaliveTimeoutMs = (keepaliveTimeout + 10) * 1000;
      }
      console.log('    Twitch Bits   : Connected (session ' + this.sessionId?.slice(0, 8) + '...)');
      this._resetKeepaliveTimer();
      this._createSubscription();
      this._emitStatus();
      return;
    }

    if (type === 'session_keepalive') {
      this._resetKeepaliveTimer();
      return;
    }

    if (type === 'session_reconnect') {
      const newUrl = msg.payload?.session?.reconnect_url;
      if (newUrl) {
        console.log('  TwitchES: Reconnect requested');
        this._reconnectUrl = newUrl;
        const oldWs = this.ws;
        this._connectWs(newUrl);
        // Close old connection after new one is established
        setTimeout(() => {
          if (oldWs && oldWs.readyState === WebSocket.OPEN) {
            oldWs.close();
          }
        }, 5000);
      }
      return;
    }

    if (type === 'notification') {
      this._resetKeepaliveTimer();
      const subType = msg.metadata?.subscription_type;
      if (subType === 'channel.cheer') {
        this._handleCheer(msg.payload?.event);
      }
      return;
    }

    if (type === 'revocation') {
      console.log('  TwitchES: Subscription revoked:', msg.payload?.subscription?.status);
      return;
    }
  }

  _handleCheer(event) {
    if (!event) return;
    const userName = event.user_name || event.user_login || 'Anonymous';
    const bits = parseInt(event.bits, 10) || 0;
    const message = event.message || '';
    const dollarAmount = bits / 100;

    this.onCheer(userName, dollarAmount, message);
  }

  // ── Keepalive Timer ────────────────────────────────

  _resetKeepaliveTimer() {
    this._clearKeepaliveTimer();
    this.keepaliveTimer = setTimeout(() => {
      console.log('  TwitchES: Keepalive timeout, reconnecting...');
      if (this.ws) this.ws.close();
      // close handler will trigger reconnect
    }, this.keepaliveTimeoutMs);
  }

  _clearKeepaliveTimer() {
    if (this.keepaliveTimer) {
      clearTimeout(this.keepaliveTimer);
      this.keepaliveTimer = null;
    }
  }

  // ── EventSub Subscription ─────────────────────────

  async _createSubscription() {
    if (!this.sessionId || !this.broadcasterId) return;

    try {
      const body = JSON.stringify({
        type: 'channel.cheer',
        version: '1',
        condition: { broadcaster_user_id: this.broadcasterId },
        transport: { method: 'websocket', session_id: this.sessionId }
      });

      const res = await this._httpsPost('api.twitch.tv', '/helix/eventsub/subscriptions', this.accessToken, body, 'application/json');

      if (res.data?.[0]) {
        console.log('  TwitchES: Subscribed to channel.cheer');
      } else if (res.status === 409) {
        // Already subscribed — fine
        console.log('  TwitchES: channel.cheer subscription already exists');
      } else {
        console.error('  TwitchES: Subscription failed:', JSON.stringify(res));
        // Try token refresh and retry once
        if (await this._refreshAccessToken()) {
          const retry = await this._httpsPost('api.twitch.tv', '/helix/eventsub/subscriptions', this.accessToken, body, 'application/json');
          if (retry.data?.[0]) {
            console.log('  TwitchES: Subscribed to channel.cheer (after refresh)');
          }
        }
      }
    } catch (err) {
      console.error('  TwitchES: Subscription error:', err.message);
    }
  }

  // ── HTTP Helpers ───────────────────────────────────

  _httpsGet(hostname, urlPath, bearerToken) {
    return new Promise((resolve, reject) => {
      const headers = {};
      if (bearerToken) {
        headers['Authorization'] = 'OAuth ' + bearerToken;
      }
      const req = https.request({ hostname, path: urlPath, method: 'GET', headers }, (res) => {
        let chunks = '';
        res.on('data', d => chunks += d);
        res.on('end', () => {
          try { resolve(JSON.parse(chunks)); } catch { resolve({}); }
        });
      });
      req.on('error', reject);
      req.end();
    });
  }

  _helixGet(urlPath) {
    return new Promise((resolve, reject) => {
      const req = https.request({
        hostname: 'api.twitch.tv',
        path: '/helix' + urlPath,
        method: 'GET',
        headers: {
          'Authorization': 'Bearer ' + this.accessToken,
          'Client-Id': this.clientId
        }
      }, (res) => {
        let chunks = '';
        res.on('data', d => chunks += d);
        res.on('end', () => {
          try { resolve(JSON.parse(chunks)); } catch { resolve({}); }
        });
      });
      req.on('error', reject);
      req.end();
    });
  }

  _httpsPost(hostname, urlPath, bearerToken, body, contentType) {
    return new Promise((resolve, reject) => {
      const headers = { 'Content-Type': contentType || 'application/json' };
      if (bearerToken) {
        headers['Authorization'] = 'Bearer ' + bearerToken;
        if (hostname === 'api.twitch.tv') headers['Client-Id'] = this.clientId;
      }
      if (body) headers['Content-Length'] = Buffer.byteLength(body);

      const req = https.request({ hostname, path: urlPath, method: 'POST', headers }, (res) => {
        let chunks = '';
        res.on('data', d => chunks += d);
        res.on('end', () => {
          try {
            const parsed = JSON.parse(chunks);
            parsed.status = res.statusCode;
            resolve(parsed);
          } catch {
            resolve({ status: res.statusCode, raw: chunks });
          }
        });
      });
      req.on('error', reject);
      if (body) req.write(body);
      req.end();
    });
  }

  // ── Status ─────────────────────────────────────────

  getStatus() {
    return {
      connected: !!(this.ws && this.ws.readyState === WebSocket.OPEN && this.sessionId),
      authenticated: !!this.accessToken,
      broadcasterId: this.broadcasterId
    };
  }

  _emitStatus() {
    this.onStatusChange(this.getStatus());
  }
}

module.exports = { TwitchEventSubClient };

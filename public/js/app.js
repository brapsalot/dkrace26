// ── DK Rap Chaos — Main Viewer Client ────────────────────────

const App = (() => {
  const WS_URL = (location.protocol === 'https:' ? 'wss' : 'ws') + '://' + location.host;
  let ws;
  let minDonation = 5;
  let takeControlDonationSingle = 2.5;
  let takeControlDonationAll = 10;
  let dkRapDurationMs = 185000;
  let streamlabsTipUrl = '';
  let controlSessionId = null;
  let controlTarget = null;
  let controlIsAll = false;
  let controlTargets = [];
  let controlTimerInterval = null;
  let controlExpiresAt = null;
  let controlDurationMs = 30000;
  let ccInteractUrl = '';
  let claimCode = null;
  let pendingClaimId = null;

  let chatInitialized = false;

  // ── Init ────────────────────────────────────────────
  async function init() {
    await loadConfig();
    connectWS();
    GamepadController.init(sendInput);
    bindUI();
    initTabs();
    DrawCanvas.init((msg) => {
      if (ws && ws.readyState === WebSocket.OPEN) {
        ws.send(JSON.stringify(msg));
      }
    });
    LayoutManager.init();
  }

  // ── Config ──────────────────────────────────────────
  async function loadConfig() {
    try {
      const res = await fetch('/config');
      const cfg = await res.json();
      minDonation = cfg.minDonation || 5;
      takeControlDonationSingle = cfg.takeControlDonationSingle || 2.5;
      takeControlDonationAll = cfg.takeControlDonationAll || 10;
      dkRapDurationMs = cfg.dkRapDurationMs || 185000;
      streamlabsTipUrl = cfg.streamlabsTipUrl || '';

      // Init Twitch embeds
      if (cfg.streamers && cfg.streamers.length > 0) {
        initTwitchEmbeds(cfg.streamers, cfg.twitchParentDomains || ['localhost']);
      }

      // CrowdControl
      if (cfg.crowdControlInteractUrl) {
        ccInteractUrl = cfg.crowdControlInteractUrl;
        document.getElementById('ccInteract').style.display = 'block';
        document.getElementById('ccInteractLink').href = ccInteractUrl;
        setCCIframeSrc(ccInteractUrl);
      }

      // Update donate button URL and message
      updateDonateMessage();
      updateDonateLink();
    } catch (err) {
      console.error('Failed to load config:', err);
    }
  }

  // ── WebSocket ───────────────────────────────────────
  function connectWS() {
    ws = new WebSocket(WS_URL);

    ws.onopen = () => {
      ws.send(JSON.stringify({ type: 'REGISTER_VIEWER' }));
      setConn(true);
      // Re-register claim code if one was active
      if (claimCode) {
        const effect = document.getElementById('effectType').value;
        const target = effect === 'control-all' ? 'ALL' : document.getElementById('controlTarget').value;
        ws.send(JSON.stringify({ type: 'REGISTER_CLAIM_CODE', code: claimCode, target }));
      }
    };

    ws.onmessage = ({ data }) => {
      const msg = JSON.parse(data);

      switch (msg.type) {
        case 'STATUS':
          updateStreamers(msg.streamers || []);
          minDonation = msg.minDonation || 5;
          document.getElementById('rapCount').textContent = msg.dkRapCount || 0;
          updateControlTargets(msg.configStreamers || [], msg.bizhawkConnected || []);
          break;

        case 'TRIGGERED':
          addLog(msg.donorName, msg.amount, 'rap');
          if (msg.dkRapCount != null) {
            document.getElementById('rapCount').textContent = msg.dkRapCount;
          }
          showDKRapBanner(msg.donorName, msg.amount);
          break;

        case 'RACE_STANDINGS':
          updateLeaderboard(msg.standings || []);
          break;

        case 'CONTROL_GRANTED':
          onControlGranted(msg);
          break;

        case 'CONTROL_ENDED':
          onControlEnded();
          break;

        case 'CONTROL_ERROR':
          showStatus(msg.error, 'error');
          break;

        case 'CONTROL_READY':
          onControlReady(msg);
          break;

        case 'CONTROL_CLAIM_EXPIRED':
          onControlClaimExpired(msg);
          break;

        case 'CONTROL_ACTIVE':
          updateControlNotifications(msg.sessions || []);
          break;

        case 'CC_STATUS':
          onCCStatus(msg);
          break;

        case 'CC_EFFECT_EVENT':
          onCCEffectEvent(msg);
          break;

        case 'CC_EFFECT_HISTORY':
          if (msg.events) msg.events.forEach(e => onCCEffectEvent(e, true));
          break;

        case 'DRAW':
          DrawCanvas.onDrawMessage(msg);
          break;
      }
    };

    ws.onclose = () => { setConn(false); setTimeout(connectWS, 3000); };
    ws.onerror = () => ws.close();
  }

  function setConn(live) {
    document.getElementById('connDot').className = 'conn-dot' + (live ? ' live' : '');
    document.getElementById('connLabel').textContent = live ? 'Live' : 'Reconnecting...';
  }

  // ── Streamer List ───────────────────────────────────
  function updateStreamers(list) {
    const el = document.getElementById('streamerList');
    if (!list.length) {
      el.innerHTML = '<span class="empty-msg">No streamers connected yet</span>';
      return;
    }
    el.innerHTML = list.map(n =>
      `<span class="streamer-badge"><span class="dot"></span>${n}</span>`
    ).join('');
  }

  // ── Control target dropdown ─────────────────────────
  function updateControlTargets(configStreamers, bizhawkConnected) {
    const optionsHtml = configStreamers.map(s => {
      const connected = bizhawkConnected.includes(s.name);
      return `<option value="${s.name}" ${!connected ? 'disabled' : ''}>${s.name}${connected ? '' : ' (offline)'}</option>`;
    }).join('');

    const select = document.getElementById('controlTarget');
    if (select) {
      const currentVal = select.value;
      select.innerHTML = optionsHtml;
      if (currentVal) select.value = currentVal;
    }
    updateDonateLink();

  }

  // ── UI Bindings ────────────────────────────────────
  function bindUI() {
    // Effect type toggle
    const effectSelect = document.getElementById('effectType');
    const targetField = document.getElementById('controlTargetField');

    effectSelect.addEventListener('change', () => {
      targetField.style.display = effectSelect.value === 'control-single' ? 'block' : 'none';
      registerClaimCode();
      updateDonateLink();
    });

    // Streamer selection changes the donate message
    document.getElementById('controlTarget').addEventListener('change', () => {
      registerClaimCode();
      updateDonateLink();
    });

    // Copy message button
    document.getElementById('copyMessageBtn').addEventListener('click', () => {
      const msg = document.getElementById('donateMessage').textContent;
      navigator.clipboard.writeText(msg).then(() => {
        const btn = document.getElementById('copyMessageBtn');
        btn.textContent = 'Copied!';
        btn.classList.add('copied');
        setTimeout(() => { btn.textContent = 'Copy'; btn.classList.remove('copied'); }, 1500);
      });
    });

    // Activate control button
    document.getElementById('activateBtn').addEventListener('click', activateControl);

    // Donate button
    document.getElementById('donateBtn').addEventListener('click', (e) => {
      if (!streamlabsTipUrl) {
        e.preventDefault();
        showStatus('Streamlabs tip URL not configured yet', 'error');
      }
    });

    // ── Test Mode (always available via tab) ───────────
    document.getElementById('testDkRapBtn').addEventListener('click', () => {
      const name = document.getElementById('testDonorName').value || 'TestViewer';
      const amount = parseFloat(document.getElementById('testAmount').value) || 5;
      fetch('/trigger', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ donorName: name, amount, secret: 'dkrap2024' })
      })
        .then(r => r.json())
        .then(data => {
          const bar = document.getElementById('testStatusBar');
          if (data.error) {
            bar.textContent = data.error;
            bar.className = 'status-bar error';
          } else {
            bar.textContent = 'DK Rap triggered!';
            bar.className = 'status-bar success';
          }
        })
        .catch(err => {
          const bar = document.getElementById('testStatusBar');
          bar.textContent = err.message;
          bar.className = 'status-bar error';
        });
    });

    document.getElementById('testControlSingleBtn').addEventListener('click', () => {
      const name = document.getElementById('testDonorName').value || 'TestViewer';
      const amount = parseFloat(document.getElementById('testAmount').value) || 10;
      const target = document.getElementById('controlTarget').value;
      if (!target) {
        const bar = document.getElementById('testStatusBar');
        bar.textContent = 'Select a streamer in the Donate tab first';
        bar.className = 'status-bar error';
        return;
      }
      if (ws && ws.readyState === WebSocket.OPEN) {
        ws.send(JSON.stringify({
          type: 'REQUEST_CONTROL',
          targetStreamer: target,
          donorName: name,
          amount
        }));
        const bar = document.getElementById('testStatusBar');
        bar.textContent = 'Control requested (single)...';
        bar.className = 'status-bar success';
      }
    });

    document.getElementById('testControlAllBtn').addEventListener('click', () => {
      const name = document.getElementById('testDonorName').value || 'TestViewer';
      const amount = parseFloat(document.getElementById('testAmount').value) || 10;
      if (ws && ws.readyState === WebSocket.OPEN) {
        ws.send(JSON.stringify({
          type: 'REQUEST_CONTROL',
          targetStreamer: 'ALL',
          donorName: name,
          amount
        }));
        const bar = document.getElementById('testStatusBar');
        bar.textContent = 'Control ALL requested...';
        bar.className = 'status-bar success';
      }
    });
  }

  // ── Claim Code ──────────────────────────────────────
  function generateClaimCode() {
    const chars = 'ABCDEFGHJKLMNPQRSTUVWXYZ23456789';
    let code = '';
    for (let i = 0; i < 4; i++) code += chars[Math.floor(Math.random() * chars.length)];
    return code;
  }

  function registerClaimCode() {
    const effect = document.getElementById('effectType').value;
    if (effect !== 'control-single' && effect !== 'control-all') {
      claimCode = null;
      updateDonateMessage();
      return;
    }
    claimCode = generateClaimCode();
    const target = effect === 'control-all' ? 'ALL' : document.getElementById('controlTarget').value;
    if (ws && ws.readyState === WebSocket.OPEN) {
      ws.send(JSON.stringify({ type: 'REGISTER_CLAIM_CODE', code: claimCode, target }));
    }
    updateDonateMessage();
  }

  // ── Control Ready / Activate ────────────────────────
  function onControlReady(msg) {
    pendingClaimId = msg.claimId;
    const panel = document.getElementById('activatePanel');
    const targetLabel = msg.target === 'ALL' ? 'ALL Streamers' : msg.target;
    document.getElementById('activateTargetLabel').textContent = targetLabel;
    document.getElementById('activateDonorLabel').textContent = msg.donorName;
    panel.style.display = 'block';
    panel.classList.add('pulse');

    // Switch to donate tab so user sees the activate button
    document.querySelectorAll('.tab-btn').forEach(b => b.classList.remove('active'));
    document.querySelector('.tab-btn[data-tab="donate"]').classList.add('active');
    document.querySelectorAll('.tab-content').forEach(c => c.classList.remove('active'));
    document.querySelector('.tab-content[data-tab="donate"]').classList.add('active');
  }

  function onControlClaimExpired(msg) {
    if (pendingClaimId === msg.claimId) {
      pendingClaimId = null;
      const panel = document.getElementById('activatePanel');
      panel.style.display = 'none';
      panel.classList.remove('pulse');
      showStatus('Control claim expired — try donating again', 'error');
    }
  }

  function activateControl() {
    if (!pendingClaimId || !ws || ws.readyState !== WebSocket.OPEN) return;
    ws.send(JSON.stringify({ type: 'ACTIVATE_CONTROL', claimId: pendingClaimId }));
    pendingClaimId = null;
    const panel = document.getElementById('activatePanel');
    panel.style.display = 'none';
    panel.classList.remove('pulse');
  }

  // ── Donate Message & Link ─────────────────────────
  function updateDonateMessage() {
    const effect = document.getElementById('effectType').value;
    const msgEl = document.getElementById('donateMessage');

    if (effect === 'control-single') {
      const target = document.getElementById('controlTarget').value;
      const code = claimCode ? `:${claimCode}` : '';
      msgEl.textContent = target ? `CONTROL:${target}${code}` : 'CONTROL:StreamerName';
    } else if (effect === 'control-all') {
      const code = claimCode ? `:${claimCode}` : '';
      msgEl.textContent = `CONTROL:ALL${code}`;
    } else {
      msgEl.textContent = 'DK RAP';
    }
  }

  function updateDonateLink() {
    const btn = document.getElementById('donateBtn');
    if (streamlabsTipUrl) {
      btn.href = streamlabsTipUrl;
    } else {
      btn.href = '#';
    }
  }

  function showStatus(text, type) {
    const el = document.getElementById('statusBar');
    el.textContent = text;
    el.className = 'status-bar ' + type;
  }

  // ── DK Rap Banner (top bar) ───────────────────────
  function showDKRapBanner(donorName, amount) {
    const overlay = document.getElementById('dkRapOverlay');
    overlay.classList.add('active');
    document.body.classList.add('dk-rap-active');
    overlay.querySelector('.overlay-donor').textContent = `${donorName} donated $${amount}`;

    const timerEl = overlay.querySelector('.overlay-timer');
    const endTime = Date.now() + dkRapDurationMs;

    function tick() {
      const remaining = endTime - Date.now();
      if (remaining <= 0) {
        overlay.classList.remove('active');
        document.body.classList.remove('dk-rap-active');
        return;
      }
      const mins = Math.floor(remaining / 60000);
      const secs = Math.floor((remaining % 60000) / 1000);
      timerEl.textContent = `${mins}:${secs.toString().padStart(2, '0')}`;
      requestAnimationFrame(tick);
    }
    requestAnimationFrame(tick);
  }

  // ── Take Control ────────────────────────────────────
  function onControlGranted(msg) {
    controlSessionId = msg.sessionId;
    controlTarget = msg.targetStreamer;
    controlExpiresAt = msg.expiresAt;
    controlDurationMs = msg.durationMs || 30000;
    controlIsAll = msg.isAll || false;
    controlTargets = msg.targets || [];

    const grid = document.querySelector('.streams-grid');
    const overlay = document.getElementById('gamepadOverlay');

    if (controlIsAll) {
      // ALL mode: keep 2x2 grid, overlay centered
      grid.classList.add('control-all');
      document.getElementById('controlTargetName').textContent = 'ALL Streamers';
    } else {
      // Single mode: hide other streams, show only target
      grid.classList.add('control-single');
      // Find the target streamer's cell by label text
      document.querySelectorAll('.stream-cell').forEach(cell => {
        const label = cell.querySelector('.stream-label');
        if (label && controlTargets.includes(label.textContent.trim())) {
          cell.classList.add('control-active');
        }
      });
      document.getElementById('controlTargetName').textContent = controlTargets[0] || msg.targetStreamer;
    }

    // Show gamepad overlay
    overlay.style.display = 'flex';
    overlay.classList.add('active');

    // Enable gamepad
    GamepadController.setActive(true);

    // Start timer
    updateControlTimer();
    controlTimerInterval = setInterval(updateControlTimer, 100);

    addLog('Viewer', null, 'control', controlIsAll ? 'ALL Streamers' : (controlTargets[0] || msg.targetStreamer));
  }

  function updateControlTimer() {
    if (!controlExpiresAt) return;
    const remaining = Math.max(0, controlExpiresAt - Date.now());
    const secs = (remaining / 1000).toFixed(1);
    document.getElementById('controlTimeRemaining').textContent = `${secs}s`;

    const total = controlDurationMs;
    const fill = document.getElementById('controlTimerFill');
    fill.style.width = (remaining / total * 100) + '%';

    if (remaining <= 0) onControlEnded();
  }

  function onControlEnded() {
    controlSessionId = null;
    controlTarget = null;
    controlExpiresAt = null;
    controlIsAll = false;
    controlTargets = [];
    if (controlTimerInterval) {
      clearInterval(controlTimerInterval);
      controlTimerInterval = null;
    }

    GamepadController.setActive(false);

    // Hide gamepad overlay
    const overlay = document.getElementById('gamepadOverlay');
    overlay.style.display = 'none';
    overlay.classList.remove('active');

    // Restore grid
    const grid = document.querySelector('.streams-grid');
    grid.classList.remove('control-single', 'control-all');
    document.querySelectorAll('.stream-cell.control-active').forEach(cell => {
      cell.classList.remove('control-active');
    });
  }

  function sendInput(buttons) {
    if (!controlSessionId || !ws || ws.readyState !== WebSocket.OPEN) return;
    ws.send(JSON.stringify({
      type: 'INPUT',
      sessionId: controlSessionId,
      buttons
    }));
  }

  // ── Control Notifications ───────────────────────────
  function updateControlNotifications(sessions) {
    const banner = document.getElementById('controlNotification');
    if (!sessions.length) {
      banner.classList.remove('active');
      return;
    }
    banner.classList.add('active');
    banner.innerHTML = sessions.map(s => {
      const target = s.isAll ? 'ALL Streamers' : s.targetStreamer;
      return `<strong>${s.controllerName}</strong> is controlling <strong>${target}</strong> (${Math.ceil(s.remainingMs / 1000)}s)`;
    }).join(' | ');
  }

  // ── Chaos Log ───────────────────────────────────────
  function addLog(name, amount, logType, target, effectLabel) {
    const el = document.getElementById('logEntries');
    if (el.querySelector('.empty-msg')) el.innerHTML = '';
    const t = new Date().toLocaleTimeString();
    const entry = document.createElement('div');
    entry.className = 'log-entry';

    if (logType === 'cc') {
      entry.innerHTML = `<span class="log-time">[${t}]</span> <strong>${name}</strong> used <strong>${effectLabel}</strong>`;
    } else if (logType === 'control') {
      entry.innerHTML = `<span class="log-time">[${t}]</span> <strong>${name}</strong> took control of <strong>${target}</strong>`;
    } else {
      entry.innerHTML = `<span class="log-time">[${t}]</span> <strong>${name}</strong> donated <strong>$${amount}</strong> — all streamers suffering`;
    }
    el.insertBefore(entry, el.firstChild);

    // Keep max 50 entries
    while (el.children.length > 50) el.removeChild(el.lastChild);
  }

  // ── CrowdControl ───────────────────────────────────
  function setCCIframeSrc(directUrl) {
    const iframe = document.getElementById('ccIframe');
    const loading = document.getElementById('ccIframeLoading');
    if (!iframe || iframe.src !== 'about:blank') return; // only set once

    try {
      const parsed = new URL(directUrl);
      if (parsed.hostname === 'interact.crowdcontrol.live') {
        iframe.src = '/cc-proxy' + parsed.pathname + parsed.hash;
      } else {
        iframe.src = directUrl;
      }
    } catch {
      iframe.src = directUrl;
    }

    iframe.addEventListener('load', () => {
      if (loading) loading.style.display = 'none';
    }, { once: true });
  }

  function onCCStatus(msg) {
    const dot = document.getElementById('ccStatusDot');
    const label = document.getElementById('ccStatusLabel');
    const interact = document.getElementById('ccInteract');
    const link = document.getElementById('ccInteractLink');

    if (msg.connected) {
      dot.className = 'cc-status-dot connected';
      label.textContent = msg.gameSessionActive ? 'Game Session Active' : 'Connected';
    } else if (msg.authenticated) {
      dot.className = 'cc-status-dot auth';
      label.textContent = 'Authenticated (no session)';
    } else {
      dot.className = 'cc-status-dot';
      label.textContent = 'Disconnected';
    }

    if (msg.interactUrl) {
      ccInteractUrl = msg.interactUrl;
      interact.style.display = 'block';
      link.href = msg.interactUrl;
      setCCIframeSrc(msg.interactUrl);
    }
  }

  function onCCEffectEvent(event, isHistory) {
    const list = document.getElementById('ccActivityList');
    if (list.querySelector('.empty-msg')) list.innerHTML = '';

    const entry = document.createElement('div');
    entry.className = 'cc-activity-entry' + (isHistory ? '' : ' new');

    const time = new Date(event.timestamp || Date.now()).toLocaleTimeString();
    const durationTag = event.duration ? ` (${event.duration}s)` : '';
    entry.innerHTML = `<span class="cc-activity-time">[${time}]</span> <strong>${event.viewerName}</strong> used <strong>${event.effectName}</strong>${durationTag}`;

    list.insertBefore(entry, list.firstChild);

    // Keep max 50 entries
    while (list.children.length > 50) list.removeChild(list.lastChild);

    // Also add to chaos log (skip for history to avoid flooding)
    if (!isHistory) {
      addLog(event.viewerName, null, 'cc', null, event.effectName);
    }
  }

  // ── Tabs ──────────────────────────────────────────
  function initTabs() {
    document.querySelectorAll('.tab-btn').forEach(btn => {
      btn.addEventListener('click', () => {
        const tab = btn.dataset.tab;

        // Update active tab button
        document.querySelectorAll('.tab-btn').forEach(b => b.classList.remove('active'));
        btn.classList.add('active');

        // Update active tab content
        document.querySelectorAll('.tab-content').forEach(c => c.classList.remove('active'));
        const content = document.querySelector(`.tab-content[data-tab="${tab}"]`);
        if (content) content.classList.add('active');

        // Lazy-init chat on first visit
        if (tab === 'chat' && !chatInitialized) {
          initChat();
        }
      });
    });

    // Init chat on load since it's the default active tab
    initChat();
  }

  function initChat() {
    if (chatInitialized) return;
    chatInitialized = true;

    const container = document.getElementById('chatEmbed');
    if (!container) return;

    // Build a multi-chat URL from all configured streamers
    // Use the first streamer's chat as default, or fall back to a placeholder
    const parent = location.hostname;

    // Try to get streamers from the embed cells
    const labels = document.querySelectorAll('.stream-label');
    let channel = '';
    for (const label of labels) {
      if (label.textContent.trim()) {
        channel = label.textContent.trim().toLowerCase();
        break;
      }
    }

    if (!channel) {
      container.innerHTML = '<span class="empty-msg">Waiting for streamer config...</span>';
      chatInitialized = false; // retry later
      return;
    }

    container.innerHTML = '';
    const iframe = document.createElement('iframe');
    iframe.src = `https://www.twitch.tv/embed/${channel}/chat?parent=${parent}&darkpopout`;
    iframe.style.width = '100%';
    iframe.style.height = '100%';
    iframe.style.border = 'none';
    container.appendChild(iframe);
  }

  return { init };
})();

document.addEventListener('DOMContentLoaded', () => App.init());

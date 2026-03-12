// ── DK Rap Chaos — Main Viewer Client ────────────────────────

const App = (() => {
  const WS_URL = (location.protocol === 'https:' ? 'wss' : 'ws') + '://' + location.host;
  let ws;
  let minDonation = 5;
  let takeControlDonationSingle = 1;
  let takeControlDonationAll = 3;
  let dkRapDurationMs = 208000;
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
  let hideOffline = false;
  let focusedStream = null;       // index (0-3) or null
  let hiddenStreams = new Set();   // Set of indices (0-3)

  // ── Init ────────────────────────────────────────────
  async function init() {
    await loadConfig();
    connectWS();
    GamepadController.init(sendInput);
    bindUI();
    initTabs();
    initOfflineToggle();
    initHideNamesToggle();
    initStreamActions();
    DrawCanvas.init((msg) => {
      if (ws && ws.readyState === WebSocket.OPEN) {
        ws.send(JSON.stringify(msg));
      }
    });
    LayoutManager.init();
    GridResizer.init();
    initCountdown();
  }

  // ── Config ──────────────────────────────────────────
  async function loadConfig() {
    try {
      const res = await fetch('/config');
      const cfg = await res.json();
      minDonation = cfg.minDonation || 5;
      takeControlDonationSingle = cfg.takeControlDonationSingle || 1;
      takeControlDonationAll = cfg.takeControlDonationAll || 3;
      dkRapDurationMs = cfg.dkRapDurationMs || 208000;
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
    const TEST_MAX_AMOUNT = 10000;
    const TEST_COOLDOWN_MS = 10000;
    let testLastTrigger = 0;
    let testCooldownInterval = null;

    function testShowStatus(msg, type) {
      const bar = document.getElementById('testStatusBar');
      bar.textContent = msg;
      bar.className = 'status-bar ' + type;
    }

    function testStartCooldown() {
      const btn = document.getElementById('testDkRapBtn');
      testLastTrigger = Date.now();
      btn.disabled = true;
      btn.dataset.origText = btn.textContent;
      if (testCooldownInterval) clearInterval(testCooldownInterval);
      testCooldownInterval = setInterval(() => {
        var left = Math.ceil((TEST_COOLDOWN_MS - (Date.now() - testLastTrigger)) / 1000);
        if (left <= 0) {
          clearInterval(testCooldownInterval);
          testCooldownInterval = null;
          btn.disabled = false;
          btn.textContent = btn.dataset.origText || 'TEST: TRIGGER DK RAP';
        } else {
          btn.textContent = 'COOLDOWN ' + left + 's';
        }
      }, 250);
    }

    document.getElementById('testDkRapBtn').addEventListener('click', () => {
      const name = document.getElementById('testDonorName').value || 'TestViewer';
      const amount = parseFloat(document.getElementById('testAmount').value) || 5;

      // Client-side validation
      if (amount > TEST_MAX_AMOUNT) {
        testShowStatus('Max donation is $' + TEST_MAX_AMOUNT.toLocaleString(), 'error');
        return;
      }
      if (amount < 1) {
        testShowStatus('Minimum amount is $1', 'error');
        return;
      }
      var sinceLast = Date.now() - testLastTrigger;
      if (sinceLast < TEST_COOLDOWN_MS) {
        testShowStatus('Cooldown — wait ' + Math.ceil((TEST_COOLDOWN_MS - sinceLast) / 1000) + 's', 'error');
        return;
      }

      fetch('/trigger', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ donorName: name, amount, secret: 'dkrap2024' })
      })
        .then(r => r.json())
        .then(data => {
          if (data.error) {
            testShowStatus(data.error, 'error');
          } else {
            testShowStatus('DK Rap triggered!', 'success');
            testStartCooldown();
          }
        })
        .catch(err => {
          testShowStatus(err.message, 'error');
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
  // Single button opens CC interact page in a popup
  (function initCCButton() {
    var btn = document.getElementById('ccOpenBtn');
    if (btn) {
      btn.addEventListener('click', function() {
        if (ccInteractUrl) {
          window.open(ccInteractUrl, 'ccPopup', 'width=420,height=700,scrollbars=yes');
        } else {
          // Fallback: try fetching from /cc/effects for the interact URL
          fetch('/cc/effects').then(function(r) { return r.json(); }).then(function(data) {
            if (data.interactUrl) {
              ccInteractUrl = data.interactUrl;
              window.open(ccInteractUrl, 'ccPopup', 'width=420,height=700,scrollbars=yes');
            }
          }).catch(function() {});
        }
      });
    }
  })();

  // ── DK Rap Counter Button ──────────────────────────
  (function initDkRapBtn() {
    var btn = document.getElementById('dkRapBtn');
    if (btn) {
      btn.addEventListener('click', function() {
        // Switch to donate tab
        document.querySelectorAll('.tab-btn').forEach(function(b) { b.classList.remove('active'); });
        var donateTabBtn = document.querySelector('.tab-btn[data-tab="donate"]');
        if (donateTabBtn) donateTabBtn.classList.add('active');
        document.querySelectorAll('.tab-content').forEach(function(c) { c.classList.remove('active'); });
        var donateContent = document.querySelector('.tab-content[data-tab="donate"]');
        if (donateContent) donateContent.classList.add('active');

        // Set effect to DK Rap
        var effectSelect = document.getElementById('effectType');
        if (effectSelect) {
          effectSelect.value = 'dkrap';
          effectSelect.dispatchEvent(new Event('change'));
        }
        // Hide streamer dropdown (not needed for DK Rap)
        var targetField = document.getElementById('controlTargetField');
        if (targetField) targetField.style.display = 'none';
      });
    }
  })();

  // ── FAQ Toggle ──────────────────────────────────────
  (function initFaqToggle() {
    var btn = document.getElementById('faqToggle');
    var faqCard = document.getElementById('faqCard');
    if (btn && faqCard) {
      btn.addEventListener('click', function() {
        faqCard.style.display = 'none';
      });
    }
  })();

  // ── Chaos Log Toggle ────────────────────────────────
  (function initChaosLogToggle() {
    var btn = document.getElementById('chaosLogToggle');
    var content = document.getElementById('chaosLogContent');
    if (btn && content) {
      btn.addEventListener('click', function() {
        var hidden = content.style.display === 'none';
        content.style.display = hidden ? '' : 'none';
        btn.textContent = hidden ? 'Hide' : 'Show';
      });
    }
  })();

  // ── Action Toolbar ──────────────────────────────────
  (function initActionToolbar() {
    let selectedIdx = 0;

    // Click stream overlay to select/highlight
    function selectStream(idx) {
      selectedIdx = idx;
      document.querySelectorAll('.stream-cell').forEach(c => c.classList.remove('highlighted'));
      const cell = document.getElementById('stream-' + idx);
      if (cell) cell.classList.add('highlighted');
    }
    document.querySelectorAll('.stream-click-overlay').forEach(overlay => {
      overlay.addEventListener('click', () => {
        selectStream(parseInt(overlay.dataset.stream, 10));
      });
    });

    // Focus button
    const focusBtn = document.getElementById('toolbarFocus');
    if (focusBtn) {
      focusBtn.addEventListener('click', () => {
        toggleFocus(selectedIdx);
      });
    }

    // Control button
    const controlBtn = document.getElementById('toolbarControl');
    if (controlBtn) {
      controlBtn.addEventListener('click', () => {
        const label = document.querySelector('#stream-' + selectedIdx + ' .stream-label');
        const name = label ? label.textContent.replace(/#\d+\s*[-–]\s*/, '').trim() : '';

        document.querySelectorAll('.tab-btn').forEach(b => b.classList.remove('active'));
        const donateTab = document.querySelector('.tab-btn[data-tab="donate"]');
        if (donateTab) donateTab.classList.add('active');
        document.querySelectorAll('.tab-content').forEach(c => c.classList.remove('active'));
        const donateContent = document.querySelector('.tab-content[data-tab="donate"]');
        if (donateContent) donateContent.classList.add('active');

        const effectSelect = document.getElementById('effectType');
        if (effectSelect) { effectSelect.value = 'control-single'; effectSelect.dispatchEvent(new Event('change')); }
        const targetField = document.getElementById('controlTargetField');
        if (targetField) targetField.style.display = 'block';
        const controlSelect = document.getElementById('controlTarget');
        if (controlSelect && name) { controlSelect.value = name; controlSelect.dispatchEvent(new Event('change')); }
      });
    }

    // CC button
    const ccBtn = document.getElementById('toolbarCC');
    if (ccBtn) {
      ccBtn.addEventListener('click', () => {
        if (ccInteractUrl) {
          window.open(ccInteractUrl, 'ccPopup', 'width=420,height=700,scrollbars=yes');
        } else {
          fetch('/cc/effects').then(r => r.json()).then(data => {
            if (data.interactUrl) { ccInteractUrl = data.interactUrl; window.open(ccInteractUrl, 'ccPopup', 'width=420,height=700,scrollbars=yes'); }
          }).catch(() => {});
        }
      });
    }

    // FAQ button
    const faqBtn = document.getElementById('toolbarFaq');
    if (faqBtn) {
      faqBtn.addEventListener('click', () => {
        const faqCard = document.getElementById('faqCard');
        const content = document.getElementById('faqContent');
        if (faqCard) {
          const isHidden = faqCard.style.display === 'none';
          faqCard.style.display = isHidden ? '' : 'none';
          if (isHidden) {
            // Show card with content expanded
            if (content) content.classList.add('active');
            faqCard.scrollIntoView({ behavior: 'smooth', block: 'start' });
          }
        }
      });
    }

    // DK Rap button
    const dkRapBtn = document.getElementById('toolbarDkRap');
    if (dkRapBtn) {
      dkRapBtn.addEventListener('click', () => {
        document.querySelectorAll('.tab-btn').forEach(b => b.classList.remove('active'));
        const donateTab = document.querySelector('.tab-btn[data-tab="donate"]');
        if (donateTab) donateTab.classList.add('active');
        document.querySelectorAll('.tab-content').forEach(c => c.classList.remove('active'));
        const donateContent = document.querySelector('.tab-content[data-tab="donate"]');
        if (donateContent) donateContent.classList.add('active');

        const effectSelect = document.getElementById('effectType');
        if (effectSelect) { effectSelect.value = 'dkrap'; effectSelect.dispatchEvent(new Event('change')); }
        const targetField = document.getElementById('controlTargetField');
        if (targetField) targetField.style.display = 'none';
      });
    }

    // Gamepad preview button
    const gamepadBtn = document.getElementById('toolbarGamepad');
    if (gamepadBtn) {
      gamepadBtn.addEventListener('click', () => {
        const overlay = document.getElementById('gamepadOverlay');
        if (!overlay) return;
        // Check current state from DOM (avoids boolean desync)
        const isVisible = overlay.classList.contains('preview-mode');
        if (!isVisible) {
          overlay.style.display = 'flex';
          overlay.classList.add('active', 'preview-mode');
          GamepadController.setActive(true);
          document.getElementById('controlTargetName').textContent = 'Preview Mode';
          document.getElementById('controlTimeRemaining').textContent = '--';
          gamepadBtn.classList.add('active');
        } else {
          overlay.style.display = 'none';
          overlay.classList.remove('active', 'preview-mode');
          GamepadController.setActive(false);
          gamepadBtn.classList.remove('active');
        }
      });
    }
  })();

  function onCCStatus(msg) {
    if (msg.interactUrl) {
      ccInteractUrl = msg.interactUrl;
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

        // CC tab just opens popup, doesn't switch tabs
        if (tab === 'cc') {
          if (ccInteractUrl) {
            window.open(ccInteractUrl, 'ccPopup', 'width=420,height=700,scrollbars=yes');
          } else {
            fetch('/cc/effects').then(r => r.json()).then(data => {
              if (data.interactUrl) {
                ccInteractUrl = data.interactUrl;
                window.open(ccInteractUrl, 'ccPopup', 'width=420,height=700,scrollbars=yes');
              }
            }).catch(() => {});
          }
          return;
        }

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

        // Snap col-right height to new tab content
        snapColRightHeight();
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

  // ── Show/Hide Offline Streams Toggle ──────────────
  function initOfflineToggle() {
    // Restore preference from localStorage
    hideOffline = localStorage.getItem('hideOffline') === 'true';
    const btn = document.getElementById('hideOfflineBtn');
    if (!btn) return;

    updateOfflineToggleBtn();
    applyOfflineVisibility();

    // Stop mousedown from bubbling to drag handle — the drag handle
    // creates a fullscreen overlay on mousedown that eats the click event
    btn.addEventListener('mousedown', (e) => {
      e.stopPropagation();
    });

    btn.addEventListener('click', (e) => {
      e.stopPropagation();
      hideOffline = !hideOffline;
      localStorage.setItem('hideOffline', hideOffline);
      updateOfflineToggleBtn();
      applyOfflineVisibility();
    });

    // Listen for stream status changes from Twitch embeds
    window.addEventListener('stream-status-change', () => {
      applyOfflineVisibility();
    });
  }

  function updateOfflineToggleBtn() {
    const btn = document.getElementById('hideOfflineBtn');
    if (!btn) return;
    btn.textContent = hideOffline ? 'Show All' : 'Hide Offline';
    btn.classList.toggle('active', hideOffline);
  }

  function applyOfflineVisibility() {
    const grid = document.querySelector('.streams-grid');
    if (!grid) return;

    const cells = grid.querySelectorAll('.stream-cell');

    cells.forEach((cell, i) => {
      const isOnline = typeof StreamStatus !== 'undefined' && StreamStatus.isOnline(i);
      if (hideOffline && !isOnline) {
        cell.classList.add('offline-hidden');
      } else {
        cell.classList.remove('offline-hidden');
      }
    });

    // Handle "no streams online" message
    if (hideOffline) {
      grid.classList.add('hide-offline-mode');
      const anyVisible = Array.from(cells).some((cell, i) => {
        return !cell.classList.contains('offline-hidden') && !hiddenStreams.has(i);
      });
      if (!anyVisible) {
        if (!grid.querySelector('.no-streams-msg')) {
          const msg = document.createElement('div');
          msg.className = 'no-streams-msg';
          msg.textContent = 'No streams currently online';
          grid.appendChild(msg);
        }
      } else {
        const msg = grid.querySelector('.no-streams-msg');
        if (msg) msg.remove();
      }
    } else {
      grid.classList.remove('hide-offline-mode');
      const msg = grid.querySelector('.no-streams-msg');
      if (msg) msg.remove();
      cells.forEach(cell => cell.classList.remove('offline-hidden'));
    }

    // Delegate layout to unified function
    applyFocusAndHidden();
  }

  // ── Hide Names Toggle ─────────────────────────────
  function initHideNamesToggle() {
    const btn = document.getElementById('hideNamesBtn');
    if (!btn) return;
    const grid = document.querySelector('.streams-grid');
    if (!grid) return;

    let namesHidden = localStorage.getItem('hideNames') === 'true';
    if (namesHidden) {
      grid.classList.add('names-hidden');
      btn.textContent = 'Show Names';
      btn.classList.add('active');
    }

    btn.addEventListener('mousedown', e => e.stopPropagation());
    btn.addEventListener('click', e => {
      e.stopPropagation();
      namesHidden = !namesHidden;
      localStorage.setItem('hideNames', namesHidden);
      grid.classList.toggle('names-hidden', namesHidden);
      btn.textContent = namesHidden ? 'Show Names' : 'Hide Names';
      btn.classList.toggle('active', namesHidden);
    });
  }

  function snapColLeftHeight() {
    const colLeft = document.querySelector('.col-left');
    if (!colLeft) return;
    colLeft.style.height = 'auto';
    if (typeof LayoutManager !== 'undefined' && LayoutManager._updatePanelHeight) {
      LayoutManager._updatePanelHeight('col-left');
    }
  }

  // ── Focus & Hide Stream Actions ───────────────────
  function initStreamActions() {
    // Restore persisted state
    const savedFocus = localStorage.getItem('focusedStream');
    if (savedFocus !== null && savedFocus !== '') {
      focusedStream = parseInt(savedFocus, 10);
      if (isNaN(focusedStream)) focusedStream = null;
    }
    const savedHidden = localStorage.getItem('hiddenStreams');
    if (savedHidden) {
      try { hiddenStreams = new Set(JSON.parse(savedHidden)); }
      catch { hiddenStreams = new Set(); }
    }

    // Bind focus buttons
    document.querySelectorAll('.stream-focus-btn').forEach(btn => {
      btn.addEventListener('mousedown', e => e.stopPropagation());
      btn.addEventListener('click', e => {
        e.stopPropagation();
        toggleFocus(parseInt(btn.dataset.stream, 10));
      });
    });

    // Bind hide buttons
    document.querySelectorAll('.stream-hide-btn').forEach(btn => {
      btn.addEventListener('mousedown', e => e.stopPropagation());
      btn.addEventListener('click', e => {
        e.stopPropagation();
        hideStream(parseInt(btn.dataset.stream, 10));
      });
    });

    // Bind Control buttons
    document.querySelectorAll('.stream-control-btn').forEach(btn => {
      btn.addEventListener('mousedown', e => e.stopPropagation());
      btn.addEventListener('click', e => {
        e.stopPropagation();
        const idx = parseInt(btn.dataset.stream, 10);
        const label = document.querySelector(`#stream-${idx} .stream-label`);
        const streamerName = label ? label.textContent.trim() : '';

        // Switch to donate tab
        document.querySelectorAll('.tab-btn').forEach(b => b.classList.remove('active'));
        const donateTabBtn = document.querySelector('.tab-btn[data-tab="donate"]');
        if (donateTabBtn) donateTabBtn.classList.add('active');
        document.querySelectorAll('.tab-content').forEach(c => c.classList.remove('active'));
        const donateContent = document.querySelector('.tab-content[data-tab="donate"]');
        if (donateContent) donateContent.classList.add('active');

        // Set effect to "control-single" and show streamer dropdown
        const effectSelect = document.getElementById('effectType');
        const targetField = document.getElementById('controlTargetField');
        const controlSelect = document.getElementById('controlTarget');
        if (effectSelect) {
          effectSelect.value = 'control-single';
          effectSelect.dispatchEvent(new Event('change'));
        }
        if (targetField) targetField.style.display = 'block';
        if (controlSelect && streamerName) {
          controlSelect.value = streamerName;
          controlSelect.dispatchEvent(new Event('change'));
        }

        snapColRightHeight();
      });
    });

    // Bind CC buttons
    document.querySelectorAll('.stream-cc-btn').forEach(btn => {
      btn.addEventListener('mousedown', e => e.stopPropagation());
      btn.addEventListener('click', e => {
        e.stopPropagation();
        if (ccInteractUrl) {
          window.open(ccInteractUrl, 'ccPopup', 'width=420,height=700,scrollbars=yes');
        } else {
          fetch('/cc/effects').then(r => r.json()).then(data => {
            if (data.interactUrl) {
              ccInteractUrl = data.interactUrl;
              window.open(ccInteractUrl, 'ccPopup', 'width=420,height=700,scrollbars=yes');
            }
          }).catch(() => {});
        }
      });
    });

    // "Show Hidden" button
    const showBtn = document.getElementById('showHiddenBtn');
    if (showBtn) {
      showBtn.addEventListener('mousedown', e => e.stopPropagation());
      showBtn.addEventListener('click', e => {
        e.stopPropagation();
        unhideAll();
      });
    }

    applyFocusAndHidden();
  }

  function toggleFocus(idx) {
    if (focusedStream === idx) {
      focusedStream = null;
      localStorage.removeItem('focusedStream');
    } else {
      focusedStream = idx;
      localStorage.setItem('focusedStream', String(idx));
    }
    applyFocusAndHidden();
  }

  function hideStream(idx) {
    if (focusedStream === idx) {
      focusedStream = null;
      localStorage.removeItem('focusedStream');
    }
    hiddenStreams.add(idx);
    localStorage.setItem('hiddenStreams', JSON.stringify([...hiddenStreams]));
    applyFocusAndHidden();
  }

  function unhideAll() {
    hiddenStreams.clear();
    localStorage.setItem('hiddenStreams', JSON.stringify([]));
    applyFocusAndHidden();
  }

  function applyFocusAndHidden() {
    const grid = document.querySelector('.streams-grid');
    if (!grid) return;

    const cells = grid.querySelectorAll('.stream-cell');

    // Apply hidden and focused classes
    cells.forEach((cell, i) => {
      cell.classList.toggle('stream-hidden', hiddenStreams.has(i));
      cell.classList.toggle('stream-focused', focusedStream === i);
    });

    // Count truly visible streams
    let visibleCount = 0;
    cells.forEach((cell, i) => {
      if (!hiddenStreams.has(i) && !cell.classList.contains('offline-hidden')) {
        visibleCount++;
      }
    });

    // Apply focus mode or normal grid layout
    if (focusedStream !== null && !hiddenStreams.has(focusedStream)) {
      const focusedCell = document.getElementById('stream-' + focusedStream);
      if (focusedCell && !focusedCell.classList.contains('offline-hidden')) {
        grid.classList.add('focus-mode');
        const sideStreams = visibleCount - 1;
        if (sideStreams === 0) {
          grid.style.gridTemplateColumns = '1fr';
          grid.style.gridTemplateRows = '';
        } else {
          grid.style.gridTemplateColumns = '3fr 1fr';
          grid.style.gridTemplateRows = Array(Math.max(sideStreams, 1)).fill('1fr').join(' ');
        }
      } else {
        // Focused stream not visible — clear focus
        grid.classList.remove('focus-mode');
        grid.style.gridTemplateRows = '';
        focusedStream = null;
        localStorage.removeItem('focusedStream');
        setNormalGridColumns(grid, visibleCount);
      }
    } else {
      grid.classList.remove('focus-mode');
      grid.style.gridTemplateRows = '';
      setNormalGridColumns(grid, visibleCount);
    }

    updateShowHiddenBtn();
    snapColLeftHeight();
    if (typeof GridResizer !== 'undefined' && GridResizer.applyAfterLayout) {
      GridResizer.applyAfterLayout();
    }
    if (typeof DrawCanvas !== 'undefined' && DrawCanvas.resizeCanvas) {
      setTimeout(() => DrawCanvas.resizeCanvas(), 50);
    }
  }

  function setNormalGridColumns(grid, count) {
    if (hiddenStreams.size > 0 || hideOffline) {
      grid.style.gridTemplateColumns = count <= 1 ? '1fr' : '1fr 1fr';
    } else {
      grid.style.gridTemplateColumns = '';
    }
  }

  function updateShowHiddenBtn() {
    const btn = document.getElementById('showHiddenBtn');
    if (!btn) return;
    const count = hiddenStreams.size;
    if (count > 0) {
      btn.style.display = '';
      btn.textContent = 'Show Hidden (' + count + ')';
    } else {
      btn.style.display = 'none';
    }
  }

  function snapColRightHeight() {
    const colRight = document.querySelector('.col-right');
    if (!colRight) return;
    // Reset explicit height so the panel fits the active tab's content
    colRight.style.height = 'auto';
    if (typeof LayoutManager !== 'undefined' && LayoutManager._updatePanelHeight) {
      LayoutManager._updatePanelHeight('col-right');
    }
  }

  // ── Event Countdown ─────────────────────────────────
  function initCountdown() {
    // Event: Monday 23 March 2026, 7:30 AM AEDT (UTC+11)
    const EVENT_TIME = new Date('2026-03-23T07:30:00+11:00').getTime();

    const container = document.getElementById('eventCountdown');
    const timerEl = document.getElementById('countdownTimer');
    const localEl = document.getElementById('countdownLocal');
    if (!container || !timerEl) return;

    // Show the event time in the viewer's local timezone
    const eventDate = new Date(EVENT_TIME);
    const localStr = eventDate.toLocaleString(undefined, {
      weekday: 'short', month: 'short', day: 'numeric',
      hour: 'numeric', minute: '2-digit', hour12: true,
      timeZoneName: 'short'
    });
    if (localEl) localEl.textContent = '(' + localStr + ')';

    function tick() {
      var diff = EVENT_TIME - Date.now();
      if (diff <= 0) {
        timerEl.textContent = 'LIVE NOW!';
        if (localEl) localEl.textContent = '';
        container.classList.add('event-live');
        return;
      }
      var d = Math.floor(diff / 86400000);
      var h = Math.floor((diff % 86400000) / 3600000);
      var m = Math.floor((diff % 3600000) / 60000);
      var s = Math.floor((diff % 60000) / 1000);
      timerEl.textContent =
        (d > 0 ? d + 'd ' : '') +
        (d > 0 || h > 0 ? h + 'h ' : '') +
        m + 'm ' + s + 's';
    }

    tick();
    setInterval(tick, 1000);
  }

  return { init };
})();

document.addEventListener('DOMContentLoaded', () => App.init());

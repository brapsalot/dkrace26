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
  let configStreamersData = [];   // stored from loadConfig for mode switching
  let configParentDomains = ['localhost'];
  let currentMode = 'dkrace';     // 'dkrace' or 'ruff'

  // ── Theme & Font Presets ────────────────────────────────────
  const THEME_PRESETS = {
    'dk-classic': {
      label: 'DK Classic', swatch: '#FFD700',
      '--yellow': '#FFD700', '--dark-yellow': '#C8A400',
      '--brown': '#8B4513', '--dark-brown': '#3D1A00',
      '--bg': '#1A0A00', '--card': '#2A1500', '--border': '#5C3010'
    },
    'jungle-green': {
      label: 'Jungle Green', swatch: '#7CFC00',
      '--yellow': '#7CFC00', '--dark-yellow': '#32CD32',
      '--brown': '#2E7D32', '--dark-brown': '#1B5E20',
      '--bg': '#0A1A00', '--card': '#153015', '--border': '#388E3C'
    },
    'ocean-blue': {
      label: 'Ocean Blue', swatch: '#4FC3F7',
      '--yellow': '#4FC3F7', '--dark-yellow': '#0288D1',
      '--brown': '#1565C0', '--dark-brown': '#0D47A1',
      '--bg': '#0A0A1A', '--card': '#152030', '--border': '#1E88E5'
    },
    'lava-red': {
      label: 'Lava Red', swatch: '#FF6E40',
      '--yellow': '#FF6E40', '--dark-yellow': '#E64A19',
      '--brown': '#BF360C', '--dark-brown': '#4E1500',
      '--bg': '#1A0A0A', '--card': '#2A1515', '--border': '#D84315'
    },
    'royal-purple': {
      label: 'Royal Purple', swatch: '#CE93D8',
      '--yellow': '#CE93D8', '--dark-yellow': '#AB47BC',
      '--brown': '#7B1FA2', '--dark-brown': '#4A148C',
      '--bg': '#12001A', '--card': '#1E0A2A', '--border': '#8E24AA'
    },
    'midnight': {
      label: 'Midnight', swatch: '#B0BEC5',
      '--yellow': '#B0BEC5', '--dark-yellow': '#78909C',
      '--brown': '#455A64', '--dark-brown': '#263238',
      '--bg': '#0A0E14', '--card': '#1A2030', '--border': '#37474F'
    }
  };

  const FONT_OPTIONS = [
    { value: "'Press Start 2P', monospace", label: 'Press Start 2P', url: null },
    { value: "'VT323', monospace", label: 'VT323', url: 'VT323' },
    { value: "'Silkscreen', monospace", label: 'Silkscreen', url: 'Silkscreen' },
    { value: "'Inter', sans-serif", label: 'Inter', url: null },
    { value: "'Orbitron', sans-serif", label: 'Orbitron', url: 'Orbitron:wght@400;700' }
  ];

  // Piano session state
  let pianoSessionId = null;
  let pianoExpiresAt = null;
  let pianoDurationMs = 60000;
  let pianoTimerInterval = null;

  // ── Init ────────────────────────────────────────────
  async function init() {
    await loadConfig();
    connectWS();
    GamepadController.init(sendInput);
    PianoController.init(sendPianoNote);
    buildPianoKeyboard();
    bindUI();
    initTabs();
    initOfflineToggle();
    initHideNamesToggle();
    initStreamActions();
    initModeToggle();
    initSidebarToggle();
    DrawCanvas.init((msg) => {
      if (ws && ws.readyState === WebSocket.OPEN) {
        ws.send(JSON.stringify(msg));
      }
    });
    LayoutManager.init();
    GridResizer.init();
    initCountdown();
    initSettings();
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
      configParentDomains = cfg.twitchParentDomains || ['localhost'];
      if (cfg.streamers && cfg.streamers.length > 0) {
        configStreamersData = cfg.streamers;
        initTwitchEmbeds(cfg.streamers, configParentDomains);
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
          // Trigger sidebar minigame in DK Race mode
          if (currentMode === 'dkrace') {
            showSidebarRapGame(msg.donorName, msg.durationMs, msg.towTarget, msg.tetrisLineTarget);
          }
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

        case 'RUFF_RAP':
          if (currentMode === 'ruff') {
            showRuffRapOverlay(msg.triggerName, msg.durationMs, msg.towTarget, msg.tetrisLineTarget);
          } else {
            showSidebarRapGame(msg.triggerName, msg.durationMs, msg.towTarget, msg.tetrisLineTarget);
          }
          break;

        case 'RUFF_RAP_TOW_UPDATE':
          updateTowProgress(msg.score, msg.target);
          break;

        case 'RUFF_RAP_TETRIS_UPDATE':
          updateTetrisProgress(msg.lines, msg.target);
          break;

        case 'RUFF_RAP_SKIPPED':
          onRuffRapSkipped();
          break;

        case 'RUFF_RAP_LOCKED':
          onRuffRapLocked();
          break;

        case 'PIANO_GRANTED':
          onPianoGranted(msg);
          break;

        case 'PIANO_ENDED':
          onPianoEnded();
          break;

        case 'PIANO_NOTE':
          // Remote note from another viewer or the player
          if (msg.action === 'on') PianoController.playNote(msg.note);
          else PianoController.stopNote(msg.note);
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

    document.getElementById('testPianoBtn').addEventListener('click', () => {
      const name = document.getElementById('testDonorName').value || 'TestViewer';
      const amount = parseFloat(document.getElementById('testAmount').value) || 10;
      if (ws && ws.readyState === WebSocket.OPEN) {
        ws.send(JSON.stringify({
          type: 'REQUEST_PIANO',
          donorName: name,
          amount
        }));
        const bar = document.getElementById('testStatusBar');
        bar.textContent = 'Piano session requested...';
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
    if (effect !== 'control-single' && effect !== 'control-all' && effect !== 'piano') {
      claimCode = null;
      updateDonateMessage();
      return;
    }
    claimCode = generateClaimCode();
    let target;
    if (effect === 'piano') target = 'PIANO';
    else if (effect === 'control-all') target = 'ALL';
    else target = document.getElementById('controlTarget').value;
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
    } else if (effect === 'piano') {
      const code = claimCode ? `:${claimCode}` : '';
      msgEl.textContent = `PIANO${code}`;
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
  let dkRapBannerActive = false;

  function showDKRapBanner(donorName, amount) {
    const overlay = document.getElementById('dkRapOverlay');
    overlay.classList.add('active');
    document.body.classList.add('dk-rap-active');
    dkRapBannerActive = true;
    overlay.querySelector('.overlay-donor').textContent = `${donorName} donated $${amount}`;

    const timerEl = overlay.querySelector('.overlay-timer');
    const endTime = Date.now() + dkRapDurationMs;

    function tick() {
      if (!dkRapBannerActive) return;
      const remaining = endTime - Date.now();
      if (remaining <= 0) {
        dismissDKRapBanner();
        return;
      }
      const mins = Math.floor(remaining / 60000);
      const secs = Math.floor((remaining % 60000) / 1000);
      timerEl.textContent = `${mins}:${secs.toString().padStart(2, '0')}`;
      requestAnimationFrame(tick);
    }
    requestAnimationFrame(tick);
  }

  function dismissDKRapBanner() {
    dkRapBannerActive = false;
    const overlay = document.getElementById('dkRapOverlay');
    if (overlay) overlay.classList.remove('active');
    document.body.classList.remove('dk-rap-active');
    dismissSidebarRapGame();
  }

  // ── Ruff Mode DK Rap (full-screen overlay + video/audio + skip) ─
  let ruffRapTickActive = false;

  function showRuffRapOverlay(triggerName, durationMs, towTarget, tetrisLineTarget) {
    const overlay = document.getElementById('ruffRapOverlay');
    if (!overlay) return;

    const dur = durationMs || dkRapDurationMs;
    overlay.classList.add('active');
    ruffRapTickActive = true;
    document.getElementById('ruffRapTrigger').textContent = (triggerName || 'A viewer') + ' triggered the DK Rap!';

    // Reset tug-of-war
    updateTowProgress(0, towTarget || 500);
    const towStatus = document.getElementById('towStatus');
    if (towStatus) towStatus.textContent = '';

    // Re-enable buttons
    const skipBtn = document.getElementById('ruffSkipBtn');
    const keepBtn = document.getElementById('ruffKeepBtn');
    if (skipBtn) skipBtn.disabled = false;
    if (keepBtn) keepBtn.disabled = false;

    // Reset and start tetris progress
    updateTetrisProgress(0, tetrisLineTarget || 40);
    RapTetris.init((linesCleared) => {
      if (ws && ws.readyState === WebSocket.OPEN) {
        ws.send(JSON.stringify({ type: 'RUFF_RAP_TETRIS_LINES', lines: linesCleared }));
      }
    });

    // Play DK Rap video
    const video = document.getElementById('ruffRapVideo');
    if (video) {
      video.muted = false;
      video.volume = 0.7;
      video.currentTime = 0;
      video.play().catch(() => {
        console.warn('DK Rap video autoplay blocked');
      });
    }

    // Bind skip button
    if (skipBtn) {
      skipBtn.onclick = () => {
        if (ws && ws.readyState === WebSocket.OPEN) {
          ws.send(JSON.stringify({ type: 'RUFF_RAP_SKIP_CLICK' }));
        }
      };
    }

    // Bind keep button
    if (keepBtn) {
      keepBtn.onclick = () => {
        if (ws && ws.readyState === WebSocket.OPEN) {
          ws.send(JSON.stringify({ type: 'RUFF_RAP_KEEP_CLICK' }));
        }
      };
    }

    const timerEl = document.getElementById('ruffRapTimer');
    const endTime = Date.now() + dur;

    function tick() {
      if (!ruffRapTickActive) return;
      const remaining = endTime - Date.now();
      if (remaining <= 0) {
        dismissRuffRap();
        return;
      }
      const mins = Math.floor(remaining / 60000);
      const secs = Math.floor((remaining % 60000) / 1000);
      timerEl.textContent = `${mins}:${secs.toString().padStart(2, '0')}`;
      requestAnimationFrame(tick);
    }
    requestAnimationFrame(tick);
  }

  function dismissRuffRap() {
    ruffRapTickActive = false;
    const overlay = document.getElementById('ruffRapOverlay');
    if (overlay) overlay.classList.remove('active');
    const video = document.getElementById('ruffRapVideo');
    if (video) { video.pause(); video.muted = true; }
    RapTetris.stop();
  }

  // ── Sidebar Rap Game (DK Race mode) ────────────────────────
  let sidebarRapActive = false;
  let sidebarRapTickActive = false;

  function showSidebarRapGame(triggerName, durationMs, towTarget, tetrisLineTarget) {
    const game = document.getElementById('sidebarRapGame');
    const chatEmbed = document.getElementById('chatEmbed');
    if (!game) return;

    sidebarRapActive = true;
    sidebarRapTickActive = true;

    // Switch to chat tab if not already
    document.querySelectorAll('.tab-btn').forEach(b => b.classList.remove('active'));
    const chatTab = document.querySelector('.tab-btn[data-tab="chat"]');
    if (chatTab) chatTab.classList.add('active');
    document.querySelectorAll('.tab-content').forEach(c => c.classList.remove('active'));
    const chatContent = document.getElementById('tabChat');
    if (chatContent) chatContent.classList.add('active');

    // Hide chat, show game
    if (chatEmbed) chatEmbed.style.display = 'none';
    game.style.display = 'flex';

    // Reset tug-of-war
    updateTowProgress(0, towTarget || 500);
    const sbStatus = document.getElementById('sbTowStatus');
    if (sbStatus) sbStatus.textContent = '';

    // Enable buttons
    const skipBtn = document.getElementById('sbSkipBtn');
    const keepBtn = document.getElementById('sbKeepBtn');
    if (skipBtn) skipBtn.disabled = false;
    if (keepBtn) keepBtn.disabled = false;

    // Bind skip/keep buttons
    if (skipBtn) {
      skipBtn.onclick = () => {
        if (ws && ws.readyState === WebSocket.OPEN) {
          ws.send(JSON.stringify({ type: 'RUFF_RAP_SKIP_CLICK' }));
        }
      };
    }
    if (keepBtn) {
      keepBtn.onclick = () => {
        if (ws && ws.readyState === WebSocket.OPEN) {
          ws.send(JSON.stringify({ type: 'RUFF_RAP_KEEP_CLICK' }));
        }
      };
    }

    // Reset and start tetris
    updateTetrisProgress(0, tetrisLineTarget || 40);
    SidebarTetris.init((linesCleared) => {
      if (ws && ws.readyState === WebSocket.OPEN) {
        ws.send(JSON.stringify({ type: 'RUFF_RAP_TETRIS_LINES', lines: linesCleared }));
      }
    });
  }

  function dismissSidebarRapGame() {
    sidebarRapActive = false;
    sidebarRapTickActive = false;
    SidebarTetris.stop();
    const game = document.getElementById('sidebarRapGame');
    const chatEmbed = document.getElementById('chatEmbed');
    if (game) game.style.display = 'none';
    if (chatEmbed) chatEmbed.style.display = '';
  }

  function updateTowProgress(score, target) {
    const tgt = target || 500;
    const pct = 50 - (score / tgt) * 50;
    const skipW = (score > 0 ? (score / tgt) * 50 : 0) + '%';
    const keepW = (score < 0 ? (-score / tgt) * 50 : 0) + '%';
    const abs = Math.abs(score);
    const txt = score > 0 ? 'Skip +' + abs : score < 0 ? 'Keep +' + abs : 'Even';
    const clr = score > 0 ? '#00f0f0' : score < 0 ? '#ff5252' : '#fff';

    // Update both overlay and sidebar elements
    ['', 'sb'].forEach(prefix => {
      const divider = document.getElementById(prefix ? 'sbTowDivider' : 'towDivider');
      const fillSkip = document.getElementById(prefix ? 'sbTowFillSkip' : 'towFillSkip');
      const fillKeep = document.getElementById(prefix ? 'sbTowFillKeep' : 'towFillKeep');
      const scoreEl = document.getElementById(prefix ? 'sbTowScore' : 'towScore');
      if (divider) divider.style.left = pct + '%';
      if (fillSkip) fillSkip.style.width = skipW;
      if (fillKeep) fillKeep.style.width = keepW;
      if (scoreEl) { scoreEl.textContent = txt; scoreEl.style.color = clr; }
    });
  }

  function onRuffRapLocked() {
    // Update both overlay and sidebar
    [['ruffSkipBtn', 'ruffKeepBtn', 'towStatus'], ['sbSkipBtn', 'sbKeepBtn', 'sbTowStatus']].forEach(([skipId, keepId, statusId]) => {
      const skipBtn = document.getElementById(skipId);
      const keepBtn = document.getElementById(keepId);
      const towStatus = document.getElementById(statusId);
      if (skipBtn) skipBtn.disabled = true;
      if (keepBtn) keepBtn.disabled = true;
      if (towStatus) { towStatus.textContent = 'KEEP WINS!'; towStatus.style.color = '#ff5252'; }
    });
  }

  function updateTetrisProgress(lines, target) {
    const pct = Math.min(100, (lines / target) * 100) + '%';
    const txt = lines + ' / ' + target;

    // Update overlay elements
    const fill = document.getElementById('rapTetrisProgressFill');
    const text = document.getElementById('rapTetrisLinesText');
    if (fill) fill.style.width = pct;
    if (text) text.textContent = txt;

    // Update sidebar elements
    const sbFill = document.getElementById('sbTetrisProgressFill');
    const sbText = document.getElementById('sbTetrisLinesText');
    if (sbFill) sbFill.style.width = pct;
    if (sbText) sbText.textContent = txt;

    // Update header text with dynamic target
    const header = document.getElementById('sbTetrisHeader');
    if (header) header.textContent = 'CLEAR ' + target + ' LINES TO SKIP!';
    // Also update overlay header if it exists
    const ovHeader = document.querySelector('.ruff-rap-right h3');
    if (ovHeader) ovHeader.textContent = 'CLEAR ' + target + ' LINES TO SKIP!';
  }

  function onRuffRapSkipped() {
    dismissRuffRap();
    dismissSidebarRapGame();
    dismissDKRapBanner();
    // Brief "SKIPPED!" flash (Ruff overlay)
    const overlay = document.getElementById('ruffRapOverlay');
    if (overlay) {
      overlay.classList.add('active');
      const title = overlay.querySelector('.ruff-rap-title');
      const prevText = title ? title.textContent : '';
      if (title) title.textContent = 'SKIPPED!';
      setTimeout(() => {
        overlay.classList.remove('active');
        if (title) title.textContent = prevText;
      }, 1500);
    }
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

  // ── Piano Session ─────────────────────────────────
  function buildPianoKeyboard() {
    const keyboard = document.getElementById('pianoKeyboard');
    if (!keyboard) return;
    const notes = PianoController.getNotes();
    keyboard.innerHTML = '';
    notes.forEach(n => {
      const key = document.createElement('button');
      key.className = 'piano-key ' + n.type;
      key.setAttribute('data-note', n.note);
      key.textContent = n.note.replace('#', '#');
      keyboard.appendChild(key);
    });
  }

  function sendPianoNote(msg) {
    if (!ws || ws.readyState !== WebSocket.OPEN) return;
    ws.send(JSON.stringify({
      type: 'PIANO_NOTE',
      sessionId: pianoSessionId || null,
      note: msg.note,
      action: msg.action
    }));
  }

  function onPianoGranted(msg) {
    pianoSessionId = msg.sessionId;
    pianoExpiresAt = msg.expiresAt;
    pianoDurationMs = msg.durationMs || 60000;

    const overlay = document.getElementById('pianoOverlay');
    overlay.style.display = 'flex';
    overlay.classList.add('active');
    overlay.classList.remove('preview-mode');

    PianoController.setActive(true);

    // Start timer
    updatePianoTimer();
    pianoTimerInterval = setInterval(updatePianoTimer, 100);

    addLog('Viewer', null, 'piano', 'Piano Time!');
  }

  function updatePianoTimer() {
    if (!pianoExpiresAt) return;
    const remaining = Math.max(0, pianoExpiresAt - Date.now());
    const secs = (remaining / 1000).toFixed(1);
    document.getElementById('pianoTimeRemaining').textContent = `${secs}s`;

    const fill = document.getElementById('pianoTimerFill');
    fill.style.width = (remaining / pianoDurationMs * 100) + '%';

    if (remaining <= 0) onPianoEnded();
  }

  function onPianoEnded() {
    pianoSessionId = null;
    pianoExpiresAt = null;
    if (pianoTimerInterval) {
      clearInterval(pianoTimerInterval);
      pianoTimerInterval = null;
    }

    PianoController.setActive(false);

    const overlay = document.getElementById('pianoOverlay');
    overlay.style.display = 'none';
    overlay.classList.remove('active');

    const pianoBtn = document.getElementById('toolbarPiano');
    if (pianoBtn) pianoBtn.classList.remove('active');
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
    let selectedIdx = null;

    function updateFocusBtnState() {
      const focusBtn = document.getElementById('toolbarFocus');
      if (!focusBtn) return;
      if (selectedIdx !== null) {
        focusBtn.disabled = false;
        focusBtn.classList.remove('toolbar-disabled');
      } else {
        focusBtn.disabled = true;
        focusBtn.classList.add('toolbar-disabled');
      }
    }

    // Click stream overlay to highlight. Click highlighted stream again to deselect.
    // When deselected, all overlays become transparent (pointer-events:none) so iframes are interactive.
    // Clicking any stream label re-enables overlays for selection.
    function selectStream(idx) {
      if (selectedIdx === idx) {
        // Deselect: un-highlight all and disable all overlays for iframe interaction
        selectedIdx = null;
        document.querySelectorAll('.stream-cell').forEach(c => c.classList.remove('highlighted'));
        document.querySelectorAll('.stream-click-overlay').forEach(o => {
          o.style.pointerEvents = 'none';
        });
        updateFocusBtnState();
        return;
      }
      selectedIdx = idx;
      document.querySelectorAll('.stream-cell').forEach(c => c.classList.remove('highlighted'));
      // Keep all overlays active (clickable) so user can switch or deselect
      document.querySelectorAll('.stream-click-overlay').forEach(o => {
        o.style.pointerEvents = '';
      });
      const cell = document.getElementById('stream-' + idx);
      if (cell) cell.classList.add('highlighted');
      updateFocusBtnState();
    }

    // Re-enable overlays when clicking stream labels (in case overlays are disabled)
    document.querySelectorAll('.stream-label').forEach(label => {
      label.style.pointerEvents = 'auto';
      label.style.cursor = 'pointer';
      label.addEventListener('click', () => {
        // Re-enable all overlays
        document.querySelectorAll('.stream-click-overlay').forEach(o => {
          o.style.pointerEvents = '';
        });
        const cell = label.closest('.stream-cell');
        if (cell) {
          const idx = parseInt(cell.id.replace('stream-', ''), 10);
          selectStream(idx);
        }
      });
    });

    document.querySelectorAll('.stream-click-overlay').forEach(overlay => {
      overlay.addEventListener('click', () => {
        selectStream(parseInt(overlay.dataset.stream, 10));
      });
    });

    // Highlight button - cycles through streams 0→1→2→3→deselect→0→...
    const highlightBtn = document.getElementById('toolbarHighlight');
    if (highlightBtn) {
      highlightBtn.addEventListener('click', () => {
        const totalStreams = document.querySelectorAll('.stream-cell').length;
        if (selectedIdx === null) {
          selectStream(0);
        } else if (selectedIdx >= totalStreams - 1) {
          // Past last stream → deselect
          selectStream(selectedIdx); // toggle off (same idx deselects)
        } else {
          selectStream(selectedIdx + 1);
        }
      });
    }

    // Focus button - only works when a stream is highlighted
    const focusBtn = document.getElementById('toolbarFocus');
    if (focusBtn) {
      focusBtn.addEventListener('click', () => {
        if (selectedIdx === null) return;
        toggleFocus(selectedIdx);
      });
    }

    // Control button
    const controlBtn = document.getElementById('toolbarControl');
    if (controlBtn) {
      controlBtn.addEventListener('click', () => {
        // Switch to donate tab
        document.querySelectorAll('.tab-btn').forEach(b => b.classList.remove('active'));
        const donateTab = document.querySelector('.tab-btn[data-tab="donate"]');
        if (donateTab) donateTab.classList.add('active');
        document.querySelectorAll('.tab-content').forEach(c => c.classList.remove('active'));
        const donateContent = document.querySelector('.tab-content[data-tab="donate"]');
        if (donateContent) donateContent.classList.add('active');

        const effectSelect = document.getElementById('effectType');
        if (selectedIdx !== null) {
          // Stream highlighted → control that single streamer
          const label = document.querySelector('#stream-' + selectedIdx + ' .stream-label');
          const name = label ? label.textContent.replace(/#\d+\s*[-–]\s*/, '').trim() : '';
          if (effectSelect) { effectSelect.value = 'control-single'; effectSelect.dispatchEvent(new Event('change')); }
          const targetField = document.getElementById('controlTargetField');
          if (targetField) targetField.style.display = 'block';
          const controlSelect = document.getElementById('controlTarget');
          if (controlSelect && name) { controlSelect.value = name; controlSelect.dispatchEvent(new Event('change')); }
        } else {
          // No stream highlighted → control all streamers
          if (effectSelect) { effectSelect.value = 'control-all'; effectSelect.dispatchEvent(new Event('change')); }
          const targetField = document.getElementById('controlTargetField');
          if (targetField) targetField.style.display = 'none';
        }
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

    // Piano preview button
    const pianoBtn = document.getElementById('toolbarPiano');
    if (pianoBtn) {
      pianoBtn.addEventListener('click', () => {
        const overlay = document.getElementById('pianoOverlay');
        if (!overlay) return;
        const isVisible = overlay.classList.contains('preview-mode');
        if (!isVisible) {
          overlay.style.display = 'flex';
          overlay.classList.add('active', 'preview-mode');
          PianoController.setActive(true);
          document.getElementById('pianoTimeRemaining').textContent = '--';
          pianoBtn.classList.add('active');
        } else {
          overlay.style.display = 'none';
          overlay.classList.remove('active', 'preview-mode');
          PianoController.setActive(false);
          pianoBtn.classList.remove('active');
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

  // ── Mode Toggle (DK Race / Ruff) ──────────────────
  function initModeToggle() {
    const btn = document.getElementById('modeToggleBtn');
    if (!btn) return;

    btn.addEventListener('click', () => {
      if (currentMode === 'dkrace') {
        switchToRuffMode();
      } else {
        switchToDKRaceMode();
      }
    });

    // Ruff Rap button — free DK Rap trigger in Ruff mode
    const ruffRapBtn = document.getElementById('ruffRapBtn');
    if (ruffRapBtn) {
      ruffRapBtn.addEventListener('click', () => {
        fetch('/ruff-rap', {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ triggerName: 'A viewer' })
        }).then(r => r.json()).then(data => {
          if (data.error) showStatus(data.error, 'error');
        }).catch(() => {});
      });
    }

    // Ruff Tetris button
    const ruffTetrisBtn = document.getElementById('ruffTetrisBtn');
    if (ruffTetrisBtn) {
      ruffTetrisBtn.addEventListener('click', () => {
        Tetris.init(() => {
          // on close callback — nothing special needed
        });
      });
    }
  }

  function switchToRuffMode() {
    currentMode = 'ruff';
    const btn = document.getElementById('modeToggleBtn');
    const grid = document.querySelector('.streams-grid');
    const toolbar = document.getElementById('actionToolbar');

    btn.textContent = 'Ruff Mode';
    btn.classList.add('ruff-mode');
    document.body.classList.add('ruff-mode-active');

    // Clear any focus mode
    if (focusedStream !== null) {
      toggleFocus(focusedStream);
    }

    // Add ruff-mode class to grid (hides all cells, shows ruff-active)
    grid.classList.add('ruff-mode');

    // Hide action toolbar, show Ruff buttons
    if (toolbar) toolbar.style.display = 'none';
    const ruffRapBtn = document.getElementById('ruffRapBtn');
    if (ruffRapBtn) ruffRapBtn.style.display = '';
    const ruffTetrisBtn = document.getElementById('ruffTetrisBtn');
    if (ruffTetrisBtn) ruffTetrisBtn.style.display = '';

    // Clear stream-0 embed and replace with ruff_stuff_tv
    const embedDiv = document.getElementById('stream-embed-0');
    if (embedDiv) {
      embedDiv.innerHTML = '';
      const cell = document.getElementById('stream-0');
      if (cell) {
        cell.classList.add('ruff-active');
        cell.classList.remove('highlighted');
        const label = cell.querySelector('.stream-label');
        if (label) label.textContent = 'Ruff';
      }

      if (window.Twitch && window.Twitch.Embed) {
        new Twitch.Embed('stream-embed-0', {
          width: '100%',
          height: '100%',
          channel: 'ruff_stuff_tv',
          layout: 'video',
          parent: configParentDomains,
          muted: false
        });
      }
    }
  }

  function switchToDKRaceMode() {
    currentMode = 'dkrace';
    const btn = document.getElementById('modeToggleBtn');
    const grid = document.querySelector('.streams-grid');
    const toolbar = document.getElementById('actionToolbar');

    btn.textContent = 'DK Race';
    btn.classList.remove('ruff-mode');
    document.body.classList.remove('ruff-mode-active');

    // Remove ruff-mode class
    grid.classList.remove('ruff-mode');
    const cell0 = document.getElementById('stream-0');
    if (cell0) cell0.classList.remove('ruff-active');

    // Show action toolbar, hide Ruff buttons
    if (toolbar) toolbar.style.display = '';
    const ruffRapBtn = document.getElementById('ruffRapBtn');
    if (ruffRapBtn) ruffRapBtn.style.display = 'none';
    const ruffTetrisBtn = document.getElementById('ruffTetrisBtn');
    if (ruffTetrisBtn) ruffTetrisBtn.style.display = 'none';

    // Rebuild all 4 stream embeds
    for (let i = 0; i < 4; i++) {
      const embedDiv = document.getElementById('stream-embed-' + i);
      if (embedDiv) embedDiv.innerHTML = '';
    }
    if (configStreamersData.length > 0) {
      initTwitchEmbeds(configStreamersData, configParentDomains);
    }
  }

  // ── Sidebar Toggle ─────────────────────────────────
  let savedColLeftStyles = null;
  function initSidebarToggle() {
    const hideBtn = document.getElementById('hideChatBtn');
    const showBtn = document.getElementById('showChatBtn');
    const colRight = document.querySelector('.col-right');
    const colLeft = document.querySelector('.col-left');
    const mainLayout = document.querySelector('.main-layout');
    if (!hideBtn || !showBtn || !colRight || !colLeft || !mainLayout) return;

    hideBtn.addEventListener('click', () => {
      // Save current col-left inline styles for restore
      savedColLeftStyles = {
        width: colLeft.style.width,
        height: colLeft.style.height,
        flex: colLeft.style.flex,
        maxWidth: colLeft.style.maxWidth
      };

      colRight.style.display = 'none';

      // Expand col-left to fill available space
      if (mainLayout.classList.contains('custom-layout')) {
        const mainRect = mainLayout.getBoundingClientRect();
        colLeft.style.width = (mainRect.width - 32) + 'px';
        colLeft.style.height = 'auto';
      } else {
        colLeft.style.flex = '1';
        colLeft.style.maxWidth = '100%';
      }

      showBtn.style.display = '';

      if (typeof DrawCanvas !== 'undefined') {
        setTimeout(() => DrawCanvas.resizeCanvas(), 50);
      }
    });

    showBtn.addEventListener('click', () => {
      colRight.style.display = '';

      // Restore col-left dimensions
      if (savedColLeftStyles) {
        colLeft.style.width = savedColLeftStyles.width;
        colLeft.style.height = savedColLeftStyles.height;
        colLeft.style.flex = savedColLeftStyles.flex;
        colLeft.style.maxWidth = savedColLeftStyles.maxWidth;
      }

      showBtn.style.display = 'none';

      if (typeof DrawCanvas !== 'undefined') {
        setTimeout(() => DrawCanvas.resizeCanvas(), 50);
      }
    });
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

  // ── Settings (Theme & Font) ─────────────────────────────────
  function applyTheme(themeId) {
    const preset = THEME_PRESETS[themeId];
    if (!preset) return;
    const root = document.documentElement;
    Object.keys(preset).forEach(key => {
      if (key.startsWith('--')) root.style.setProperty(key, preset[key]);
    });
    localStorage.setItem('dkrace-theme', themeId);
    document.querySelectorAll('.theme-swatch').forEach(el => {
      el.classList.toggle('active', el.dataset.theme === themeId);
    });
  }

  function applyFont(fontIndex) {
    const font = FONT_OPTIONS[fontIndex];
    if (!font) return;
    if (font.url && !document.querySelector(`link[data-font="${font.url}"]`)) {
      const link = document.createElement('link');
      link.rel = 'stylesheet';
      link.href = `https://fonts.googleapis.com/css2?family=${font.url}&display=swap`;
      link.dataset.font = font.url;
      document.head.appendChild(link);
    }
    document.documentElement.style.setProperty('--heading-font', font.value);
    localStorage.setItem('dkrace-font', String(fontIndex));
    const sel = document.getElementById('fontSelect');
    if (sel) sel.value = fontIndex;
  }

  function applyFontSize(pct) {
    const scale = pct / 100;
    document.documentElement.style.setProperty('--font-scale', String(scale));
    document.documentElement.style.fontSize = (16 * scale) + 'px';
    localStorage.setItem('dkrace-font-size', String(pct));
    const slider = document.getElementById('fontSizeSlider');
    const valEl = document.getElementById('fontSizeVal');
    if (slider) slider.value = pct;
    if (valEl) valEl.textContent = pct + '%';
  }

  function initSettings() {
    const gearBtn = document.getElementById('settingsGearBtn');
    const dropdown = document.getElementById('settingsDropdown');
    const swatchesEl = document.getElementById('themeSwatches');
    const fontSel = document.getElementById('fontSelect');
    const resetBtn = document.getElementById('settingsResetBtn');
    if (!gearBtn || !dropdown) return;

    // Build theme swatches
    Object.keys(THEME_PRESETS).forEach(id => {
      const preset = THEME_PRESETS[id];
      const btn = document.createElement('button');
      btn.className = 'theme-swatch';
      btn.dataset.theme = id;
      btn.title = preset.label;
      btn.style.background = preset.swatch;
      btn.addEventListener('click', () => applyTheme(id));
      swatchesEl.appendChild(btn);
    });

    // Build font select
    FONT_OPTIONS.forEach((f, i) => {
      const opt = document.createElement('option');
      opt.value = i;
      opt.textContent = f.label;
      fontSel.appendChild(opt);
    });
    fontSel.addEventListener('change', () => applyFont(Number(fontSel.value)));

    // Font size slider
    const fontSizeSlider = document.getElementById('fontSizeSlider');
    if (fontSizeSlider) {
      fontSizeSlider.addEventListener('input', () => applyFontSize(Number(fontSizeSlider.value)));
    }

    // Reset button
    resetBtn.addEventListener('click', () => {
      localStorage.removeItem('dkrace-theme');
      localStorage.removeItem('dkrace-font');
      localStorage.removeItem('dkrace-font-size');
      applyTheme('dk-classic');
      applyFont(0);
      applyFontSize(100);
    });

    // Toggle dropdown
    gearBtn.addEventListener('click', (e) => {
      e.stopPropagation();
      dropdown.style.display = dropdown.style.display === 'none' ? 'block' : 'none';
    });

    // Close on click outside
    document.addEventListener('click', (e) => {
      const wrapper = document.getElementById('settingsWrapper');
      if (wrapper && !wrapper.contains(e.target)) {
        dropdown.style.display = 'none';
      }
    });

    // Load saved preferences
    const savedTheme = localStorage.getItem('dkrace-theme');
    const savedFont = localStorage.getItem('dkrace-font');
    if (savedTheme && THEME_PRESETS[savedTheme]) {
      applyTheme(savedTheme);
    } else {
      // Mark default as active
      document.querySelectorAll('.theme-swatch').forEach(el => {
        el.classList.toggle('active', el.dataset.theme === 'dk-classic');
      });
    }
    if (savedFont !== null) {
      applyFont(Number(savedFont));
    }
    const savedFontSize = localStorage.getItem('dkrace-font-size');
    if (savedFontSize !== null) {
      applyFontSize(Number(savedFontSize));
    }
  }

  return { init };
})();

document.addEventListener('DOMContentLoaded', () => App.init());

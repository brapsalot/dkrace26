// ── DK Rap Chaos — Collaborative Drawing Canvas ─────────────

const DrawCanvas = (() => {
  // ── State ──
  let canvas, ctx;
  let enabled = false;
  let drawing = false;
  let currentStroke = null;
  let strokes = [];
  let animFrameId = null;
  let wsSend = null;
  let batchBuffer = [];
  let batchTimer = null;

  // ── Tool state ──
  let currentColor = '#FFD700';
  let currentLineWidth = 4;
  let drawMode = 'brush';          // 'brush' or 'sticker'
  let currentSticker = '🍌';
  let currentStickerSize = 48;
  let stickers = [];                // placed stickers array

  // ── Toolbar drag state ──
  const TOOLBAR_STORAGE_KEY = 'dkrap-draw-toolbar-pos';
  const DRAG_THRESHOLD = 5;
  let toolbarDragState = null;

  // ── Constants ──
  const STROKE_LIFETIME_MS = 10000;
  const FADE_START_MS = 7000;
  const BATCH_INTERVAL_MS = 50;
  const MAX_STROKES = 200;

  // ── Init ──
  function init(sendCallback) {
    wsSend = sendCallback;
    canvas = document.getElementById('drawCanvas');
    if (!canvas) return;
    ctx = canvas.getContext('2d');

    resizeCanvas();

    // Resize observer
    const wrapper = canvas.parentElement;
    if (window.ResizeObserver) {
      new ResizeObserver(() => resizeCanvas()).observe(wrapper);
    }
    window.addEventListener('resize', resizeCanvas);

    // Pointer events
    canvas.addEventListener('pointerdown', onPointerDown);
    canvas.addEventListener('pointermove', onPointerMove);
    canvas.addEventListener('pointerup', onPointerUp);
    canvas.addEventListener('pointercancel', onPointerUp);

    // Toolbar bindings
    const toggle = document.getElementById('drawToggle');
    if (toggle) toggle.addEventListener('click', toggleDraw);

    const colorInput = document.getElementById('drawColor');
    if (colorInput) colorInput.addEventListener('input', (e) => { currentColor = e.target.value; });

    const sizeInput = document.getElementById('drawSize');
    const sizeLabel = document.getElementById('drawSizeLabel');
    if (sizeInput) {
      sizeInput.addEventListener('input', (e) => {
        currentLineWidth = parseInt(e.target.value, 10);
        if (sizeLabel) sizeLabel.textContent = currentLineWidth;
      });
    }

    // Sticker tools
    const stickerSelect = document.getElementById('drawStickerSelect');
    if (stickerSelect) stickerSelect.addEventListener('change', (e) => { currentSticker = e.target.value; });

    const stickerSizeInput = document.getElementById('drawStickerSize');
    const stickerSizeLabel = document.getElementById('drawStickerSizeLabel');
    if (stickerSizeInput) {
      stickerSizeInput.addEventListener('input', (e) => {
        currentStickerSize = parseInt(e.target.value, 10);
        if (stickerSizeLabel) stickerSizeLabel.textContent = currentStickerSize;
      });
    }

    // Mode toggle buttons (brush / sticker)
    document.querySelectorAll('.draw-mode-btn').forEach(btn => {
      btn.addEventListener('click', (e) => {
        e.stopPropagation();
        const mode = btn.dataset.mode;
        if (!mode) return;
        drawMode = mode;
        document.querySelectorAll('.draw-mode-btn').forEach(b => b.classList.toggle('active', b.dataset.mode === mode));
        const brushTools = document.getElementById('drawBrushTools');
        const stickerTools = document.getElementById('drawStickerTools');
        if (brushTools) brushTools.style.display = mode === 'brush' ? 'flex' : 'none';
        if (stickerTools) stickerTools.style.display = mode === 'sticker' ? 'flex' : 'none';
      });
    });

    initToolbarDrag();
  }

  function resizeCanvas() {
    if (!canvas) return;
    const wrapper = canvas.parentElement;
    const w = wrapper.offsetWidth;
    const h = wrapper.offsetHeight;
    if (canvas.width !== w || canvas.height !== h) {
      canvas.width = w;
      canvas.height = h;
      renderFrame();
    }
  }

  // ── Toggle ──
  function toggleDraw() {
    setEnabled(!enabled);
  }

  function setEnabled(on) {
    enabled = on;
    if (!canvas) return;
    canvas.classList.toggle('active', on);
    const toggle = document.getElementById('drawToggle');
    if (toggle) toggle.classList.toggle('active', on);
    const tools = document.getElementById('drawTools');
    if (tools) tools.style.display = on ? 'flex' : 'none';
    if (!on && drawing) {
      finishStroke();
    }
  }

  // ── Coordinate Normalization ──
  function normalize(clientX, clientY) {
    const rect = canvas.getBoundingClientRect();
    return {
      x: (clientX - rect.left) / rect.width,
      y: (clientY - rect.top) / rect.height
    };
  }

  function denormalize(nx, ny) {
    return { x: nx * canvas.width, y: ny * canvas.height };
  }

  // ── Stroke ID ──
  function makeId() {
    return Date.now() + '-' + Math.random().toString(36).slice(2, 8);
  }

  // ── Pointer Handlers ──
  function onPointerDown(e) {
    if (!enabled) return;
    e.preventDefault();

    const pt = normalize(e.clientX, e.clientY);

    // ── Sticker mode: place on click ──
    if (drawMode === 'sticker') {
      const sticker = {
        id: makeId(),
        emoji: currentSticker,
        x: pt.x,
        y: pt.y,
        size: currentStickerSize,
        timestamp: Date.now()
      };
      stickers.push(sticker);
      pruneExcessStickers();
      ensureRenderLoop();

      if (wsSend) {
        wsSend({
          type: 'DRAW', action: 'sticker',
          id: sticker.id, emoji: sticker.emoji,
          x: sticker.x, y: sticker.y, size: sticker.size
        });
      }
      return;
    }

    // ── Brush mode ──
    canvas.setPointerCapture(e.pointerId);
    drawing = true;

    currentStroke = {
      id: makeId(),
      points: [pt],
      color: currentColor,
      lineWidth: currentLineWidth,
      timestamp: Date.now()
    };
    strokes.push(currentStroke);
    ensureRenderLoop();

    // Send start
    if (wsSend) {
      wsSend({
        type: 'DRAW', action: 'start', id: currentStroke.id,
        color: currentStroke.color, lineWidth: currentStroke.lineWidth,
        points: [pt]
      });
    }

    // Start batching
    batchBuffer = [];
    batchTimer = setInterval(flushBatch, BATCH_INTERVAL_MS);
  }

  function onPointerMove(e) {
    if (!drawing || !currentStroke) return;
    e.preventDefault();
    const pt = normalize(e.clientX, e.clientY);
    currentStroke.points.push(pt);
    batchBuffer.push(pt);
  }

  function onPointerUp(e) {
    if (!drawing) return;
    e.preventDefault();
    finishStroke();
  }

  function finishStroke() {
    if (!currentStroke) { drawing = false; return; }
    flushBatch();
    if (batchTimer) { clearInterval(batchTimer); batchTimer = null; }

    if (wsSend) {
      wsSend({ type: 'DRAW', action: 'end', id: currentStroke.id });
    }

    currentStroke = null;
    drawing = false;
  }

  // ── Batching ──
  function flushBatch() {
    if (batchBuffer.length === 0 || !currentStroke) return;
    if (wsSend) {
      wsSend({
        type: 'DRAW', action: 'move', id: currentStroke.id,
        points: batchBuffer.slice()
      });
    }
    batchBuffer = [];
  }

  // ── Remote Stroke Handling ──
  function onDrawMessage(msg) {
    if (msg.action === 'sticker') {
      const sticker = {
        id: msg.id,
        emoji: msg.emoji || '🍌',
        x: msg.x,
        y: msg.y,
        size: msg.size || 48,
        timestamp: Date.now()
      };
      stickers.push(sticker);
      pruneExcessStickers();
      ensureRenderLoop();
    } else if (msg.action === 'start') {
      const stroke = {
        id: msg.id,
        points: msg.points || [],
        color: msg.color || '#FFD700',
        lineWidth: msg.lineWidth || 4,
        timestamp: Date.now()
      };
      strokes.push(stroke);
      pruneExcess();
      ensureRenderLoop();
    } else if (msg.action === 'move') {
      const stroke = strokes.find(s => s.id === msg.id);
      if (stroke && msg.points) {
        stroke.points.push(...msg.points);
      }
    }
    // 'end' — no action needed, stroke just fades naturally
  }

  // ── Rendering ──
  function ensureRenderLoop() {
    if (animFrameId) return;
    animFrameId = requestAnimationFrame(renderLoop);
  }

  function renderLoop() {
    animFrameId = null;
    pruneExpired();
    renderFrame();
    if (strokes.length > 0 || stickers.length > 0) {
      animFrameId = requestAnimationFrame(renderLoop);
    }
  }

  function renderFrame() {
    if (!ctx || !canvas) return;
    ctx.clearRect(0, 0, canvas.width, canvas.height);

    const now = Date.now();

    // Draw strokes
    for (const stroke of strokes) {
      const age = now - stroke.timestamp;
      let opacity = 1;
      if (age > FADE_START_MS) {
        opacity = 1 - ((age - FADE_START_MS) / (STROKE_LIFETIME_MS - FADE_START_MS));
        if (opacity < 0) opacity = 0;
      }
      drawStroke(stroke, opacity);
    }

    // Draw stickers
    for (const sticker of stickers) {
      const age = now - sticker.timestamp;
      let opacity = 1;
      if (age > FADE_START_MS) {
        opacity = 1 - ((age - FADE_START_MS) / (STROKE_LIFETIME_MS - FADE_START_MS));
        if (opacity < 0) opacity = 0;
      }
      drawSticker(sticker, opacity);
    }
  }

  function drawSticker(sticker, opacity) {
    const pos = denormalize(sticker.x, sticker.y);
    ctx.save();
    ctx.globalAlpha = opacity;
    ctx.font = sticker.size + 'px serif';
    ctx.textAlign = 'center';
    ctx.textBaseline = 'middle';
    ctx.fillText(sticker.emoji, pos.x, pos.y);
    ctx.restore();
  }

  function drawStroke(stroke, opacity) {
    if (stroke.points.length < 1) return;
    ctx.save();
    ctx.globalAlpha = opacity;
    ctx.strokeStyle = stroke.color;
    ctx.lineWidth = stroke.lineWidth;
    ctx.lineCap = 'round';
    ctx.lineJoin = 'round';
    ctx.beginPath();

    const p0 = denormalize(stroke.points[0].x, stroke.points[0].y);
    ctx.moveTo(p0.x, p0.y);

    for (let i = 1; i < stroke.points.length; i++) {
      const p = denormalize(stroke.points[i].x, stroke.points[i].y);
      ctx.lineTo(p.x, p.y);
    }

    if (stroke.points.length === 1) {
      // Single point — draw a dot
      ctx.arc(p0.x, p0.y, stroke.lineWidth / 2, 0, Math.PI * 2);
      ctx.fillStyle = stroke.color;
      ctx.fill();
    } else {
      ctx.stroke();
    }

    ctx.restore();
  }

  function pruneExpired() {
    const now = Date.now();
    strokes = strokes.filter(s => (now - s.timestamp) < STROKE_LIFETIME_MS);
    stickers = stickers.filter(s => (now - s.timestamp) < STROKE_LIFETIME_MS);
  }

  function pruneExcess() {
    while (strokes.length > MAX_STROKES) strokes.shift();
  }

  function pruneExcessStickers() {
    while (stickers.length > MAX_STROKES) stickers.shift();
  }

  // ── Toolbar Drag ──
  function getClientPos(e) {
    if (e.touches && e.touches.length > 0) return { x: e.touches[0].clientX, y: e.touches[0].clientY };
    return { x: e.clientX, y: e.clientY };
  }

  function initToolbarDrag() {
    const toolbar = document.getElementById('drawToolbar');
    if (!toolbar) return;

    loadToolbarPosition();

    toolbar.addEventListener('mousedown', onToolbarDragStart);
    toolbar.addEventListener('touchstart', onToolbarDragStart, { passive: false });

    // Double-click to reset position
    toolbar.addEventListener('dblclick', (e) => {
      if (e.target.closest('#drawTools')) return;
      toolbar.style.left = '';
      toolbar.style.right = '12px';
      toolbar.style.top = '12px';
      localStorage.removeItem(TOOLBAR_STORAGE_KEY);
    });
  }

  function loadToolbarPosition() {
    try {
      const raw = localStorage.getItem(TOOLBAR_STORAGE_KEY);
      if (!raw) return;
      const pos = JSON.parse(raw);
      const toolbar = document.getElementById('drawToolbar');
      if (!toolbar) return;
      toolbar.style.right = 'auto';
      toolbar.style.left = pos.x + 'px';
      toolbar.style.top = pos.y + 'px';
    } catch { /* ignore */ }
  }

  function onToolbarDragStart(e) {
    if (e.target.closest('#drawTools')) return;

    const toolbar = document.getElementById('drawToolbar');
    const wrapper = document.querySelector('.streams-grid-wrapper');
    if (!toolbar || !wrapper) return;

    const pos = getClientPos(e);
    const rect = toolbar.getBoundingClientRect();

    toolbarDragState = {
      toolbar,
      wrapper,
      startX: pos.x,
      startY: pos.y,
      offsetX: pos.x - rect.left,
      offsetY: pos.y - rect.top,
      isDragging: false,
      didDrag: false
    };

    document.addEventListener('mousemove', onToolbarDragMove);
    document.addEventListener('mouseup', onToolbarDragEnd);
    document.addEventListener('touchmove', onToolbarDragMove, { passive: false });
    document.addEventListener('touchend', onToolbarDragEnd);
  }

  function onToolbarDragMove(e) {
    if (!toolbarDragState) return;
    e.preventDefault();

    const pos = getClientPos(e);
    const dx = pos.x - toolbarDragState.startX;
    const dy = pos.y - toolbarDragState.startY;

    if (!toolbarDragState.isDragging) {
      if (Math.abs(dx) < DRAG_THRESHOLD && Math.abs(dy) < DRAG_THRESHOLD) return;
      toolbarDragState.isDragging = true;
      toolbarDragState.didDrag = true;
      toolbarDragState.toolbar.classList.add('dragging');
      if (typeof LayoutManager !== 'undefined') LayoutManager.showIframeOverlay();
    }

    const wrapperRect = toolbarDragState.wrapper.getBoundingClientRect();
    const toolbarW = toolbarDragState.toolbar.offsetWidth;
    const toolbarH = toolbarDragState.toolbar.offsetHeight;

    let newX = pos.x - wrapperRect.left - toolbarDragState.offsetX;
    let newY = pos.y - wrapperRect.top - toolbarDragState.offsetY;

    newX = Math.max(0, Math.min(wrapperRect.width - toolbarW, newX));
    newY = Math.max(0, Math.min(wrapperRect.height - toolbarH, newY));

    toolbarDragState.toolbar.style.right = 'auto';
    toolbarDragState.toolbar.style.left = newX + 'px';
    toolbarDragState.toolbar.style.top = newY + 'px';
  }

  function onToolbarDragEnd() {
    if (!toolbarDragState) return;

    const wasDrag = toolbarDragState.didDrag;

    if (wasDrag) {
      if (typeof LayoutManager !== 'undefined') LayoutManager.hideIframeOverlay();
      toolbarDragState.toolbar.classList.remove('dragging');

      const left = parseInt(toolbarDragState.toolbar.style.left) || 0;
      const top = parseInt(toolbarDragState.toolbar.style.top) || 0;
      localStorage.setItem(TOOLBAR_STORAGE_KEY, JSON.stringify({ x: left, y: top }));
    }

    toolbarDragState = null;
    document.removeEventListener('mousemove', onToolbarDragMove);
    document.removeEventListener('mouseup', onToolbarDragEnd);
    document.removeEventListener('touchmove', onToolbarDragMove);
    document.removeEventListener('touchend', onToolbarDragEnd);

    // Suppress the click that follows mouseup if we dragged
    if (wasDrag) {
      const toggle = document.getElementById('drawToggle');
      if (toggle) {
        const suppress = (ev) => { ev.stopPropagation(); ev.preventDefault(); };
        toggle.addEventListener('click', suppress, { once: true, capture: true });
      }
    }
  }

  return { init, toggle: toggleDraw, setEnabled, onDrawMessage, resizeCanvas };
})();

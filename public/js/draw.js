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
    canvas.setPointerCapture(e.pointerId);
    drawing = true;

    const pt = normalize(e.clientX, e.clientY);
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
    if (msg.action === 'start') {
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
    if (strokes.length > 0) {
      animFrameId = requestAnimationFrame(renderLoop);
    }
  }

  function renderFrame() {
    if (!ctx || !canvas) return;
    ctx.clearRect(0, 0, canvas.width, canvas.height);

    const now = Date.now();
    for (const stroke of strokes) {
      const age = now - stroke.timestamp;
      let opacity = 1;
      if (age > FADE_START_MS) {
        opacity = 1 - ((age - FADE_START_MS) / (STROKE_LIFETIME_MS - FADE_START_MS));
        if (opacity < 0) opacity = 0;
      }
      drawStroke(stroke, opacity);
    }
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
  }

  function pruneExcess() {
    while (strokes.length > MAX_STROKES) strokes.shift();
  }

  return { init, toggle: toggleDraw, onDrawMessage, resizeCanvas };
})();

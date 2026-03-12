// ── DK Rap Chaos — Draggable/Resizable Layout Manager ───────

const LayoutManager = (() => {
  const STORAGE_KEY = 'dkrap-layout';
  const MIN_W = 300;
  const MIN_H = 200;

  let customized = false;
  let panels = {};
  let dragState = null;
  let resizeState = null;
  let iframeOverlay = null;

  function init() {
    loadLayout();
    bindHandles();
    const resetBtn = document.getElementById('resetLayoutBtn');
    if (resetBtn) resetBtn.addEventListener('click', resetLayout);
  }

  // ── Persistence ──
  function loadLayout() {
    try {
      const raw = localStorage.getItem(STORAGE_KEY);
      if (!raw) return;
      const data = JSON.parse(raw);
      if (data.customized && data.panels) {
        panels = data.panels;
        customized = true;
        applyLayout();
      }
    } catch { /* ignore corrupt data */ }
  }

  function saveLayout() {
    localStorage.setItem(STORAGE_KEY, JSON.stringify({ customized: true, panels }));
  }

  function applyLayout() {
    const mainLayout = document.querySelector('.main-layout');
    mainLayout.classList.add('custom-layout');
    showResetBtn(true);

    for (const key of ['col-left', 'col-right']) {
      const el = document.querySelector('.' + key);
      const p = panels[key];
      if (!el || !p) continue;
      el.style.left = p.x + 'px';
      el.style.top = p.y + 'px';
      el.style.width = p.w + 'px';
      el.style.height = p.h + 'px';
    }

    // Sync drawing canvas after layout apply
    if (typeof DrawCanvas !== 'undefined') {
      setTimeout(() => DrawCanvas.resizeCanvas(), 50);
    }
  }

  function resetLayout() {
    localStorage.removeItem(STORAGE_KEY);
    customized = false;
    panels = {};
    const mainLayout = document.querySelector('.main-layout');
    mainLayout.classList.remove('custom-layout');
    for (const key of ['col-left', 'col-right']) {
      const el = document.querySelector('.' + key);
      if (el) el.style.cssText = '';
    }
    showResetBtn(false);
    if (typeof GridResizer !== 'undefined' && GridResizer.resetAll) {
      GridResizer.resetAll();
    }
    if (typeof DrawCanvas !== 'undefined') {
      setTimeout(() => DrawCanvas.resizeCanvas(), 50);
    }
  }

  function showResetBtn(visible) {
    const btn = document.getElementById('resetLayoutBtn');
    if (btn) btn.classList.toggle('visible', visible);
  }

  // ── Capture Current Positions ──
  function captureDefaults() {
    for (const key of ['col-left', 'col-right']) {
      const el = document.querySelector('.' + key);
      if (!el) continue;
      const rect = el.getBoundingClientRect();
      const mainRect = el.parentElement.getBoundingClientRect();
      panels[key] = {
        x: rect.left - mainRect.left,
        y: rect.top - mainRect.top,
        w: rect.width,
        h: rect.height
      };
    }
  }

  function switchToCustom() {
    if (customized) return;
    captureDefaults();
    customized = true;
    applyLayout();
  }

  // ── Push Panels Apart (prevent overlap, keep both on screen) ──
  const MIN_RIGHT_W = 322;
  function pushPanelsApart(movedKey) {
    if (!panels['col-left'] || !panels['col-right']) return;
    const gap = 16;
    const left = panels['col-left'];
    const right = panels['col-right'];
    const leftEl = document.querySelector('.col-left');
    const rightEl = document.querySelector('.col-right');
    const mainRect = leftEl ? leftEl.parentElement.getBoundingClientRect() : null;
    const maxX = mainRect ? mainRect.width : window.innerWidth;

    const leftRight = left.x + left.w + gap;

    if (right.x < leftRight) {
      // Right panel needs to move
      right.x = leftRight;

      // If right panel would go off-screen, shrink it to fit
      if (right.x + right.w > maxX) {
        right.w = Math.max(MIN_RIGHT_W, maxX - right.x);
        if (rightEl) rightEl.style.width = right.w + 'px';
      }

      // If still off-screen even at min width, cap left panel width instead
      if (right.x + MIN_RIGHT_W > maxX) {
        right.x = maxX - MIN_RIGHT_W;
        right.w = MIN_RIGHT_W;
        // Also limit left panel so it doesn't push right off
        const maxLeftW = right.x - gap - left.x;
        if (left.w > maxLeftW && maxLeftW >= MIN_W) {
          left.w = maxLeftW;
          if (leftEl) leftEl.style.width = left.w + 'px';
        }
      }

      if (rightEl) {
        rightEl.style.left = right.x + 'px';
        rightEl.style.width = right.w + 'px';
      }
    }
  }

  // ── Iframe Overlay (prevents iframes capturing mouse during drag/resize) ──
  function showIframeOverlay() {
    if (iframeOverlay) return;
    iframeOverlay = document.createElement('div');
    iframeOverlay.style.cssText = 'position:fixed;top:0;left:0;width:100%;height:100%;z-index:9999;cursor:inherit;';
    document.body.appendChild(iframeOverlay);
  }

  function hideIframeOverlay() {
    if (iframeOverlay) {
      iframeOverlay.remove();
      iframeOverlay = null;
    }
  }

  // ── Bind Handles ──
  function bindHandles() {
    document.querySelectorAll('.panel-drag-handle').forEach(handle => {
      const panelKey = handle.closest('[data-panel]')?.dataset.panel;
      if (!panelKey) return;
      handle.addEventListener('mousedown', (e) => onDragStart(e, panelKey));
      handle.addEventListener('touchstart', (e) => onDragStart(e, panelKey), { passive: false });
    });

    document.querySelectorAll('.panel-resize-handle').forEach(handle => {
      const panelKey = handle.closest('[data-panel]')?.dataset.panel;
      if (!panelKey) return;
      handle.addEventListener('mousedown', (e) => onResizeStart(e, panelKey));
      handle.addEventListener('touchstart', (e) => onResizeStart(e, panelKey), { passive: false });
    });
  }

  // ── Drag ──
  function getClientPos(e) {
    if (e.touches && e.touches.length > 0) return { x: e.touches[0].clientX, y: e.touches[0].clientY };
    return { x: e.clientX, y: e.clientY };
  }

  function onDragStart(e, panelKey) {
    e.preventDefault();
    switchToCustom();
    const el = document.querySelector('.' + panelKey);
    if (!el) return;
    const pos = getClientPos(e);
    dragState = {
      panelKey,
      el,
      startX: pos.x,
      startY: pos.y,
      origX: panels[panelKey].x,
      origY: panels[panelKey].y
    };
    showIframeOverlay();
    document.addEventListener('mousemove', onDragMove);
    document.addEventListener('mouseup', onDragEnd);
    document.addEventListener('touchmove', onDragMove, { passive: false });
    document.addEventListener('touchend', onDragEnd);
  }

  function onDragMove(e) {
    if (!dragState) return;
    e.preventDefault();
    const pos = getClientPos(e);
    const dx = pos.x - dragState.startX;
    const dy = pos.y - dragState.startY;
    let nx = dragState.origX + dx;
    let ny = dragState.origY + dy;

    // Clamp: don't let panel go off-screen left/top, keep 50px visible on right
    const mainRect = dragState.el.parentElement.getBoundingClientRect();
    const w = panels[dragState.panelKey].w;
    nx = Math.max(0, Math.min(mainRect.width - 50, nx));
    ny = Math.max(0, ny);

    panels[dragState.panelKey].x = nx;
    panels[dragState.panelKey].y = ny;
    dragState.el.style.left = nx + 'px';
    dragState.el.style.top = ny + 'px';

    // Prevent overlap between panels
    pushPanelsApart(dragState.panelKey);
  }

  function onDragEnd() {
    if (!dragState) return;
    dragState = null;
    hideIframeOverlay();
    document.removeEventListener('mousemove', onDragMove);
    document.removeEventListener('mouseup', onDragEnd);
    document.removeEventListener('touchmove', onDragMove);
    document.removeEventListener('touchend', onDragEnd);
    saveLayout();
  }

  // ── Resize ──
  function onResizeStart(e, panelKey) {
    e.preventDefault();
    e.stopPropagation();
    switchToCustom();
    const el = document.querySelector('.' + panelKey);
    if (!el) return;
    const pos = getClientPos(e);
    resizeState = {
      panelKey,
      el,
      startX: pos.x,
      startY: pos.y,
      origW: panels[panelKey].w,
      origH: panels[panelKey].h
    };
    showIframeOverlay();
    document.addEventListener('mousemove', onResizeMove);
    document.addEventListener('mouseup', onResizeEnd);
    document.addEventListener('touchmove', onResizeMove, { passive: false });
    document.addEventListener('touchend', onResizeEnd);
  }

  function onResizeMove(e) {
    if (!resizeState) return;
    e.preventDefault();
    const pos = getClientPos(e);
    const dw = pos.x - resizeState.startX;
    const dh = pos.y - resizeState.startY;

    // Clamp width so panel + its left offset doesn't exceed viewport
    const panelX = panels[resizeState.panelKey].x || 0;
    const maxW = window.innerWidth - panelX - 20;
    const nw = Math.max(MIN_W, Math.min(maxW, resizeState.origW + dw));

    // Clamp height so panel + its top offset doesn't go below viewport
    const panelY = panels[resizeState.panelKey].y || 0;
    const mainRect = resizeState.el.parentElement.getBoundingClientRect();
    const maxH = window.innerHeight - mainRect.top - panelY - 20;
    const nh = Math.max(MIN_H, Math.min(maxH, resizeState.origH + dh));

    panels[resizeState.panelKey].w = nw;
    panels[resizeState.panelKey].h = nh;
    resizeState.el.style.width = nw + 'px';
    resizeState.el.style.height = nh + 'px';

    // Prevent overlap between panels
    pushPanelsApart(resizeState.panelKey);
  }

  function onResizeEnd() {
    if (!resizeState) return;
    const wasLeft = resizeState.panelKey === 'col-left';
    resizeState = null;
    hideIframeOverlay();
    document.removeEventListener('mousemove', onResizeMove);
    document.removeEventListener('mouseup', onResizeEnd);
    document.removeEventListener('touchmove', onResizeMove);
    document.removeEventListener('touchend', onResizeEnd);
    saveLayout();
    if (wasLeft && typeof DrawCanvas !== 'undefined') {
      setTimeout(() => DrawCanvas.resizeCanvas(), 50);
    }
  }

  // Allow external code to snap a panel's height to its content
  function _updatePanelHeight(panelKey) {
    if (!customized || !panels[panelKey]) return;
    const el = document.querySelector('.' + panelKey);
    if (!el) return;
    panels[panelKey].h = el.scrollHeight;
    el.style.height = el.scrollHeight + 'px';
    saveLayout();
  }

  return { init, resetLayout, _updatePanelHeight, showIframeOverlay, hideIframeOverlay };
})();

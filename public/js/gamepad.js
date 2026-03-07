// ── Virtual SNES Gamepad + Keyboard Input ────────────────────

const GamepadController = (() => {
  // Current button state
  const buttons = {
    Up: false, Down: false, Left: false, Right: false,
    A: false, B: false, X: false, Y: false,
    L: false, R: false, Start: false, Select: false
  };

  // Keyboard → SNES button mapping
  const KEY_MAP = {
    'ArrowUp': 'Up', 'ArrowDown': 'Down', 'ArrowLeft': 'Left', 'ArrowRight': 'Right',
    'z': 'B', 'Z': 'B',
    'x': 'A', 'X': 'A',
    'a': 'Y', 'A': 'Y',
    's': 'X', 'S': 'X',
    'q': 'L', 'Q': 'L',
    'w': 'R', 'W': 'R',
    'Enter': 'Start',
    'Shift': 'Select'
  };

  let sendCallback = null;
  let active = false;
  let sendThrottle = null;

  function init(onSend) {
    sendCallback = onSend;
    bindDOMButtons();
    bindKeyboard();
  }

  function setActive(isActive) {
    active = isActive;
    if (!isActive) {
      // Reset all buttons
      Object.keys(buttons).forEach(k => buttons[k] = false);
      updateVisuals();
    }
  }

  function sendState() {
    if (!active || !sendCallback) return;
    // Throttle to ~60fps max
    if (sendThrottle) return;
    sendThrottle = setTimeout(() => { sendThrottle = null; }, 16);
    sendCallback({ ...buttons });
  }

  function setButton(name, pressed) {
    if (buttons[name] === pressed) return;
    buttons[name] = pressed;
    updateVisuals();
    sendState();
  }

  function updateVisuals() {
    document.querySelectorAll('[data-btn]').forEach(el => {
      const btn = el.getAttribute('data-btn');
      if (buttons[btn]) {
        el.classList.add('pressed');
      } else {
        el.classList.remove('pressed');
      }
    });
  }

  function bindDOMButtons() {
    // Event delegation — works for both panel and overlay buttons
    document.addEventListener('mousedown', (e) => {
      const el = e.target.closest('[data-btn]');
      if (!el) return;
      e.preventDefault();
      setButton(el.getAttribute('data-btn'), true);
    });

    document.addEventListener('mouseup', () => {
      // Release all pressed buttons on global mouseup
      Object.keys(buttons).forEach(k => {
        if (buttons[k]) setButton(k, false);
      });
    });

    document.addEventListener('touchstart', (e) => {
      const el = e.target.closest('[data-btn]');
      if (!el) return;
      e.preventDefault();
      setButton(el.getAttribute('data-btn'), true);
    }, { passive: false });

    document.addEventListener('touchend', (e) => {
      const el = e.target.closest('[data-btn]');
      if (!el) return;
      e.preventDefault();
      setButton(el.getAttribute('data-btn'), false);
    }, { passive: false });

    document.addEventListener('touchcancel', () => {
      Object.keys(buttons).forEach(k => {
        if (buttons[k]) setButton(k, false);
      });
    });
  }

  function bindKeyboard() {
    document.addEventListener('keydown', (e) => {
      if (!active) return;
      const btn = KEY_MAP[e.key];
      if (btn) {
        e.preventDefault();
        setButton(btn, true);
      }
    });

    document.addEventListener('keyup', (e) => {
      if (!active) return;
      const btn = KEY_MAP[e.key];
      if (btn) {
        e.preventDefault();
        setButton(btn, false);
      }
    });
  }

  return { init, setActive };
})();

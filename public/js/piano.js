// ── Virtual Piano Controller + Web Audio Synth ────────────────
// 22 keys: C4 to G5 (13 white + 9 black keys)
// Plays locally via Web Audio API & broadcasts notes to all viewers via WebSocket

const PianoController = (() => {
  // 22-key layout: C4 through G5
  const NOTES = [
    { note: 'C4',  freq: 261.63, type: 'white' },
    { note: 'C#4', freq: 277.18, type: 'black' },
    { note: 'D4',  freq: 293.66, type: 'white' },
    { note: 'D#4', freq: 311.13, type: 'black' },
    { note: 'E4',  freq: 329.63, type: 'white' },
    { note: 'F4',  freq: 349.23, type: 'white' },
    { note: 'F#4', freq: 369.99, type: 'black' },
    { note: 'G4',  freq: 392.00, type: 'white' },
    { note: 'G#4', freq: 415.30, type: 'black' },
    { note: 'A4',  freq: 440.00, type: 'white' },
    { note: 'A#4', freq: 466.16, type: 'black' },
    { note: 'B4',  freq: 493.88, type: 'white' },
    { note: 'C5',  freq: 523.25, type: 'white' },
    { note: 'C#5', freq: 554.37, type: 'black' },
    { note: 'D5',  freq: 587.33, type: 'white' },
    { note: 'D#5', freq: 622.25, type: 'black' },
    { note: 'E5',  freq: 659.25, type: 'white' },
    { note: 'F5',  freq: 698.46, type: 'white' },
    { note: 'F#5', freq: 739.99, type: 'black' },
    { note: 'G5',  freq: 783.99, type: 'white' },
    { note: 'G#5', freq: 830.61, type: 'black' },
    { note: 'A5',  freq: 880.00, type: 'white' }
  ];

  // Keyboard → note mapping (two rows: QWERTY top row for white, number row for black)
  const KEY_MAP = {
    'a': 'C4', 'w': 'C#4', 's': 'D4', 'e': 'D#4', 'd': 'E4',
    'f': 'F4', 't': 'F#4', 'g': 'G4', 'y': 'G#4', 'h': 'A4',
    'u': 'A#4', 'j': 'B4', 'k': 'C5', 'o': 'C#5', 'l': 'D5',
    'p': 'D#5', ';': 'E5', "'": 'F5', ']': 'F#5', '\\': 'G5',
  };

  let audioCtx = null;
  let sendCallback = null;
  let active = false;
  let activeOscillators = {};  // note → { osc, gain }

  function init(onSend) {
    sendCallback = onSend;
    bindDOMKeys();
    bindKeyboard();
  }

  function ensureAudioCtx() {
    if (!audioCtx) {
      audioCtx = new (window.AudioContext || window.webkitAudioContext)();
    }
    if (audioCtx.state === 'suspended') {
      audioCtx.resume();
    }
    return audioCtx;
  }

  function setActive(isActive) {
    active = isActive;
    if (!isActive) {
      // Stop all notes
      Object.keys(activeOscillators).forEach(note => stopNote(note, false));
      activeOscillators = {};
    }
  }

  function playNote(note, broadcast = true) {
    if (activeOscillators[note]) return; // already playing

    const ctx = ensureAudioCtx();
    const noteData = NOTES.find(n => n.note === note);
    if (!noteData) return;

    // Create oscillator with piano-like sound
    const osc = ctx.createOscillator();
    const gainNode = ctx.createGain();
    const filterNode = ctx.createBiquadFilter();

    // Triangle wave + filter for piano-ish tone
    osc.type = 'triangle';
    osc.frequency.setValueAtTime(noteData.freq, ctx.currentTime);

    // Low-pass filter to soften the sound
    filterNode.type = 'lowpass';
    filterNode.frequency.setValueAtTime(noteData.freq * 4, ctx.currentTime);
    filterNode.Q.setValueAtTime(1, ctx.currentTime);

    // Attack envelope
    gainNode.gain.setValueAtTime(0, ctx.currentTime);
    gainNode.gain.linearRampToValueAtTime(0.3, ctx.currentTime + 0.02);

    osc.connect(filterNode);
    filterNode.connect(gainNode);
    gainNode.connect(ctx.destination);
    osc.start();

    activeOscillators[note] = { osc, gain: gainNode, filter: filterNode };

    // Visual feedback
    const keyEl = document.querySelector(`[data-note="${note}"]`);
    if (keyEl) keyEl.classList.add('pressed');

    // Broadcast to other viewers
    if (broadcast && sendCallback) {
      sendCallback({ type: 'PIANO_NOTE', note, action: 'on' });
    }
  }

  function stopNote(note, broadcast = true) {
    const entry = activeOscillators[note];
    if (!entry) return;

    const ctx = ensureAudioCtx();
    // Release envelope
    entry.gain.gain.cancelScheduledValues(ctx.currentTime);
    entry.gain.gain.setValueAtTime(entry.gain.gain.value, ctx.currentTime);
    entry.gain.gain.linearRampToValueAtTime(0, ctx.currentTime + 0.15);
    entry.osc.stop(ctx.currentTime + 0.2);

    delete activeOscillators[note];

    // Visual feedback
    const keyEl = document.querySelector(`[data-note="${note}"]`);
    if (keyEl) keyEl.classList.remove('pressed');

    // Broadcast
    if (broadcast && sendCallback) {
      sendCallback({ type: 'PIANO_NOTE', note, action: 'off' });
    }
  }

  // Play a note from a remote viewer (no re-broadcast)
  function playRemote(note) {
    playNote(note, false);
  }
  function stopRemote(note) {
    stopNote(note, false);
  }

  function bindDOMKeys() {
    document.addEventListener('mousedown', (e) => {
      const el = e.target.closest('[data-note]');
      if (!el || !active) return;
      e.preventDefault();
      playNote(el.getAttribute('data-note'));
    });

    document.addEventListener('mouseup', () => {
      if (!active) return;
      Object.keys(activeOscillators).forEach(note => stopNote(note));
    });

    document.addEventListener('mouseleave', () => {
      if (!active) return;
      Object.keys(activeOscillators).forEach(note => stopNote(note));
    });

    // Touch support
    document.addEventListener('touchstart', (e) => {
      const el = e.target.closest('[data-note]');
      if (!el || !active) return;
      e.preventDefault();
      playNote(el.getAttribute('data-note'));
    }, { passive: false });

    document.addEventListener('touchend', (e) => {
      if (!active) return;
      // Stop all on touch end
      Object.keys(activeOscillators).forEach(note => stopNote(note));
    }, { passive: false });
  }

  function bindKeyboard() {
    document.addEventListener('keydown', (e) => {
      if (!active) return;
      const note = KEY_MAP[e.key.toLowerCase()] || KEY_MAP[e.key];
      if (note && !e.repeat) {
        e.preventDefault();
        playNote(note);
      }
    });

    document.addEventListener('keyup', (e) => {
      if (!active) return;
      const note = KEY_MAP[e.key.toLowerCase()] || KEY_MAP[e.key];
      if (note) {
        e.preventDefault();
        stopNote(note);
      }
    });
  }

  function getNotes() {
    return NOTES;
  }

  return { init, setActive, playNote: playRemote, stopNote: stopRemote, getNotes };
})();

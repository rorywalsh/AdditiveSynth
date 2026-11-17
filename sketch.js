/* ============================================================
   Waveform canvas, Web MIDI and computer-keyboard input
   ============================================================ */

const NOTE_NAMES = ['C', 'C#', 'D', 'D#', 'E', 'F', 'F#', 'G', 'G#', 'A', 'A#', 'B'];

// A W S E D F T G Y H U J K  =  C C# D D# E F F# G G# A A# B C
const KEY_OFFSETS = {
  a: 0,
  w: 1,
  s: 2,
  e: 3,
  d: 4,
  f: 5,
  t: 6,
  g: 7,
  y: 8,
  h: 9,
  u: 10,
  j: 11,
  k: 12,
  o: 13,
  l: 14,
  p: 15,
  ';': 16
};

let midiAccess = null;
let octave = 4;

const heldKeys = new Map();
const pedal = { down: false, held: new Set() };

const byId = (id) => document.getElementById(id);

/* ---------------------------------------------------------- waveform */

let waveformCanvas = null;
let waveformContext = null;
let waveformResizeObserver = null;
let waveformWidth = 0;
let waveformHeight = 0;
let waveformPixelRatio = 1;

function initWaveform() {
  waveformCanvas = byId('waveform-canvas');
  if (!waveformCanvas) return;

  waveformContext = waveformCanvas.getContext('2d');
  resizeWaveform();

  window.addEventListener('resize', resizeWaveform);

  if (typeof ResizeObserver !== 'undefined') {
    waveformResizeObserver = new ResizeObserver(resizeWaveform);
    waveformResizeObserver.observe(byId('waveform-holder'));
  }

  requestAnimationFrame(tickWaveform);
}

function resizeWaveform() {
  const holder = byId('waveform-holder');
  if (!waveformCanvas || !holder) return;

  const width = Math.max(1, holder.clientWidth);
  const height = Math.max(1, holder.clientHeight);

  waveformWidth = width;
  waveformHeight = height;
  waveformPixelRatio = Math.min(window.devicePixelRatio || 1, 2);

  waveformCanvas.width = Math.round(width * waveformPixelRatio);
  waveformCanvas.height = Math.round(height * waveformPixelRatio);
  waveformCanvas.style.width = `${width}px`;
  waveformCanvas.style.height = `${height}px`;
}

function tickWaveform() {
  drawWaveform();
  requestAnimationFrame(tickWaveform);
}

function drawWaveform() {
  if (!waveformCanvas || !waveformContext) return;

  const ctx = waveformContext;
  const w = waveformWidth;
  const h = waveformHeight;
  const levels = Synth.displayLevels();

  ctx.setTransform(waveformPixelRatio, 0, 0, waveformPixelRatio, 0, 0);
  ctx.fillStyle = '#090d13';
  ctx.fillRect(0, 0, w, h);

  drawWaveformGrid(ctx, w, h);

  const mid = h / 2;
  const baseScale = h * 0.34;
  const cycles = 2;
  const count = Math.max(2, Math.ceil(w) + 1);
  const values = new Array(count);
  let peak = 0;

  for (let i = 0; i < count; i += 1) {
    const phase = (i / Math.max(w, 1)) * Math.PI * 2 * cycles;
    let sample = 0;

    for (let j = 0; j < levels.length; j += 1) {
      sample += levels[j].level * Math.sin(phase * levels[j].ratio);
    }

    values[i] = sample;
    peak = Math.max(peak, Math.abs(sample));
  }

  // Keep the normal amplitude visible, but shrink very loud sums so the
  // waveform stays inside the canvas instead of clipping at the edges.
  const fitScale = (h * 0.42) / Math.max(peak, 0.0001);
  const amplitudeScale = Math.min(baseScale, fitScale);

  ctx.beginPath();
  for (let i = 0; i < count; i += 1) {
    const y = mid - values[i] * amplitudeScale;
    if (i === 0) ctx.moveTo(i, y);
    else ctx.lineTo(i, y);
  }

  ctx.lineJoin = 'round';
  ctx.lineCap = 'round';

  // Soft glow behind the line.
  ctx.strokeStyle = 'rgba(94, 234, 212, 0.08)';
  ctx.lineWidth = 9;
  ctx.stroke();

  // Main waveform.
  ctx.strokeStyle = 'rgba(94, 234, 212, 0.92)';
  ctx.lineWidth = 2;
  ctx.stroke();
}

function drawWaveformGrid(ctx, w, h) {
  ctx.lineWidth = 1;
  ctx.strokeStyle = 'rgba(255, 255, 255, 0.035)';
  ctx.beginPath();

  for (let i = 1; i < 8; i += 1) {
    const x = Math.round((w / 8) * i) + 0.5;
    ctx.moveTo(x, 0);
    ctx.lineTo(x, h);
  }

  for (let i = 1; i < 4; i += 1) {
    if (i === 2) continue;
    const y = Math.round((h / 4) * i) + 0.5;
    ctx.moveTo(0, y);
    ctx.lineTo(w, y);
  }

  ctx.stroke();

  ctx.strokeStyle = 'rgba(255, 255, 255, 0.075)';
  ctx.beginPath();
  const center = Math.round(h / 2) + 0.5;
  ctx.moveTo(0, center);
  ctx.lineTo(w, center);
  ctx.stroke();
}

/* ---------------------------------------------------------- app init */

function initApp() {
  Synth.addPartial({
    amp: 0.8,
    ratio: 1,
    a: 0.01,
    d: 0.25,
    s: 0.65,
    r: 0.45,
    exp: false
  });

  PartialUI.init();
  initWaveform();

  wireAudioButton();
  wirePanicButton();
  wireKeyboard();
  wireMIDI();

  Synth.onVoicesChange(updateVoiceDisplay);
  Synth.onAudioStateChange(updateAudioUI);

  byId('octave-display').textContent = String(octave);
  updateVoiceDisplay();
  updateAudioUI();
}

/* ---------------------------------------------------------- audio UI */

function wireAudioButton() {
  const button = byId('audio-btn');

  button.addEventListener('click', async () => {
    const ctx = Synth.ensureAudio();
    if (!ctx) return;

    try {
      if (ctx.state !== 'running') await ctx.resume();
    } catch (error) {
      console.warn('Could not start audio:', error);
    }

    updateAudioUI();
  });
}

function unlockAudio() {
  const ctx = Synth.ensureAudio();
  if (ctx && ctx.state === 'suspended') {
    ctx.resume().then(updateAudioUI).catch(() => {});
  }
  updateAudioUI();
}

function updateAudioUI() {
  const button = byId('audio-btn');
  const ctx = Synth.ctx;
  const running = Boolean(ctx && ctx.state === 'running');

  button.textContent = running ? 'Sound on' : 'Enable sound';
  button.classList.toggle('is-on', running);
  button.classList.toggle('needs-audio', !running);
  button.disabled = running;
  button.title = running
    ? 'Audio is running — use master volume to adjust the level'
    : 'Click to start the audio engine';
}

/* ---------------------------------------------------------- voice readout */

function noteName(midi) {
  const note = NOTE_NAMES[((midi % 12) + 12) % 12];
  const octaveNumber = Math.floor(midi / 12) - 1;
  return `${note}${octaveNumber}`;
}

function updateVoiceDisplay() {
  // Keep counting a voice while its release tail is still sounding.
  const active = Synth.voices.filter(
    (voice) => !voice.released || voice.nodes.size > 0
  );

  byId('voice-count').textContent =
    active.length === 1 ? '1 voice' : `${active.length} voices`;

  const badge = byId('mode-badge');
  const isLive = active.length > 0;
  badge.textContent = isLive ? 'Live' : 'Sustain preview';
  badge.classList.toggle('is-live', isLive);

  const readout = byId('playing-note');
  if (!isLive) {
    readout.textContent = 'No note playing';
    return;
  }

  const names = [...new Set(active.map((voice) => noteName(voice.note)))];
  if (names.length === 1) {
    const newest = active[active.length - 1];
    readout.textContent = `${names[0]} · ${newest.baseFreq.toFixed(1)} Hz`;
  } else {
    readout.textContent = names.join(' · ');
  }
}

/* ---------------------------------------------------------- panic */

function wirePanicButton() {
  byId('panic-btn').addEventListener('click', () => {
    Synth.allNotesOff();
    pedal.down = false;
    pedal.held.clear();
    heldKeys.clear();
  });
}

/* ---------------------------------------------------------- keyboard */

function wireKeyboard() {
  window.addEventListener('keydown', onKeyDown);
  window.addEventListener('keyup', onKeyUp);
  window.addEventListener('blur', releaseHeldKeys);
}

function isTypingTarget(target) {
  return Boolean(
    target &&
      target.closest &&
      target.closest('input, textarea, select, [contenteditable="true"]')
  );
}

function onKeyDown(event) {
  if (event.repeat || event.ctrlKey || event.metaKey || event.altKey) return;

  const keyName = event.key.toLowerCase();

  if (keyName === 'escape') {
    Synth.allNotesOff();
    pedal.down = false;
    pedal.held.clear();
    releaseHeldKeys();
    return;
  }

  if (isTypingTarget(event.target)) return;

  if (keyName === 'z') {
    shiftOctave(-1);
    return;
  }
  if (keyName === 'x') {
    shiftOctave(1);
    return;
  }

  if (!Object.prototype.hasOwnProperty.call(KEY_OFFSETS, keyName)) return;
  if (heldKeys.has(keyName)) return;

  event.preventDefault();
  unlockAudio();

  const midi = Math.max(0, Math.min(127, 12 * (octave + 1) + KEY_OFFSETS[keyName]));
  heldKeys.set(keyName, midi);
  Synth.noteOn(midi, 0.8);
}

function onKeyUp(event) {
  const keyName = event.key.toLowerCase();
  if (!heldKeys.has(keyName)) return;

  const midi = heldKeys.get(keyName);
  heldKeys.delete(keyName);
  Synth.noteOff(midi);
}

function releaseHeldKeys() {
  for (const midi of heldKeys.values()) Synth.noteOff(midi);
  heldKeys.clear();
}

function shiftOctave(direction) {
  releaseHeldKeys();
  octave = Math.max(1, Math.min(7, octave + direction));
  byId('octave-display').textContent = String(octave);
}

/* ---------------------------------------------------------- Web MIDI */

let midiRequestPending = false;

function wireMIDI() {
  const pill = byId('midi-status');

  pill.addEventListener('click', () => {
    if (midiRequestPending) return;
    if (midiAccess) refreshMIDI();
    else requestMIDI();
  });

  requestMIDI();
}

async function requestMIDI() {
  const pill = byId('midi-status');

  if (typeof navigator.requestMIDIAccess !== 'function') {
    showMidiUnavailable();
    return;
  }
  if (midiRequestPending) return;

  midiRequestPending = true;
  setMidiStatus('MIDI · asking permission…', 'warn');
  pill.title = 'Waiting for the browser’s MIDI permission prompt…';

  try {
    midiAccess = await navigator.requestMIDIAccess({ sysex: false });
    midiAccess.onstatechange = refreshMIDI;
    refreshMIDI();
  } catch (error) {
    console.warn('Web MIDI unavailable:', error);
    showMidiError(error);
  } finally {
    midiRequestPending = false;
  }
}

function showMidiUnavailable() {
  const pill = byId('midi-status');
  const isFile = location.protocol === 'file:';
  const insecure = !window.isSecureContext;

  if (isFile || insecure) {
    setMidiStatus('MIDI off · use localhost', 'error');
    pill.title = isFile
      ? 'This page was opened as a file. In the project folder run "python -m http.server 8000" and open http://localhost:8000, then allow MIDI access.'
      : 'Web MIDI needs a secure origin. Open the app at http://localhost:8000 instead of a network address over plain HTTP.';
    return;
  }

  setMidiStatus('MIDI off · use Chrome or Edge', 'error');
  pill.title =
    'This browser does not provide the Web MIDI API. Chrome and Edge support it; Firefox may need Web MIDI enabled; Safari does not support it. On a managed device, Web MIDI may also be disabled by browser policy.';
}

function showMidiError(error) {
  const pill = byId('midi-status');
  const name = error && error.name;
  const message = error && error.message ? error.message : String(error);

  if (location.protocol === 'file:' || !window.isSecureContext) {
    showMidiUnavailable();
    return;
  }

  if (name === 'NotAllowedError' || name === 'SecurityError') {
    setMidiStatus('MIDI blocked · allow access', 'error');
    pill.title =
      'MIDI access was blocked. Click the lock/settings icon in the address bar, allow MIDI for this site, then reload or click here to retry. (' +
      message +
      ')';
    return;
  }

  setMidiStatus('MIDI unavailable · use keys', 'error');
  pill.title =
    'The browser could not start Web MIDI. Use http://localhost or HTTPS in Chrome/Edge, then click here to retry. (' +
    message +
    ')';
}

function refreshMIDI() {
  if (!midiAccess) return;

  const pill = byId('midi-status');
  const inputs = [...midiAccess.inputs.values()];
  for (const input of inputs) {
    if (input.onmidimessage) continue;
    input.onmidimessage = handleMIDIMessage;
  }

  const connected = inputs.filter((input) => input.state === 'connected');

  if (connected.length === 0) {
    setMidiStatus('MIDI ready · no devices', 'warn');
    pill.title =
      'Web MIDI is working. Connect a MIDI keyboard; it will be picked up automatically.';
  } else if (connected.length === 1) {
    setMidiStatus(`MIDI · ${connected[0].name}`, 'ok');
    pill.title = `${connected[0].name} — click to re-check devices`;
  } else {
    setMidiStatus(`MIDI · ${connected.length} devices`, 'ok');
    pill.title = `${connected
      .map((input) => input.name)
      .join(', ')} — click to re-check devices`;
  }
}

function setMidiStatus(text, tone) {
  const pill = byId('midi-status');
  pill.classList.remove('ok', 'warn', 'error');
  pill.classList.add(tone);
  pill.setAttribute('aria-label', `${text} — click to check MIDI again`);
  byId('midi-status-text').textContent = text;
}

function handleMIDIMessage(event) {
  const data = event.data;
  if (!data || data.length < 2) return;

  const status = data[0];
  const command = status & 0xf0;
  const d1 = data[1];
  const d2 = data.length > 2 ? data[2] : 0;

  if (command === 0x90 && d2 > 0) {
    unlockAudio();
    if (pedal.held.has(d1)) {
      Synth.noteOff(d1);
      pedal.held.delete(d1);
    }
    Synth.noteOn(d1, d2 / 127);
    return;
  }

  if (command === 0x80 || (command === 0x90 && d2 === 0)) {
    if (pedal.down) pedal.held.add(d1);
    else Synth.noteOff(d1);
    return;
  }

  if (command === 0xb0 && d1 === 64) {
    // Sustain pedal
    if (d2 >= 64) {
      pedal.down = true;
    } else {
      pedal.down = false;
      for (const note of pedal.held) Synth.noteOff(note);
      pedal.held.clear();
    }
    return;
  }

  if (command === 0xb0 && (d1 === 120 || d1 === 123)) {
    // All sound off / all notes off
    Synth.allNotesOff();
    pedal.down = false;
    pedal.held.clear();
  }
}

/* ---------------------------------------------------------- start */

initApp();

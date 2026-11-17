/* ============================================================
   Additive Synth — audio engine
   ------------------------------------------------------------
   Every partial is one sine oscillator with its own ADSR gain.
   Played notes are summed into a master bus with a safety
   compressor so a pile of loud partials cannot clip the output.

   This file uses the Web Audio API directly. No audio library is
   required; the waveform is drawn with the Canvas 2D API.
   ============================================================ */

const Synth = (() => {
  const MIN_GAIN = 0.0001; // exponential ramps cannot reach 0
  const MAX_VOICES = 10;
  const MAX_PARTIALS = 16;
  const MAX_FREQ = 18000;
  const RATIO_MIN = 0.01;
  const RATIO_MAX = 32;
  const MASTER_SCALE = 0.35;
  const ENV_LIMITS = { a: 2, d: 2, s: 1, r: 4 };

  const clamp = (value, min, max) => Math.min(max, Math.max(min, value));

  const number = (value, fallback) => {
    const n = Number(value);
    return Number.isFinite(n) ? n : fallback;
  };

  const state = {
    partials: [],
    voices: [],
    masterVolume: 0.7,
    nextId: 1,
    ctx: null,
    mix: null,
    limiter: null,
    voicesListener: null,
    audioListener: null
  };

  const midiToFrequency = (midi) => 440 * Math.pow(2, (midi - 69) / 12);

  /* ----------------------------------------------------------
     Audio graph
     ---------------------------------------------------------- */

  function ensureAudio() {
    if (state.ctx) {
      if (state.ctx.state === 'suspended') {
        state.ctx.resume().then(notifyAudio).catch(() => {});
      }
      return state.ctx;
    }

    const AudioCtor = window.AudioContext || window.webkitAudioContext;
    if (!AudioCtor) return null;

    const ctx = new AudioCtor();

    const mix = ctx.createGain();
    mix.gain.value = state.masterVolume * MASTER_SCALE;

    // A gentle limiter: useful when many in-phase partials stack up.
    const limiter = ctx.createDynamicsCompressor();
    limiter.threshold.value = -10;
    limiter.knee.value = 12;
    limiter.ratio.value = 8;
    limiter.attack.value = 0.003;
    limiter.release.value = 0.25;

    mix.connect(limiter);
    limiter.connect(ctx.destination);

    ctx.onstatechange = notifyAudio;

    state.ctx = ctx;
    state.mix = mix;
    state.limiter = limiter;

    if (ctx.state === 'suspended') {
      ctx.resume().then(notifyAudio).catch(() => {});
    }
    notifyAudio();
    return ctx;
  }

  function setMasterVolume(value) {
    state.masterVolume = clamp(number(value, 0.7), 0, 1);
    if (state.ctx && state.mix) {
      state.mix.gain.setTargetAtTime(
        state.masterVolume * MASTER_SCALE,
        state.ctx.currentTime,
        0.02
      );
    }
    return state.masterVolume;
  }

  /* ----------------------------------------------------------
     Partials
     ---------------------------------------------------------- */

  function addPartial(options = {}) {
    if (state.partials.length >= MAX_PARTIALS) return null;

    const partial = {
      id: state.nextId++,
      amp: clamp(number(options.amp, 0.5), 0, 1),
      ratio: clamp(
        number(options.ratio, state.partials.length + 1),
        RATIO_MIN,
        RATIO_MAX
      ),
      a: clamp(number(options.a, 0.01), 0, ENV_LIMITS.a),
      d: clamp(number(options.d, 0.3), 0, ENV_LIMITS.d),
      s: clamp(number(options.s, 0.6), 0, ENV_LIMITS.s),
      r: clamp(number(options.r, 0.6), 0, ENV_LIMITS.r),
      exp: Boolean(options.exp)
    };

    state.partials.push(partial);

    // If notes are already sounding, bring the new partial in right away.
    if (state.ctx) {
      const when = state.ctx.currentTime + 0.005;
      for (const voice of state.voices) {
        if (!voice.released && !voice.nodes.has(partial.id)) {
          startNode(voice, partial, when);
        }
      }
    }

    return partial;
  }

  function removePartial(id) {
    const index = state.partials.findIndex((p) => p.id === id);
    if (index === -1 || state.partials.length <= 1) return false;

    state.partials.splice(index, 1);

    // Fade the removed partial out of any sounding voices.
    if (state.ctx) {
      const now = state.ctx.currentTime;
      for (const voice of state.voices) {
        const node = voice.nodes.get(id);
        if (!node) continue;

        if (!node.released) {
          const shape = shapeAt(node, now);
          const param = node.gain.gain;
          param.cancelScheduledValues(now);
          param.setValueAtTime(shape * node.peak, now);
          param.linearRampToValueAtTime(0, now + 0.03);
          node.osc.stop(now + 0.05);
          node.released = true;
        }
        voice.nodes.delete(id);
      }
    }

    return true;
  }

  /**
   * Change a partial. Amplitude and frequency are applied to sounding
   * notes immediately. Envelope changes apply to the next note (the
   * current note keeps the envelope it was started with).
   */
  function updatePartial(id, patch) {
    const partial = state.partials.find((p) => p.id === id);
    if (!partial) return;

    if ('amp' in patch) partial.amp = clamp(number(patch.amp, partial.amp), 0, 1);
    if ('ratio' in patch) {
      partial.ratio = clamp(number(patch.ratio, partial.ratio), RATIO_MIN, RATIO_MAX);
    }
    if ('a' in patch) partial.a = clamp(number(patch.a, partial.a), 0, ENV_LIMITS.a);
    if ('d' in patch) partial.d = clamp(number(patch.d, partial.d), 0, ENV_LIMITS.d);
    if ('s' in patch) partial.s = clamp(number(patch.s, partial.s), 0, 1);
    if ('r' in patch) partial.r = clamp(number(patch.r, partial.r), 0, ENV_LIMITS.r);
    if ('exp' in patch) partial.exp = Boolean(patch.exp);

    if (!state.ctx) return;

    const now = state.ctx.currentTime;

    for (const voice of state.voices) {
      const node = voice.nodes.get(id);
      if (!node) continue;

      if ('ratio' in patch && !node.released) {
        const frequency = clamp(voice.baseFreq * partial.ratio, 0.01, MAX_FREQ);
        node.ratio = partial.ratio;
        node.osc.frequency.setTargetAtTime(frequency, now, 0.015);
      }

      if ('amp' in patch) {
        const shape = shapeAt(node, now);
        const oldGain = node.peak * shape;
        const newPeak = Math.max(partial.amp * voice.velocity, MIN_GAIN * 2);

        // Only retarget notes that have finished attack+decay. Doing it
        // earlier would overwrite the envelope that is still scheduled.
        const settled =
          now >=
          node.startTime +
            Math.max(node.env.a, 0.002) +
            Math.max(node.env.d, 0.002);

        if (!node.released && settled) {
          node.peak = newPeak;
          const param = node.gain.gain;
          param.cancelScheduledValues(now);
          param.setValueAtTime(oldGain, now);
          param.linearRampToValueAtTime(newPeak * shape, now + 0.04);
        }
      }
    }
  }

  /* ----------------------------------------------------------
     Patch import / export
     ---------------------------------------------------------- */

  function exportPatch() {
    return {
      format: 'additive-synth-patch',
      version: 1,
      masterVolume: state.masterVolume,
      partials: state.partials.map((partial) => ({
        amp: partial.amp,
        ratio: partial.ratio,
        a: partial.a,
        d: partial.d,
        s: partial.s,
        r: partial.r,
        exp: partial.exp
      }))
    };
  }

  /** Replace the whole patch. Returns false if the file has no partials. */
  function loadPatch(patch) {
    if (!patch || typeof patch !== 'object') return false;

    const incoming = Array.isArray(patch.partials)
      ? patch.partials.filter((item) => item && typeof item === 'object')
      : [];

    if (incoming.length === 0) return false;

    silenceAll();

    state.partials = [];
    state.nextId = 1;

    for (const item of incoming.slice(0, MAX_PARTIALS)) {
      addPartial({
        amp: item.amp,
        ratio: item.ratio,
        a: item.a,
        d: item.d,
        s: item.s,
        r: item.r,
        exp: item.exp
      });
    }

    if ('masterVolume' in patch) setMasterVolume(patch.masterVolume);

    notifyVoices();
    return state.partials.length > 0;
  }

  /* ----------------------------------------------------------
     Envelope
     ---------------------------------------------------------- */

  // Schedules attack + decay, then holds at sustain.
  function scheduleAttack(param, peak, env, t0) {
    const a = Math.max(env.a, 0.003);
    const d = Math.max(env.d, 0.003);
    const sustain = clamp(env.s, 0, 1);

    param.cancelScheduledValues(t0);

    if (env.exp) {
      param.setValueAtTime(MIN_GAIN, t0);
      param.exponentialRampToValueAtTime(Math.max(peak, MIN_GAIN * 2), t0 + a);
      param.exponentialRampToValueAtTime(
        Math.max(peak * sustain, MIN_GAIN),
        t0 + a + d
      );
      if (sustain <= 0) param.setValueAtTime(0, t0 + a + d + 0.005);
    } else {
      param.setValueAtTime(0, t0);
      param.linearRampToValueAtTime(peak, t0 + a);
      param.linearRampToValueAtTime(peak * sustain, t0 + a + d);
    }
  }

  /** Envelope value 0..1 at a given time (used for drawing and release). */
  function shapeAt(node, time) {
    const env = node.env;
    const sustain = clamp(env.s, 0, 1);

    if (node.released) {
      const release = Math.max(node.releaseDuration || env.r, 0.02);
      const x = clamp((time - node.releaseTime) / release, 0, 1);
      const from = Math.max(node.releaseStartLevel, MIN_GAIN);
      if (env.exp) {
        const startGain = from * node.peak;
        return Math.max(
          0,
          (startGain * Math.pow(MIN_GAIN / startGain, x)) / node.peak
        );
      }
      return Math.max(0, from * (1 - x));
    }

    const a = Math.max(env.a, 0.003);
    const d = Math.max(env.d, 0.003);
    const t = Math.max(0, time - node.startTime);

    if (t < a) {
      const x = t / a;
      return env.exp ? Math.pow(MIN_GAIN, 1 - x) : x;
    }
    if (t < a + d) {
      const x = (t - a) / d;
      return env.exp
        ? Math.pow(Math.max(sustain, MIN_GAIN), x)
        : 1 + (sustain - 1) * x;
    }
    return sustain;
  }

  /* ----------------------------------------------------------
     Voices
     ---------------------------------------------------------- */

  function startNode(voice, partial, when) {
    const ctx = state.ctx;
    const osc = ctx.createOscillator();
    osc.type = 'sine';
    const frequency = clamp(voice.baseFreq * partial.ratio, 0.01, MAX_FREQ);
    osc.frequency.setValueAtTime(frequency, when);

    const gain = ctx.createGain();
    const env = {
      a: partial.a,
      d: partial.d,
      s: partial.s,
      r: partial.r,
      exp: partial.exp
    };
    const amplitude = partial.amp * voice.velocity;
    const peak = Math.max(amplitude, MIN_GAIN * 2);

    scheduleAttack(gain.gain, peak, env, when);

    osc.connect(gain);
    gain.connect(state.mix);
    osc.start(when);

    voice.nodes.set(partial.id, {
      partialId: partial.id,
      osc,
      gain,
      env,
      peak,
      ratio: partial.ratio,
      startTime: when,
      released: false,
      releaseTime: 0,
      releaseStartLevel: 0
    });
  }

  function releaseNode(node, fast) {
    if (node.released) return;

    const now = state.ctx.currentTime;
    const shape = Math.max(shapeAt(node, now), MIN_GAIN);
    const startGain = shape * node.peak;
    const release = fast ? 0.04 : Math.max(node.env.r, 0.02);

    node.releaseStartLevel = shape;
    node.releaseTime = now;
    node.releaseDuration = release;
    node.released = true;

    const param = node.gain.gain;
    param.cancelScheduledValues(now);
    param.setValueAtTime(startGain, now);

    if (node.env.exp) {
      param.exponentialRampToValueAtTime(MIN_GAIN, now + release);
      param.setValueAtTime(0, now + release + 0.01);
    } else {
      param.linearRampToValueAtTime(0, now + release);
    }

    node.osc.stop(now + release + 0.04);
  }

  function releaseVoice(voice, fast = false) {
    if (voice.released) return;
    voice.released = true;

    let tail = 0.1;
    for (const node of voice.nodes.values()) {
      if (node.released) continue;
      tail = Math.max(tail, fast ? 0.04 : Math.max(node.env.r, 0.02));
      releaseNode(node, fast);
    }

    setTimeout(() => {
      const index = state.voices.indexOf(voice);
      if (index !== -1) state.voices.splice(index, 1);
      notifyVoices();
    }, (tail + 0.15) * 1000);

    notifyVoices();
  }

  /** Immediately fade out and drop every voice (used when loading a patch). */
  function silenceAll() {
    if (state.ctx) {
      const now = state.ctx.currentTime;

      for (const voice of state.voices) {
        for (const node of voice.nodes.values()) {
          try {
            const param = node.gain.gain;
            const current = Math.max(param.value, 0);
            param.cancelScheduledValues(now);
            param.setValueAtTime(current, now);
            param.linearRampToValueAtTime(0, now + 0.012);
            node.osc.stop(now + 0.02);
          } catch (error) {
            // The oscillator may already have been stopped.
          }
        }
        voice.released = true;
      }
    }

    state.voices = [];
    notifyVoices();
  }

  function noteOn(note, velocity = 0.8) {
    ensureAudio();
    if (!state.ctx) return;

    const midi = clamp(Math.round(number(note, 60)), 0, 127);
    const vel = clamp(number(velocity, 0.8), 0.08, 1);

    const open = state.voices.filter((voice) => !voice.released);
    if (open.length >= MAX_VOICES) releaseVoice(open[0], true);

    const voice = {
      note: midi,
      baseFreq: midiToFrequency(midi),
      velocity: vel,
      released: false,
      nodes: new Map()
    };

    const when = state.ctx.currentTime + 0.005;
    for (const partial of state.partials) startNode(voice, partial, when);
    state.voices.push(voice);
    notifyVoices();
  }

  function noteOff(note) {
    const midi = Math.round(number(note, -1));
    for (let i = state.voices.length - 1; i >= 0; i--) {
      const voice = state.voices[i];
      if (!voice.released && voice.note === midi) {
        releaseVoice(voice);
        return;
      }
    }
  }

  function allNotesOff() {
    for (const voice of state.voices) {
      if (!voice.released) releaseVoice(voice);
    }
  }

  /* ----------------------------------------------------------
     Helpers for the UI / canvas
     ---------------------------------------------------------- */

  /**
   * Live amplitude of every partial, aligned with state.partials.
   * When nothing is playing, show a preview at the sustain level so
   * the shape only changes when you edit it.
   */
  function displayLevels() {
    const live = Boolean(state.ctx && state.ctx.state === 'running');
    const now = live ? state.ctx.currentTime : 0;

    return state.partials.map((partial) => {
      let shape = 0;
      let found = false;

      if (live) {
        for (const voice of state.voices) {
          const node = voice.nodes.get(partial.id);
          if (!node) continue;
          found = true;
          shape = Math.max(shape, shapeAt(node, now));
        }
      }

      if (!found) shape = clamp(partial.s, 0, 1);

      return {
        ratio: partial.ratio,
        level: clamp(partial.amp * shape, 0, 1)
      };
    });
  }

  function notifyVoices() {
    if (typeof state.voicesListener === 'function') state.voicesListener();
  }

  function notifyAudio() {
    if (typeof state.audioListener === 'function') state.audioListener();
  }

  return {
    addPartial,
    removePartial,
    updatePartial,
    exportPatch,
    loadPatch,
    noteOn,
    noteOff,
    allNotesOff,
    ensureAudio,
    setMasterVolume,
    displayLevels,
    onVoicesChange(listener) {
      state.voicesListener = listener;
    },
    onAudioStateChange(listener) {
      state.audioListener = listener;
    },
    get partials() {
      return state.partials;
    },
    get voices() {
      return state.voices;
    },
    get ctx() {
      return state.ctx;
    },
    get masterVolume() {
      return state.masterVolume;
    },
    get maxPartials() {
      return MAX_PARTIALS;
    }
  };
})();

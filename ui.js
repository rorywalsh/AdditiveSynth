/* ============================================================
   Partial controls
   Builds one card per partial from the <template> in index.html.
   ============================================================ */

const PartialUI = (() => {
  const template = document.getElementById('partial-template');
  const container = document.getElementById('partials');
  const addBtn = document.getElementById('add-partial');
  const addText = addBtn.querySelector('.add-text');
  const countEl = document.getElementById('partial-count');
  const countLabel = document.getElementById('partial-count-label');
  const totalEl = document.getElementById('partial-total');
  const saveBtn = document.getElementById('save-patch');
  const loadBtn = document.getElementById('load-patch');
  const fileInput = document.getElementById('patch-file');
  const patchStatus = document.getElementById('patch-status');

  let statusTimer = null;

  const formatTime = (seconds) =>
    seconds >= 1 ? `${seconds.toFixed(2)} s` : `${Math.round(seconds * 1000)} ms`;

  const formatPercent = (value) => `${Math.round(value * 100)}%`;

  const formatRatio = (value) => String(Math.round(value * 1000) / 1000);

  function paintRange(input) {
    const min = Number(input.min) || 0;
    const max = Number(input.max) || 1;
    const value = Number(input.value);
    const percent = max === min ? 0 : ((value - min) / (max - min)) * 100;
    input.style.setProperty(
      '--fill',
      `${Math.min(100, Math.max(0, percent))}%`
    );
  }

  function createCard(partial, index) {
    const card = template.content.firstElementChild.cloneNode(true);
    const q = (selector) => card.querySelector(selector);

    card.dataset.id = String(partial.id);
    card.style.setProperty(
      '--hue',
      String(Math.round((168 + index * 137.5) % 360))
    );
    q('.partial-number').textContent = String(index + 1);

    const removeBtn = q('.remove-btn');
    removeBtn.setAttribute('aria-label', `Remove partial ${index + 1}`);

    /* ---- amplitude ---- */
    const amp = q('.amp');
    const ampOut = q('.amp-out');
    amp.value = String(partial.amp);
    ampOut.textContent = partial.amp.toFixed(2);
    paintRange(amp);

    amp.addEventListener('input', () => {
      const value = Number(amp.value);
      Synth.updatePartial(partial.id, { amp: value });
      ampOut.textContent = value.toFixed(2);
      paintRange(amp);
    });

    /* ---- frequency multiple ---- */
    const ratio = q('.ratio');
    const chip = q('.ratio-chip');

    const showRatio = () => {
      ratio.value = formatRatio(partial.ratio);
      chip.textContent = `×${formatRatio(partial.ratio)}`;
    };
    showRatio();

    const applyRatio = () => {
      const value = Number(ratio.value);
      if (!Number.isFinite(value) || value <= 0) return;
      Synth.updatePartial(partial.id, { ratio: value });
      chip.textContent = `×${formatRatio(partial.ratio)}`;
    };

    ratio.addEventListener('input', applyRatio);
    ratio.addEventListener('change', () => {
      let value = Number(ratio.value);
      if (!Number.isFinite(value) || value <= 0) value = 1;
      value = Math.min(32, Math.max(0.01, value));
      Synth.updatePartial(partial.id, { ratio: value });
      showRatio();
    });

    /* ---- ADSR ---- */
    const timeControls = [
      ['a', '.a', '.a-out'],
      ['d', '.d', '.d-out'],
      ['r', '.r', '.r-out']
    ];

    for (const [key, inputSelector, outputSelector] of timeControls) {
      const input = q(inputSelector);
      const output = q(outputSelector);

      input.value = String(Math.round(partial[key] * 1000));
      output.textContent = formatTime(partial[key]);
      paintRange(input);

      input.addEventListener('input', () => {
        const seconds = Number(input.value) / 1000;
        Synth.updatePartial(partial.id, { [key]: seconds });
        output.textContent = formatTime(seconds);
        paintRange(input);
      });
    }

    const sustain = q('.s');
    const sustainOut = q('.s-out');
    sustain.value = String(partial.s);
    sustainOut.textContent = formatPercent(partial.s);
    paintRange(sustain);

    sustain.addEventListener('input', () => {
      const value = Number(sustain.value);
      Synth.updatePartial(partial.id, { s: value });
      sustainOut.textContent = formatPercent(value);
      paintRange(sustain);
    });

    /* ---- exponential toggle ---- */
    const exp = q('.exp');
    exp.checked = partial.exp;
    exp.addEventListener('change', () => {
      Synth.updatePartial(partial.id, { exp: exp.checked });
    });

    /* ---- remove ---- */
    removeBtn.addEventListener('click', () => {
      if (Synth.partials.length <= 1) return;
      Synth.removePartial(partial.id);
      render();
    });

    return card;
  }

  function render() {
    container.replaceChildren();
    Synth.partials.forEach((partial, index) => {
      container.appendChild(createCard(partial, index));
    });

    const count = Synth.partials.length;
    countEl.textContent = String(count);
    countLabel.textContent = count === 1 ? 'partial' : 'partials';
    totalEl.textContent = `${count} / ${Synth.maxPartials}`;

    const full = count >= Synth.maxPartials;
    addBtn.disabled = full;
    addText.textContent = full ? 'Maximum partials reached' : 'Add partial';

    const canRemove = count > 1;
    container.querySelectorAll('.remove-btn').forEach((btn) => {
      btn.disabled = !canRemove;
    });
  }

  function addPartial() {
    const partial = Synth.addPartial();
    if (!partial) return;

    render();

    const card = container.querySelector(`[data-id="${partial.id}"]`);
    if (card) {
      card.classList.add('is-new');
      card.scrollIntoView({ behavior: 'smooth', block: 'nearest' });
      setTimeout(() => card.classList.remove('is-new'), 900);
    }
  }

  /* ---------------------------------------------------------- patches */

  function showPatchStatus(text, tone = '') {
    patchStatus.textContent = text;
    patchStatus.classList.remove('ok', 'error');
    if (tone) patchStatus.classList.add(tone);

    clearTimeout(statusTimer);
    if (text) {
      statusTimer = setTimeout(() => {
        patchStatus.textContent = '';
        patchStatus.classList.remove('ok', 'error');
      }, tone === 'error' ? 7000 : 4000);
    }
  }

  function patchFilename() {
    const pad = (value) => String(value).padStart(2, '0');
    const now = new Date();
    return (
      [
        'additive-patch',
        `${now.getFullYear()}${pad(now.getMonth() + 1)}${pad(now.getDate())}`,
        `${pad(now.getHours())}${pad(now.getMinutes())}`
      ].join('-') + '.json'
    );
  }

  function downloadPatch() {
    const json = JSON.stringify(Synth.exportPatch(), null, 2);
    const blob = new Blob([json], { type: 'application/json' });
    const url = URL.createObjectURL(blob);
    const link = document.createElement('a');

    link.href = url;
    link.download = patchFilename();
    document.body.appendChild(link);
    link.click();
    link.remove();

    setTimeout(() => URL.revokeObjectURL(url), 30000);
    showPatchStatus('Patch downloaded', 'ok');
  }

  async function loadPatchFile() {
    const file = fileInput.files && fileInput.files[0];
    fileInput.value = '';
    if (!file) return;

    try {
      const text = await file.text();
      let patch;

      try {
        patch = JSON.parse(text);
      } catch (error) {
        throw new Error('that file is not valid JSON');
      }

      if (!Synth.loadPatch(patch)) {
        throw new Error('that file does not contain any partials');
      }

      render();
      syncMasterVolume();
      showPatchStatus(`Loaded ${file.name}`, 'ok');
    } catch (error) {
      showPatchStatus(`Could not load patch: ${error.message}`, 'error');
    }
  }

  function wirePatches() {
    saveBtn.addEventListener('click', downloadPatch);
    loadBtn.addEventListener('click', () => {
      fileInput.value = '';
      fileInput.click();
    });
    fileInput.addEventListener('change', loadPatchFile);
  }

  /* ---------------------------------------------------------- master */

  function syncMasterVolume() {
    const input = document.getElementById('master-volume');
    const output = document.getElementById('master-volume-out');
    if (!input || !output) return;

    input.value = String(Synth.masterVolume);
    output.textContent = formatPercent(Synth.masterVolume);
    paintRange(input);
  }

  function initMasterVolume() {
    const input = document.getElementById('master-volume');
    const output = document.getElementById('master-volume-out');
    if (!input || !output) return;

    syncMasterVolume();

    input.addEventListener('input', () => {
      const value = Number(input.value);
      Synth.setMasterVolume(value);
      output.textContent = formatPercent(value);
      paintRange(input);
    });
  }

  function init() {
    addBtn.addEventListener('click', addPartial);
    wirePatches();
    initMasterVolume();
    render();
  }

  return { init, render, paintRange };
})();

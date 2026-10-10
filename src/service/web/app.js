// app.js
//
// Vanilla JS, no build step, no framework. Reads GET /schema at load time
// and builds the parameter form from it -- field names, types, bounds, and
// descriptions all come from the response, not from constants hardcoded
// here. If a field is added, removed, or changes its bounds on the server
// (presets.mjs's buildParameterSchema), this file does not need to change
// to pick that up, *except* for the small set of field names special-cased
// below (see SKIP_AS_FORM_FIELDS) -- that boundary is deliberate and
// documented where it happens, not accidental.
//
// Everything the form ever POSTs to /generate is built from the live DOM
// control values at submit time -- there is no hidden client-side model of
// "what a request looks like" that could drift from what's on screen.

const state = {
  schema: null,
  presets: null,
  fieldControls: new Map(), // name -> { get, set, row, spec }
  currentObjectUrl: null,
  abortController: null,
};

// Fields that exist in the real /generate parameter space (and so are
// documented in GET /schema, honestly) but are rendered as *prefill*
// quick-start buttons instead of ordinary form fields -- see the
// Quick-start section. This mirrors presets.mjs's own precedence rule
// (explicit body fields always win over preset/mood/intensity) by simply
// never sending these three: the GUI always submits concrete, explicit
// values for every other field, so preset/mood/intensity would be
// redundant on the wire even if included. This is the one place this file
// hardcodes field *names* rather than deriving behavior purely from
// `type` -- everything else here dispatches on schema.parameters[name].type.
const SKIP_AS_FORM_FIELDS = new Set(['preset', 'mood', 'intensity']);

async function fetchJSON(path) {
  const res = await fetch(path);
  if (!res.ok) throw new Error(`${path} -> HTTP ${res.status}`);
  return res.json();
}

function el(tag, attrs = {}, children = []) {
  const node = document.createElement(tag);
  for (const [k, v] of Object.entries(attrs)) {
    if (k === 'text') node.textContent = v;
    else if (k === 'html') node.innerHTML = v;
    else if (v !== undefined && v !== null) node.setAttribute(k, v);
  }
  for (const child of children) if (child) node.appendChild(child);
  return node;
}

function fmtNum(x, digits = 4) {
  return Number.isFinite(x) ? Number(x).toFixed(digits) : String(x);
}

// --- generic field renderers -------------------------------------------

/**
 * Renders one number input from a schema number-spec. Returns
 * {controlEl, get, set}.
 */
function renderNumberInput(name, spec) {
  const input = el('input', {
    type: 'number',
    id: `field-${name}`,
    ...(spec.min !== undefined ? { min: spec.min } : {}),
    ...(spec.max !== undefined ? { max: spec.max } : {}),
    step: spec.step ?? 'any',
  });
  input.value = spec.default ?? '';
  return {
    controlEl: input,
    get: () => (input.value === '' ? undefined : Number(input.value)),
    set: (v) => { input.value = v; },
  };
}

function renderBooleanInput(name, spec) {
  const input = el('input', { type: 'checkbox', id: `field-${name}` });
  input.checked = Boolean(spec.default);
  const row = el('div', { class: 'checkbox-row' }, [input, el('label', { for: `field-${name}`, text: spec.default ? 'on' : '' })]);
  return {
    controlEl: row,
    get: () => input.checked,
    set: (v) => { input.checked = Boolean(v); },
    rawInput: input,
  };
}

/**
 * `values` may be a plain array of strings, or an object map (name ->
 * metadata), e.g. reverbPreset's values are {deepAmbient: {decaySec,...},
 * ...} -- the real DSP numbers behind each named preset, shown in the note
 * area rather than hidden. Either shape renders as a <select>.
 */
function renderEnumInput(name, spec, noteExtraEl) {
  const isMap = spec.values && !Array.isArray(spec.values);
  const optionNames = isMap ? Object.keys(spec.values) : spec.values;
  const select = el('select', { id: `field-${name}` });
  for (const v of optionNames) select.appendChild(el('option', { value: v, text: v }));
  if (spec.default !== undefined) select.value = spec.default;

  if (isMap && noteExtraEl) {
    const updateExtra = () => {
      const meta = spec.values[select.value];
      if (!meta) { noteExtraEl.textContent = ''; return; }
      const parts = Object.entries(meta).map(([k, v]) => `${k}=${typeof v === 'number' ? fmtNum(v, 3) : v}`);
      noteExtraEl.innerHTML = `<span class="num">${parts.join(', ')}</span>`;
    };
    select.addEventListener('change', updateExtra);
    updateExtra();
  }

  return {
    controlEl: select,
    get: () => select.value,
    set: (v) => { select.value = v; },
  };
}

function renderStringInput(name, spec) {
  const input = el('input', { type: 'text', id: `field-${name}`, placeholder: spec.optional ? '(random)' : '' });
  return {
    controlEl: input,
    get: () => (input.value.trim() === '' ? undefined : input.value.trim()),
    set: (v) => { input.value = v ?? ''; },
  };
}

/**
 * Renders a schema "oneOf" field (currently just `mode`) generically: a
 * toggle between its `options`, where each option is either an enum
 * (`values`) or a nested object (`fields`, each itself rendered by the same
 * per-type renderers as top-level fields). Nothing here is specific to
 * "mode" by name -- it reads whatever options/fields the schema hands it.
 */
function renderOneOfInput(name, spec) {
  const wrap = el('div', {});
  const toggle = el('div', { class: 'mode-toggle' });
  const subareas = [];
  let activeIndex = 0;

  spec.options.forEach((opt, i) => {
    const radioId = `field-${name}-opt-${i}`;
    const radio = el('input', { type: 'radio', name: `${name}-kind`, id: radioId });
    if (i === 0) radio.checked = true;
    toggle.appendChild(el('label', { for: radioId }, [radio, document.createTextNode(` ${opt.kind}`)]));

    let subGet;
    let subSet;
    const area = el('div', {});
    if (opt.values) {
      const { controlEl, get, set } = renderEnumInput(`${name}-${opt.kind}`, { values: opt.values, default: spec.default });
      area.appendChild(controlEl);
      subGet = () => get();
      subSet = (v) => set(v);
    } else if (opt.fields) {
      const coordWrap = el('div', { class: 'coord-fields' });
      const subControls = {};
      for (const [fieldName, fieldSpec] of Object.entries(opt.fields)) {
        if (fieldSpec.fixed !== undefined) continue; // e.g. chromaticUniverse -- not user-editable, always the fixed value
        const built = buildTypedControl(`${name}-${fieldName}`, fieldSpec);
        subControls[fieldName] = built;
        coordWrap.appendChild(el('div', { class: 'coord-field' }, [
          el('label', { for: built.controlEl.id || '', text: fieldName }),
          built.controlEl,
        ]));
      }
      area.appendChild(coordWrap);
      subGet = () => {
        const out = {};
        for (const [fieldName, ctrl] of Object.entries(subControls)) out[fieldName] = ctrl.get();
        for (const [fieldName, fieldSpec] of Object.entries(opt.fields)) if (fieldSpec.fixed !== undefined) out[fieldName] = fieldSpec.fixed;
        return out;
      };
      subSet = (v) => {
        if (!v || typeof v !== 'object') return;
        for (const [fieldName, ctrl] of Object.entries(subControls)) if (v[fieldName] !== undefined) ctrl.set(v[fieldName]);
      };
    }
    area.hidden = i !== 0;
    subareas.push({ get: subGet, set: subSet, area });
    radio.addEventListener('change', () => {
      activeIndex = i;
      subareas.forEach((s, j) => { s.area.hidden = j !== i; });
    });
    wrap.appendChild(area);
  });

  wrap.insertBefore(toggle, wrap.firstChild);

  return {
    controlEl: wrap,
    get: () => subareas[activeIndex].get(),
    set: (v) => {
      if (typeof v === 'string') {
        activeIndex = 0;
      } else if (v && typeof v === 'object') {
        activeIndex = 1;
      }
      const radios = toggle.querySelectorAll('input[type="radio"]');
      radios.forEach((r, i) => { r.checked = i === activeIndex; });
      subareas.forEach((s, j) => { s.area.hidden = j !== activeIndex; });
      subareas[activeIndex].set(v);
    },
  };
}

function buildTypedControl(name, spec) {
  switch (spec.type) {
    case 'number': return renderNumberInput(name, spec);
    case 'boolean': return renderBooleanInput(name, spec);
    case 'enum': return renderEnumInput(name, spec, null);
    case 'string': return renderStringInput(name, spec);
    case 'oneOf': return renderOneOfInput(name, spec);
    default: return renderStringInput(name, spec);
  }
}

/**
 * Builds one full parameter row: label, control, and an adjacent sidenote
 * carrying the schema's own description text -- the Tufte move of putting
 * the explanation directly beside the control rather than behind a tooltip.
 */
function buildParamRow(name, spec) {
  const noteExtraEl = el('div', { class: 'param-note-extra' });
  const control = spec.type === 'enum'
    ? renderEnumInput(name, spec, noteExtraEl)
    : buildTypedControl(name, spec);
  if (control.controlEl && !control.controlEl.id) control.controlEl.id = `field-${name}`;

  const annotation = [spec.unit ? `(${spec.unit})` : '', spec.optional ? '[optional]' : ''].filter(Boolean).join(' ');
  const noteParts = [el('span', { text: spec.description || '' })];
  if (spec.min !== undefined || spec.max !== undefined) {
    const bounds = [];
    if (spec.min !== undefined) bounds.push(`min ${spec.min}`);
    if (spec.max !== undefined) bounds.push(`max ${spec.max}`);
    noteParts.push(el('div', { class: 'num', text: bounds.join(', ') }));
  }
  noteParts.push(noteExtraEl);

  const labelChildren = [el('span', { class: 'field-name', text: name })];
  if (annotation) labelChildren.push(el('span', { class: 'field-annotation', text: ` ${annotation}` }));

  const row = el('div', { class: 'param-row', 'data-field': name }, [
    el('div', { class: 'param-control' }, [
      el('label', { class: 'field-label', for: control.controlEl.id || '' }, labelChildren),
      control.controlEl,
    ]),
    el('div', { class: 'param-note' }, noteParts),
  ]);

  return { row, control, spec };
}

// --- visibility (appliesWhen) --------------------------------------------

function readFieldValue(name) {
  const entry = state.fieldControls.get(name);
  return entry ? entry.control.get() : undefined;
}

function refreshVisibility() {
  for (const [name, entry] of state.fieldControls) {
    const cond = entry.spec.appliesWhen;
    let visible = true;
    if (cond) {
      for (const [depName, expected] of Object.entries(cond)) {
        if (readFieldValue(depName) !== expected) visible = false;
      }
    }
    entry.row.hidden = !visible;
  }
}

// --- request body assembly -------------------------------------------------

function buildRequestBody() {
  const body = {};
  for (const [name, entry] of state.fieldControls) {
    if (entry.row.hidden) continue; // e.g. durationSec when loop is on, or vice versa
    const v = entry.control.get();
    if (v === undefined) continue;
    if (entry.spec.type === 'number' && !Number.isFinite(v)) continue;
    body[name] = v;
  }
  return body;
}

// --- schema-driven form construction ---------------------------------------

function buildForm(schema) {
  const grid = document.getElementById('param-grid');
  grid.innerHTML = '';
  state.fieldControls.clear();

  for (const [name, spec] of Object.entries(schema.parameters)) {
    if (SKIP_AS_FORM_FIELDS.has(name)) continue;
    const { row, control } = buildParamRow(name, spec);
    grid.appendChild(row);
    state.fieldControls.set(name, { row, control, spec });

    // Any control's change can affect any other field's appliesWhen, so
    // wire a blanket listener rather than special-casing "loop" by name.
    const listenTarget = control.rawInput || control.controlEl;
    listenTarget.addEventListener('change', refreshVisibility);
    listenTarget.addEventListener('input', refreshVisibility);
  }

  refreshVisibility();
  document.getElementById('generate-button').disabled = false;
}

// --- quick-start (presets / mood) -------------------------------------------

function applyValuesToForm(values) {
  for (const [name, v] of Object.entries(values)) {
    const entry = state.fieldControls.get(name);
    if (entry) entry.control.set(v);
  }
  refreshVisibility();
}

function buildQuickstart(presetsData) {
  const presetList = document.getElementById('preset-list');
  presetList.innerHTML = '';
  const allPresets = { ...presetsData.stingers, ...presetsData.beds };
  for (const [id, p] of Object.entries(allPresets)) {
    const btn = el('button', { type: 'button', text: id, title: p.description || '' });
    btn.addEventListener('click', () => {
      applyValuesToForm({
        loop: Boolean(p.loop),
        durationSec: p.durationSec,
        loopSec: p.loopSec,
        loopFadeSec: p.loopFadeSec,
        mode: p.mode,
        root: p.root,
        reverbPreset: p.reverbPreset,
        melody: p.melody,
      });
    });
    presetList.appendChild(el('li', {}, [btn]));
  }

  const moodList = document.getElementById('mood-list');
  moodList.innerHTML = '';
  for (const [name, bundle] of Object.entries(presetsData.moods)) {
    const btn = el('button', { type: 'button', text: name });
    btn.addEventListener('click', () => applyValuesToForm(bundle));
    moodList.appendChild(el('li', {}, [btn]));
  }
}

// --- render/status/result ----------------------------------------------

let elapsedTimer = null;

function startElapsedTimer(estimateSec) {
  const statusLine = document.getElementById('status-line');
  const t0 = performance.now();
  const tick = () => {
    const elapsed = (performance.now() - t0) / 1000;
    statusLine.innerHTML = `rendering&hellip; <span class="num">${elapsed.toFixed(1)}s</span> elapsed (estimate: <span class="num">~${estimateSec.toFixed(1)}s</span>, based on the measured ~1:9 render-time-to-audio ratio -- an estimate, not a guarantee)`;
  };
  tick();
  elapsedTimer = setInterval(tick, 100);
  return () => { clearInterval(elapsedTimer); elapsedTimer = null; };
}

function showError(err) {
  const box = document.getElementById('error-box');
  box.hidden = false;
  box.innerHTML = '';
  box.appendChild(el('div', { text: err.message || String(err) }));
  if (Array.isArray(err.details)) {
    const ul = el('ul', {});
    for (const d of err.details) ul.appendChild(el('li', { text: d }));
    box.appendChild(ul);
  }
}

function clearError() {
  const box = document.getElementById('error-box');
  box.hidden = true;
  box.innerHTML = '';
}

function drawWaveform(canvas, channelData, peak, rms) {
  const ctx = canvas.getContext('2d');
  const w = canvas.width;
  const h = canvas.height;
  const mid = h / 2;
  ctx.clearRect(0, 0, w, h);

  const styles = getComputedStyle(document.documentElement);
  const fg = styles.getPropertyValue('--fg').trim() || '#111';
  const muted = styles.getPropertyValue('--muted').trim() || '#555';
  const accent = styles.getPropertyValue('--accent').trim() || '#a3392f';
  const rule = styles.getPropertyValue('--rule').trim() || '#ccc';

  // Zero line
  ctx.strokeStyle = rule;
  ctx.lineWidth = 1;
  ctx.beginPath();
  ctx.moveTo(0, mid);
  ctx.lineTo(w, mid);
  ctx.stroke();

  // Min/max envelope per pixel column -- a dense, static amplitude-vs-time
  // plot (the ordinary way to actually see what a waveform did), not an
  // animated bars-and-glow "visualizer".
  const samplesPerPixel = Math.max(1, Math.floor(channelData.length / w));
  ctx.strokeStyle = fg;
  ctx.lineWidth = 1;
  ctx.beginPath();
  for (let x = 0; x < w; x++) {
    const start = x * samplesPerPixel;
    const end = Math.min(channelData.length, start + samplesPerPixel);
    let lo = 1;
    let hi = -1;
    for (let i = start; i < end; i++) {
      const s = channelData[i];
      if (s < lo) lo = s;
      if (s > hi) hi = s;
    }
    if (lo > hi) { lo = 0; hi = 0; }
    ctx.moveTo(x, mid - hi * mid);
    ctx.lineTo(x, mid - lo * mid);
  }
  ctx.stroke();

  // Peak and RMS reference lines, labeled with the actual measured numbers
  // (from the response headers -- the server's own measurement, not
  // recomputed client-side) rather than a decorative meter/gauge. RMS is
  // mathematically always <= peak, so peak's line is always at or above
  // RMS's line -- labelDir pushes the peak label further up and the RMS
  // label further down so the two never overlap even when the two values
  // are close together (a quiet, mostly-uniform-level render).
  const drawRefLine = (level, label, color, labelDir) => {
    const y = mid - level * mid;
    ctx.strokeStyle = color;
    ctx.setLineDash([4, 3]);
    ctx.beginPath();
    ctx.moveTo(0, y);
    ctx.lineTo(w, y);
    ctx.stroke();
    ctx.setLineDash([]);
    ctx.fillStyle = color;
    ctx.font = '11px ui-monospace, monospace';
    const textY = labelDir < 0 ? Math.max(11, y - 4) : Math.min(h - 3, y + 13);
    ctx.fillText(`${label} ${level.toFixed(4)}`, 4, textY);
  };
  if (Number.isFinite(peak)) drawRefLine(peak, 'peak', accent, -1);
  if (Number.isFinite(rms)) drawRefLine(rms, 'rms', muted, 1);
}

async function handleSubmit(evt) {
  evt.preventDefault();
  clearError();
  document.getElementById('result-section').hidden = true;

  const body = buildRequestBody();
  const isLoop = Boolean(body.loop);
  const seconds = isLoop ? Number(body.loopSec) : Number(body.durationSec);
  const estimate = Number.isFinite(seconds) ? seconds * state.schema.estimatedRenderSecondsPerAudioSecond : 0;

  const genButton = document.getElementById('generate-button');
  const cancelButton = document.getElementById('cancel-button');
  genButton.disabled = true;
  cancelButton.hidden = false;
  const stopTimer = startElapsedTimer(estimate);

  state.abortController = new AbortController();

  try {
    const res = await fetch('/generate', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(body),
      signal: state.abortController.signal,
    });

    if (!res.ok) {
      let payload;
      try { payload = await res.json(); } catch { payload = { error: `HTTP ${res.status}` }; }
      const err = new Error(payload.error || `HTTP ${res.status}`);
      err.details = payload.details;
      throw err;
    }

    const headers = {};
    for (const [k, v] of res.headers.entries()) if (k.startsWith('x-track-')) headers[k] = v;

    const arrayBuffer = await res.arrayBuffer();
    if (state.currentObjectUrl) URL.revokeObjectURL(state.currentObjectUrl);
    const blob = new Blob([arrayBuffer], { type: 'audio/wav' });
    state.currentObjectUrl = URL.createObjectURL(blob);

    const player = document.getElementById('audio-player');
    player.src = state.currentObjectUrl;
    const dl = document.getElementById('download-link');
    dl.href = state.currentObjectUrl;
    dl.setAttribute('download', `track-${Date.now()}.wav`);

    renderMetrics(headers);

    // Decode for the waveform display -- a fresh copy of the bytes, since
    // decodeAudioData detaches/consumes the ArrayBuffer it's given.
    const audioCtx = new (window.AudioContext || window.webkitAudioContext)();
    const decoded = await audioCtx.decodeAudioData(arrayBuffer.slice(0));
    const canvas = document.getElementById('waveform');
    drawWaveform(canvas, decoded.getChannelData(0), Number(headers['x-track-peak']), Number(headers['x-track-rms']));
    document.getElementById('waveform-caption').textContent =
      `${decoded.duration.toFixed(2)}s, ${decoded.sampleRate}Hz, ${decoded.numberOfChannels}ch -- left channel shown, min/max per-pixel envelope`;
    audioCtx.close();

    document.getElementById('result-section').hidden = false;
    document.getElementById('status-line').textContent = 'done';
  } catch (err) {
    if (err.name === 'AbortError') {
      document.getElementById('status-line').textContent = 'cancelled (client-side only -- the server-side render, if already started in its worker thread, keeps running to completion; there is no cancel-in-flight API)';
    } else {
      document.getElementById('status-line').textContent = '';
      showError(err);
    }
  } finally {
    stopTimer();
    genButton.disabled = false;
    cancelButton.hidden = true;
    state.abortController = null;
  }
}

function renderMetrics(headers) {
  const table = document.getElementById('metrics-table');
  table.innerHTML = '';
  const rows = [
    ['duration', headers['x-track-duration-sec'], 's'],
    ['sample rate', headers['x-track-sample-rate'], 'Hz'],
    ['peak', headers['x-track-peak'] && fmtNum(Number(headers['x-track-peak'])), ''],
    ['rms', headers['x-track-rms'] && fmtNum(Number(headers['x-track-rms'])), ''],
    ['loop', headers['x-track-loop'], ''],
    ['final regime', headers['x-track-final-regime'], ''],
    ['spiral count', headers['x-track-spiral-count'], ''],
    ['regime transitions', headers['x-track-regime-transitions'], ''],
    ['melody note onsets', headers['x-track-melody-note-onsets'], ''],
    ['melody unique degrees', headers['x-track-melody-unique-degrees'], ''],
    ['melody unique durations', headers['x-track-melody-unique-durations'], ''],
  ];
  for (const [label, value, unit] of rows) {
    if (value === undefined || value === null || value === '') continue;
    table.appendChild(el('tr', {}, [
      el('td', { class: 'label', text: label }),
      el('td', { text: `${value}${unit}` }),
    ]));
  }
}

// --- init ------------------------------------------------------------------

async function init() {
  try {
    const [schema, presetsData] = await Promise.all([fetchJSON('/schema'), fetchJSON('/presets')]);
    state.schema = schema;
    state.presets = presetsData;
    buildForm(schema);
    buildQuickstart(presetsData);
  } catch (err) {
    document.getElementById('param-grid').innerHTML = '';
    showError(new Error(`failed to load schema/presets from the server: ${err.message}`));
  }
}

document.getElementById('generate-form').addEventListener('submit', handleSubmit);
document.getElementById('cancel-button').addEventListener('click', () => {
  if (state.abortController) state.abortController.abort();
});

init();

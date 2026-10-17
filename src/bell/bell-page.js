// 鐘の試作ページ。本体（index.html）とは別に動く。本体のコードは変えずに、部品だけ借りる
import '../ui/version-check.js'; // 最初に読む：版の食い違いとエラーを画面に出す
import { VERSION } from '../version.js';
import { SCC_COMPAT } from '../core/config.js';
import { DEFAULT_SLIDER, sliderToGain } from '../core/post-stage.js';
import { Keyboard, noteName } from '../ui/keyboard.js';
import { BELL_PRESETS, BELL_CHANNELS, normalizeParams, noteToHz, hzToPeriod } from './bell-voice.js';

const SHARED_WAVE_CH = 4; // ch5（番号4）の波形は ch4 と同じ（SCCの仕様）

const $ = (id) => /** @type {HTMLElement} */ (document.getElementById(id));
const STORE_KEY = 'bell-params-v2'; // 形が変わったので、前の版の保存とは別にする
const POLL_MS = 33;

$('version').textContent = VERSION;

// ---- 音声（「音を出す」の後にだけ開始する） ----
/** @type {AudioContext | null} */ let ctx = null;
/** @type {AudioWorkletNode | null} */ let node = null;
let pollTimer = 0;
const send = (msg) => node?.port.postMessage(msg);

async function start() {
  if (globalThis.isSecureContext === false) throw new Error('https か localhost で開いてください（ブラウザの決まりで、それ以外では音を出せません）');
  const AC = globalThis.AudioContext ?? globalThis.webkitAudioContext;
  if (!AC) throw new Error('このブラウザでは音を出せません');
  const c = new AC({ latencyHint: 'interactive' });
  try {
    if (!c.audioWorklet) throw new Error('このブラウザでは音を出せません（AudioWorklet が使えません）');
    await c.audioWorklet.addModule(new URL('./bell-worklet.js', import.meta.url));
    const n = new AudioWorkletNode(c, 'bell-processor', { numberOfInputs: 0, numberOfOutputs: 1, outputChannelCount: [2] });
    n.port.onmessage = (e) => { if (e.data?.type === 'state') renderLive(e.data.channels); };
    n.connect(c.destination);
    if (c.state !== 'running') await c.resume();
    ctx = c;
    node = n;
  } catch (e) {
    await c.close().catch(() => {});
    throw e;
  }
  send({ type: 'params', params });
  send({ type: 'master', gain: sliderToGain(Number(master.value)) });
  pollTimer = setInterval(() => send({ type: 'poll' }), POLL_MS);
}

async function stop() {
  clearInterval(pollTimer);
  node?.disconnect();
  node = null;
  const c = ctx;
  ctx = null;
  if (c) await c.close().catch(() => {});
  renderLive(Array.from({ length: BELL_CHANNELS }, () => ({ volume: 0, key: false })));
}

// ---- 設定 ----
/** @type {import('./bell-voice.js').BellParams} */
let params = loadStored() ?? structuredClone(BELL_PRESETS.small.params);
let lastNote = null;

function loadStored() {
  try {
    const s = localStorage.getItem(STORE_KEY);
    return s ? normalizeParams(JSON.parse(s)) : null;
  } catch { return null; }
}

function applyParams(p, { updateInputs = true } = {}) {
  params = normalizeParams(p);
  send({ type: 'params', params });
  try { localStorage.setItem(STORE_KEY, JSON.stringify(params)); } catch { /* 保存できなくても動く */ }
  if (updateInputs) renderInputs();
  renderHz();
  $('json').value = JSON.stringify(params, null, 2);
}

// ---- 出発点と波形 ----
for (const [key, preset] of Object.entries(BELL_PRESETS)) {
  const b = document.createElement('button');
  b.type = 'button';
  b.textContent = preset.label;
  b.addEventListener('click', () => applyParams(structuredClone(preset.params)));
  $('presets').append(b);
}
const lengthInput = /** @type {HTMLInputElement} */ ($('length'));
lengthInput.addEventListener('input', () => {
  $('length-value').textContent = `${Number(lengthInput.value).toFixed(1)}秒`;
  applyParams({ ...params, length: Number(lengthInput.value) }, { updateInputs: false });
});

const master = /** @type {HTMLInputElement} */ ($('master'));
master.value = String(DEFAULT_SLIDER);
master.addEventListener('input', () => {
  $('master-value').textContent = `${master.value}%`;
  send({ type: 'master', gain: sliderToGain(Number(master.value)) });
});
$('master-value').textContent = `${master.value}%`;

const velocity = /** @type {HTMLInputElement} */ ($('velocity'));
velocity.addEventListener('input', () => { $('velocity-value').textContent = Number(velocity.value).toFixed(2); });

// ---- 部分音の表 ----
const FIELDS = [
  { key: 'ratio', label: '比', type: 'number', min: 0.125, max: 16, step: 0.001 },
  { key: 'level', label: '初めの音量', type: 'range', min: 0, max: 15, step: 1 },
  { key: 'decay', label: '減衰（秒）', type: 'range', min: 0.05, max: 10, step: 0.05 },
  { key: 'harmonics', label: '倍音', type: 'text' },
  { key: 'bright', label: '倍音の減衰', type: 'range', min: 0.05, max: 5, step: 0.05 },
  { key: 'cents', label: 'ずらし', type: 'range', min: -50, max: 50, step: 1 },
];
const rows = [];
for (let ch = 0; ch < BELL_CHANNELS; ch++) {
  const tr = document.createElement('tr');
  const head = document.createElement('td');
  head.textContent = String(ch + 1);
  head.dataset.label = 'ch';
  tr.append(head);
  const inputs = {};
  for (const f of FIELDS) {
    const td = document.createElement('td');
    td.dataset.label = f.label; // 狭い画面では、表の見出しの代わりに各欄に出す
    const input = document.createElement('input');
    if (f.type === 'text') {
      input.type = 'text';
      input.inputMode = 'decimal';
      input.className = 'harmonics';
    } else {
      Object.assign(input, { type: f.type, min: f.min, max: f.max, step: f.step });
    }
    input.setAttribute('aria-label', `ch${ch + 1} ${f.label}`);
    const shared = ch === SHARED_WAVE_CH && (f.key === 'harmonics' || f.key === 'bright');
    if (shared) { input.disabled = true; input.title = 'ch4 と同じ（SCCの仕様）'; }
    const readValue = () => (f.key === 'harmonics'
      ? input.value.split(/[,、\s]+/).filter((x) => x !== '').map(Number)
      : Number(input.value));
    input.addEventListener(f.type === 'text' ? 'change' : 'input', () => {
      const partials = params.partials.map((s, i) => (i === ch ? { ...s, [f.key]: readValue() } : s));
      applyParams({ ...params, partials }, { updateInputs: f.key === 'harmonics' || ch === SHARED_WAVE_CH - 1 });
      if (out) out.textContent = fmt(f.key, Number(input.value));
    });
    td.append(input);
    let out = null;
    if (f.type === 'range') {
      out = document.createElement('output');
      td.append(out);
    }
    if (f.key === 'ratio') {
      const hz = document.createElement('span');
      hz.className = 'hz';
      td.append(hz);
      inputs.hz = hz;
    }
    inputs[f.key] = { input, out };
    tr.append(td);
  }
  const live = document.createElement('td');
  live.dataset.label = '今';
  const bar = document.createElement('span');
  bar.className = 'live';
  const liveNum = document.createElement('output');
  live.append(liveNum, bar);
  tr.append(live);
  inputs.live = { bar, liveNum };
  $('partial-rows').append(tr);
  rows.push(inputs);
}

function fmt(key, v) {
  if (key === 'decay' || key === 'bright') return v.toFixed(2);
  if (key === 'cents') return (v > 0 ? '+' : '') + v;
  return String(v);
}

function renderInputs() {
  lengthInput.value = String(params.length);
  $('length-value').textContent = `${params.length.toFixed(1)}秒`;
  params.partials.forEach((s, ch) => {
    for (const f of FIELDS) {
      const { input, out } = rows[ch][f.key];
      input.value = f.key === 'harmonics' ? s.harmonics.join(', ') : String(s[f.key]);
      if (out) out.textContent = fmt(f.key, s[f.key]);
    }
  });
}

/** 今の鍵の高さで、各部分音が実際に何Hzになるか（SCCの周波数の値は整数なので、少しずれる） */
function renderHz() {
  const note = lastNote ?? 60;
  params.partials.forEach((s, ch) => {
    const want = noteToHz(note) * s.ratio * 2 ** (s.cents / 1200);
    const tp = hzToPeriod(want, SCC_COMPAT.clock);
    rows[ch].hz.textContent = tp > 8 ? `${noteName(note)}で ${(SCC_COMPAT.clock / (32 * (tp + 1))).toFixed(1)}Hz` : '高すぎて鳴らない';
  });
}

function renderLive(channels) {
  channels.slice(0, BELL_CHANNELS).forEach((c, ch) => {
    const v = c.key ? c.volume : 0;
    rows[ch].live.liveNum.textContent = String(v);
    rows[ch].live.bar.style.width = `${v * 3}px`;
  });
}

// ---- 鍵盤 ----
function strike(note) {
  if (!node) return;
  lastNote = note;
  $('last-note').textContent = noteName(note);
  renderHz();
  send({ type: 'strike', note, velocity: Number(velocity.value) });
}
const keyboard = new Keyboard($('keyboard'), { onDown: strike, onUp: () => {}, base: 48 });
const updateOctave = () => { $('octave-label').textContent = keyboard.rangeLabel; };
$('keyboard').addEventListener('octavechange', updateOctave);
$('oct-down').addEventListener('click', () => { keyboard.shift(-1); updateOctave(); });
$('oct-up').addEventListener('click', () => { keyboard.shift(1); updateOctave(); });
$('again').addEventListener('click', () => { if (lastNote !== null) strike(lastNote); });
$('stop').addEventListener('click', () => send({ type: 'stop' }));
updateOctave();

// ---- 設定の書き出し・読み込み ----
$('copy').addEventListener('click', async () => {
  try {
    await navigator.clipboard.writeText(/** @type {HTMLTextAreaElement} */ ($('json')).value);
    $('json-msg').textContent = '写しました';
  } catch {
    /** @type {HTMLTextAreaElement} */ ($('json')).select();
    $('json-msg').textContent = '選んだ状態にしました。手で写してください';
  }
});
$('load').addEventListener('click', () => {
  try {
    applyParams(JSON.parse(/** @type {HTMLTextAreaElement} */ ($('json')).value));
    $('json-msg').textContent = '読み込みました';
  } catch (e) {
    $('json-msg').textContent = `読み込めません：${e.message}`;
  }
});

// ---- 開始・停止 ----
const startBtn = /** @type {HTMLButtonElement} */ ($('start'));
function setRunning(on) {
  startBtn.textContent = on ? '■ 止める' : '▶ 音を出す';
  startBtn.classList.toggle('running', on);
  master.disabled = !on;
  for (const id of ['oct-down', 'oct-up', 'again', 'stop']) /** @type {HTMLButtonElement} */ ($(id)).disabled = !on;
  keyboard.setEnabled(on);
}
startBtn.addEventListener('click', async () => {
  startBtn.disabled = true;
  $('error').hidden = true;
  try {
    if (node) { await stop(); setRunning(false); } else { await start(); setRunning(true); }
  } catch (e) {
    $('error').hidden = false;
    $('error').textContent = String(e.message ?? e);
    setRunning(false);
  } finally {
    startBtn.disabled = false;
  }
});

applyParams(params);
setRunning(false);
if (globalThis.isSecureContext === false) {
  $('error').hidden = false;
  $('error').textContent = 'このアドレスでは音を出せません。https か localhost で開いてください';
}

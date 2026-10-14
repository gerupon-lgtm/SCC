// 画面（F-008）。部品をつなぐ：MIDI・画面の鍵盤 → Synth → AudioEngine（Worklet）
import './version-check.js'; // 最初に読む：版の食い違いとエラーを画面に出す
import { VERSION } from '../version.js';
import { SCC_COMPAT, extendedConfig } from '../core/config.js';
import { PRESET_NAMES, getPreset } from '../core/presets.js';
import { DEFAULT_MASTER } from '../core/post-stage.js';
import { AudioEngine } from '../audio/audio-engine.js';
import { MidiInput } from '../midi/midi-input.js';
import { Synth } from '../engine/synth.js';
import { Keyboard } from './keyboard.js';
import { initSongPanel } from './song-panel.js';

const $ = (id) => /** @type {HTMLElement} */ (document.getElementById(id));

const WAVE_LABELS = { square: '矩形', saw: 'のこぎり', triangle: '三角', sine: '正弦', pulse25: 'パルス25%' };
const MIDI_TEXT = {
  unsupported: 'このブラウザはMIDIに対応していません。画面の鍵盤で弾けます',
  denied: 'MIDIが許可されませんでした。アドレス欄の左のボタンからMIDIを「許可」にして、「もう一度試す」を押してください。画面の鍵盤は使えます',
  noDevice: '機器がつながっていません。つなぐと自動で認識します',
  ready: 'つながっています',
};
const ERROR_TEXT = {
  E_NO_WORKLET: 'このブラウザでは音を出せません（AudioWorklet が使えません）',
  E_CONFIG: '設定に誤りがあります',
  E_INSECURE_CONTEXT: 'このアドレスでは音もMIDIも使えません。ブラウザが、https か localhost で開いたページにしか許可しないためです。公開版 https://gerupon-lgtm.github.io/SCC/ を開いてください',
};
const POLL_MS = 33; // 約30回/秒
const UNDERRUN_HOLD_MS = 3000;

$('version').textContent = VERSION;

// ---- チャンネル数（F-011）。止めているときだけ変えられる ----
const CHANNEL_CHOICES = [5, 8, 16];
const channelSelect = /** @type {HTMLSelectElement} */ ($('channel-count'));
for (const n of CHANNEL_CHOICES) channelSelect.append(new Option(n === 5 ? '5（SCCと同じ）' : String(n), String(n)));
function configFor(n) {
  return n === SCC_COMPAT.channelCount ? SCC_COMPAT : extendedConfig(n);
}
let config = SCC_COMPAT;
try {
  const saved = Number(localStorage.getItem('channel-count'));
  if (CHANNEL_CHOICES.includes(saved)) config = configFor(saved);
} catch { /* 保存できなくても動く */ }
channelSelect.value = String(config.channelCount);

// ---- 部品 ----
const engine = new AudioEngine({
  config,
  onState: (s) => renderState(s),
  onError: (code, message) => {
    if (code === 'E_AUDIO_UNDERRUN') showUnderrun();
    else if (code === 'E_SONG') songPanel.onError(message);
    else showError(code, message);
  },
  onSong: (state) => songPanel.onSong(state),
});
const songPanel = initSongPanel({ engine });

let synth = new Synth(engine, { config });

const midi = new MidiInput({
  onEvent: (ev) => { if (engine.running) synth.handle(ev); },
  onState: (state, names) => {
    $('midi-state').textContent = state === 'ready' ? `${MIDI_TEXT.ready}（${names.join('、')}）` : MIDI_TEXT[state];
    $('midi-retry').hidden = state !== 'denied';
  },
  onDisconnect: () => synth.allNotesOff(),
});

const keyboard = new Keyboard($('keyboard'), {
  onDown: (note) => synth.noteOn(note, 100),
  onUp: (note) => synth.noteOff(note),
});
const updateOctave = () => { $('octave-label').textContent = keyboard.rangeLabel; };
$('keyboard').addEventListener('octavechange', updateOctave);
$('oct-down').addEventListener('click', () => { keyboard.shift(-1); updateOctave(); });
$('oct-up').addEventListener('click', () => { keyboard.shift(1); updateOctave(); });
updateOctave();

// ---- 波形の選択 ----
function wavePreview(name) {
  const svgNS = 'http://www.w3.org/2000/svg';
  const svg = document.createElementNS(svgNS, 'svg');
  svg.setAttribute('viewBox', '0 0 32 24');
  svg.setAttribute('aria-hidden', 'true');
  const line = document.createElementNS(svgNS, 'polyline');
  const w = getPreset(name);
  const pts = [];
  w.forEach((v, i) => {
    const y = 12 - (v / 128) * 10;
    pts.push(`${i},${y}`, `${i + 1},${y}`);
  });
  line.setAttribute('points', pts.join(' '));
  svg.append(line);
  return svg;
}
const waveButtons = PRESET_NAMES.map((name) => {
  const b = document.createElement('button');
  b.type = 'button';
  b.setAttribute('role', 'radio');
  b.dataset.wave = name;
  const label = document.createElement('span');
  label.textContent = WAVE_LABELS[name] ?? name;
  b.append(wavePreview(name), label);
  b.addEventListener('click', () => selectWave(name));
  $('wave-buttons').append(b);
  return b;
});
function selectWave(name) {
  synth.setWave(name); // 開始前は書き込みを捨てるが、名前は覚えて開始時に書く
  for (const b of waveButtons) b.setAttribute('aria-checked', String(b.dataset.wave === name));
}
selectWave(synth.waveName);

// ---- 音量 ----
const master = /** @type {HTMLInputElement} */ ($('master'));
master.value = String(DEFAULT_MASTER);
const updateMaster = () => {
  const g = Number(master.value);
  $('master-value').textContent = g.toFixed(2);
  engine.setMaster(g);
};
master.addEventListener('input', updateMaster);
updateMaster();

// ---- チャンネル表示 ----
let rows = [];
function buildRows() {
  rows = [];
  $('channel-rows').replaceChildren();
  for (let ch = 0; ch < config.channelCount; ch++) {
    const tr = document.createElement('tr');
    const cells = ['ch', 'freq', 'vol', 'key', 'bank'].map(() => document.createElement('td'));
    cells[0].textContent = String(ch + 1);
    tr.append(...cells);
    $('channel-rows').append(tr);
    rows.push(cells);
  }
}
const idleChannels = () => config.channelWaveBank.map((b) => ({ frequency: 0, volume: 0, key: false, waveBank: b }));
buildRows();
function renderChannels(channels) {
  channels.forEach((c, i) => {
    const cells = rows[i];
    if (!cells) return;
    const hz = c.frequency > 8 ? config.clock / (32 * (c.frequency + 1)) : 0;
    cells[1].textContent = c.frequency > 8 ? `${c.frequency}（${hz.toFixed(1)}Hz）` : `${c.frequency}（停止）`;
    cells[2].textContent = String(c.volume).padStart(2, ' ');
    const bar = document.createElement('span');
    bar.className = 'vol-bar';
    bar.style.width = `${c.volume * 3}px`;
    cells[2].append(bar);
    cells[3].textContent = c.key ? 'ON' : '—';
    cells[3].classList.toggle('key-on', c.key);
    cells[4].textContent = String(c.waveBank + 1);
  });
}
renderChannels(idleChannels());

channelSelect.addEventListener('change', () => {
  if (engine.running) return;
  config = configFor(Number(channelSelect.value));
  try { localStorage.setItem('channel-count', String(config.channelCount)); } catch { /* 同上 */ }
  engine.config = config;
  const waveName = synth.waveName;
  synth = new Synth(engine, { config });
  synth.waveName = waveName;
  buildRows();
  renderChannels(idleChannels());
});

// ---- 状態表示 ----
let underrunTimer = 0;
function showUnderrun() {
  $('underrun').hidden = false;
  $('underrun-kb').hidden = false;
  clearTimeout(underrunTimer);
  underrunTimer = setTimeout(() => { $('underrun').hidden = true; $('underrun-kb').hidden = true; }, UNDERRUN_HOLD_MS);
}
function showError(code, message) {
  const el = $('error');
  el.hidden = false;
  el.textContent = `${ERROR_TEXT[code] ?? code}${message ? `：${message}` : ''}`;
}
// 処理の重さは、約30回/秒の値を1秒ぶん平均して、1秒に1回だけ表示を変える（目で読めるように）
// 最大は、その1秒平均の最大を「最大を0に」か「音を出す」まで保持する
// （約30回/秒の値は Date.now のミリ秒単位の粗さで揺れるため、最大には使わない）
const LOAD_WINDOW_MS = 1000;
let loadMax = 0;
let loadSum = 0;
let loadCount = 0;
let loadWindowStart = 0;
function resetLoad() {
  loadMax = 0;
  loadSum = 0;
  loadCount = 0;
  loadWindowStart = performance.now();
  for (const id of ['load', 'load-kb', 'load-max']) $(id).textContent = '—';
}
function renderState(s) {
  renderChannels(s.channels);
  songPanel.onState(s.song);
  $('voices-kb').textContent = String(s.channels.filter((c) => c.key).length);
  loadSum += s.load;
  loadCount++;
  const now = performance.now();
  if (now - loadWindowStart < LOAD_WINDOW_MS) return;
  const avg = Math.round((loadSum / loadCount) * 100);
  loadMax = Math.max(loadMax, avg);
  loadSum = 0;
  loadCount = 0;
  loadWindowStart = now;
  // 鍵盤を弾きながら見られるよう、鍵盤の上にも出す
  $('load').textContent = `${avg}%（最大 ${loadMax}%）`;
  $('load-kb').textContent = `${avg}%`;
  $('load-max').textContent = `${loadMax}%`;
}
$('load-reset').addEventListener('click', resetLoad);

let pollTimer = 0;
function startPolling() {
  stopPolling();
  pollTimer = setInterval(() => engine.poll(), POLL_MS);
}
function stopPolling() {
  clearInterval(pollTimer);
}

// ---- 開始・停止 ----
const startBtn = /** @type {HTMLButtonElement} */ ($('start'));
function setRunning(on) {
  startBtn.textContent = on ? '■ 止める' : '▶ 音を出す';
  startBtn.classList.toggle('running', on);
  $('audio-state').textContent = on ? `鳴らせます（${engine.ctx?.sampleRate ?? '?'}Hz）` : '止まっています';
  $('start-note').hidden = on;
  master.disabled = !on;
  /** @type {HTMLButtonElement} */ ($('oct-down')).disabled = !on;
  /** @type {HTMLButtonElement} */ ($('oct-up')).disabled = !on;
  keyboard.setEnabled(on);
  channelSelect.disabled = on;
  songPanel.setRunning(on);
  if (on) { resetLoad(); startPolling(); } else stopPolling();
  if (!on) {
    $('voices-kb').textContent = '0';
    renderChannels(idleChannels());
  }
}

startBtn.addEventListener('click', async () => {
  startBtn.disabled = true;
  $('error').hidden = true;
  try {
    if (engine.running) {
      synth.allNotesOff();
      await engine.stop();
      setRunning(false);
    } else {
      await engine.start();
      synth.init();
      updateMaster();
      setRunning(true);
      if (midi.state === null) midi.start();
    }
  } catch (e) {
    showError(e.code ?? 'E_NO_WORKLET', e.code ? '' : String(e.message ?? e));
    setRunning(false);
  } finally {
    startBtn.disabled = false;
  }
});

$('midi-retry').addEventListener('click', () => midi.start());

// 画面が隠れたら鳴っている音を止める（押しっぱなしの防止）
document.addEventListener('visibilitychange', () => {
  if (document.hidden) { keyboard.releaseAll(); synth.allNotesOff(); }
});

setRunning(false);
// 開いた時点で、安全でない接続なら先に知らせる
if (window.isSecureContext === false) showError('E_INSECURE_CONTEXT');

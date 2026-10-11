// 画面（F-008）。部品をつなぐ：MIDI・画面の鍵盤 → Synth → AudioEngine（Worklet）
import { VERSION } from '../version.js';
import { SCC_COMPAT } from '../core/config.js';
import { PRESET_NAMES, getPreset } from '../core/presets.js';
import { DEFAULT_MASTER } from '../core/post-stage.js';
import { AudioEngine } from '../audio/audio-engine.js';
import { MidiInput } from '../midi/midi-input.js';
import { Synth } from '../engine/synth.js';
import { Keyboard } from './keyboard.js';

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
  E_INSECURE_CONTEXT: 'このアドレスでは音もMIDIも使えません。ブラウザが、https か localhost で開いたページにしか許可しないためです。スマホでは、PCとUSBでつないで「adb reverse tcp:8000 tcp:8000」を実行し、http://localhost:8000 を開いてください',
};
const POLL_MS = 33; // 約30回/秒
const UNDERRUN_HOLD_MS = 3000;

$('version').textContent = VERSION;

// ---- 書体の比較（T-012。決まったら外す） ----
const fontSelect = /** @type {HTMLSelectElement} */ ($('font-select'));
try { fontSelect.value = localStorage.getItem('font') ?? 'a'; } catch { /* 保存できなくても動く */ }
const applyFont = () => {
  document.documentElement.dataset.font = fontSelect.value;
  try { localStorage.setItem('font', fontSelect.value); } catch { /* 同上 */ }
};
fontSelect.addEventListener('change', applyFont);
applyFont();

// ---- 部品 ----
const engine = new AudioEngine({
  config: SCC_COMPAT,
  onState: (s) => renderState(s),
  onError: (code, message) => {
    if (code === 'E_AUDIO_UNDERRUN') showUnderrun();
    else showError(code, message);
  },
});

const synth = new Synth(engine, { clock: SCC_COMPAT.clock });

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
const rows = [];
for (let ch = 0; ch < SCC_COMPAT.channelCount; ch++) {
  const tr = document.createElement('tr');
  const cells = ['ch', 'freq', 'vol', 'key', 'bank'].map(() => document.createElement('td'));
  cells[0].textContent = String(ch + 1);
  tr.append(...cells);
  $('channel-rows').append(tr);
  rows.push(cells);
}
function renderChannels(channels) {
  channels.forEach((c, i) => {
    const cells = rows[i];
    if (!cells) return;
    const hz = c.frequency > 8 ? SCC_COMPAT.clock / (32 * (c.frequency + 1)) : 0;
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
renderChannels(SCC_COMPAT.channelWaveBank.map((b) => ({ frequency: 0, volume: 0, key: false, waveBank: b })));

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
let loadMax = 0;
function renderState(s) {
  renderChannels(s.channels);
  const load = Math.round(s.load * 100);
  loadMax = Math.max(loadMax, load);
  $('load').textContent = `${load}%`;
  // 鍵盤を弾きながら見られるよう、鍵盤の上にも出す
  $('load-kb').textContent = `${load}%`;
  $('load-max').textContent = `${loadMax}%`;
  $('voices-kb').textContent = String(s.channels.filter((c) => c.key).length);
}

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
  if (on) { loadMax = 0; startPolling(); } else stopPolling();
  if (!on) {
    for (const id of ['load', 'load-kb', 'load-max']) $(id).textContent = '—';
    $('voices-kb').textContent = '0';
    renderChannels(SCC_COMPAT.channelWaveBank.map((b) => ({ frequency: 0, volume: 0, key: false, waveBank: b })));
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

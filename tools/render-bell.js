// 鐘の音を WAV ファイルに書き出す（試作ページ bell.html と同じ計算）
// 使い方：node tools/render-bell.js
// 出力：exports/bell/<音色>-C4.wav（48,000Hz・16ビット・モノラル・3.0秒）
import { mkdirSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { SCC_COMPAT } from '../src/core/config.js';
import { SccFast } from '../src/core/scc-fast.js';
import { SccRegisters } from '../src/core/scc-registers.js';
import { WindowConverter } from '../src/core/window-converter.js';
import { BellVoice, BELL_PRESETS } from '../src/bell/bell-voice.js';

const SAMPLE_RATE = 48000;
const BLOCK = 128;           // AudioWorklet と同じ区切りで時間を進める（音量・波形の書き換えの時刻をそろえる）
const DC_CUTOFF_HZ = 10;     // src/core/post-stage.js と同じ直流除去
const PEAK = 10 ** (-1 / 20); // 最大の振れ幅を -1dBFS（約0.89）にそろえる

/**
 * @param {import('../src/bell/bell-voice.js').BellParams} params
 * @param {number} note MIDIのノート番号
 * @param {number} seconds 書き出す長さ（鳴り終わった後は無音）
 * @returns {Float64Array} -1〜1
 */
export function renderBell(params, note, seconds) {
  const chip = new SccFast(SCC_COMPAT);
  const regs = new SccRegisters(chip);
  const conv = new WindowConverter(SCC_COMPAT.clock, SAMPLE_RATE);
  const bell = new BellVoice(regs, SCC_COMPAT.clock);
  bell.setParams(params);
  bell.strike(note, 1);
  const n = Math.round(seconds * SAMPLE_RATE);
  const out = new Float64Array(n);
  const block = new Float32Array(BLOCK);
  const r = Math.exp((-2 * Math.PI * DC_CUTOFF_HZ) / SAMPLE_RATE);
  let x1 = 0, y1 = 0;
  for (let i = 0; i < n; i += BLOCK) {
    bell.advance(BLOCK / SAMPLE_RATE);
    conv.render(chip, block);
    for (let j = 0; j < BLOCK && i + j < n; j++) {
      const x = block[j];
      const y = x - x1 + r * y1;
      x1 = x; y1 = y;
      out[i + j] = y;
    }
  }
  return out;
}

/** 最大の振れ幅を peak にそろえる */
export function normalize(samples, peak = PEAK) {
  let max = 0;
  for (const v of samples) max = Math.max(max, Math.abs(v));
  const g = max > 0 ? peak / max : 0;
  return samples.map((v) => v * g);
}

/**
 * 16ビット・モノラルの WAV
 * @param {Float64Array} samples -1〜1
 * @param {number} sampleRate
 * @returns {Buffer}
 */
export function encodeWav(samples, sampleRate) {
  const data = samples.length * 2;
  const buf = Buffer.alloc(44 + data);
  buf.write('RIFF', 0);
  buf.writeUInt32LE(36 + data, 4);
  buf.write('WAVE', 8);
  buf.write('fmt ', 12);
  buf.writeUInt32LE(16, 16);        // fmt の長さ
  buf.writeUInt16LE(1, 20);         // PCM
  buf.writeUInt16LE(1, 22);         // モノラル
  buf.writeUInt32LE(sampleRate, 24);
  buf.writeUInt32LE(sampleRate * 2, 28);
  buf.writeUInt16LE(2, 32);
  buf.writeUInt16LE(16, 34);
  buf.write('data', 36);
  buf.writeUInt32LE(data, 40);
  samples.forEach((v, i) => buf.writeInt16LE(Math.round(Math.max(-1, Math.min(1, v)) * 32767), 44 + i * 2));
  return buf;
}

if (process.argv[1] && fileURLToPath(import.meta.url) === process.argv[1]) {
  const OUT = fileURLToPath(new URL('../exports/bell/', import.meta.url));
  mkdirSync(OUT, { recursive: true });
  const NOTE = 60; // C4
  for (const name of ['small', 'church']) {
    const samples = normalize(renderBell(BELL_PRESETS[name].params, NOTE, 3.0));
    const file = join(OUT, `${name}-C4.wav`);
    writeFileSync(file, encodeWav(samples, SAMPLE_RATE));
    // 最後に音がある位置（-60dB を超える最後のサンプル）
    let last = 0;
    samples.forEach((v, i) => { if (Math.abs(v) > 0.001) last = i; });
    console.log(`${file}：${(samples.length / SAMPLE_RATE).toFixed(2)}秒、音は ${(last / SAMPLE_RATE).toFixed(2)}秒まで`);
  }
}

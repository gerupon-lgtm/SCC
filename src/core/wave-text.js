// 波形（32点、-128〜127）と、MGSDRV の @s と同じ16進の文字との変換（F-007、T-101）
// 例："00900030 50607060 …"（4バイトずつ8組）。値は符号付き8ビット（00〜7F が 0〜127、80〜FF が -128〜-1）
import { WAVE_LENGTH } from './config.js';

export class WaveTextError extends Error {
  constructor(message) { super(message); this.name = 'WaveTextError'; }
}

/** @param {ArrayLike<number>} wave 32個 */
export function formatWaveHex(wave) {
  const groups = [];
  for (let g = 0; g < WAVE_LENGTH / 4; g++) {
    let s = '';
    for (let i = 0; i < 4; i++) s += ((wave[g * 4 + i] & 0xff).toString(16).padStart(2, '0'));
    groups.push(s.toUpperCase());
  }
  return groups.join(' ');
}

/**
 * 16進の文字から波形を作る。"@s00 = { … }" のような MML の行をそのまま貼ってもよい（; 以降は注釈として無視）
 * @param {string} text
 * @returns {Int8Array}
 */
export function parseWaveHex(text) {
  let body = String(text).split(';')[0];
  const brace = body.match(/\{([\s\S]*)\}/);
  if (brace) body = brace[1];
  const hex = body.replace(/[\s,]+/g, '');
  if (!/^[0-9a-fA-F]*$/.test(hex)) throw new WaveTextError('16進（0〜9、A〜F）以外の文字があります');
  if (hex.length !== WAVE_LENGTH * 2) throw new WaveTextError(`32個（64文字）が必要です。いまは ${hex.length / 2} 個です`);
  const wave = new Int8Array(WAVE_LENGTH);
  for (let i = 0; i < WAVE_LENGTH; i++) wave[i] = parseInt(hex.slice(i * 2, i * 2 + 2), 16);
  return wave;
}

/** 値を -128〜127 の整数に丸める（画面で描いた値・範囲外の値のため） */
export function clampSample(v) {
  if (!Number.isFinite(v)) return 0;
  return Math.max(-128, Math.min(127, Math.round(v)));
}

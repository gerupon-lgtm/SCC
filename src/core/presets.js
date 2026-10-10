// プリセット波形（F-006）。作り方は docs/data-model.md 3章【想定】
import { WAVE_LENGTH } from './config.js';

/** @type {readonly string[]} */
export const PRESET_NAMES = Object.freeze(['square', 'saw', 'triangle', 'sine', 'pulse25']);

const N = WAVE_LENGTH;
const HALF = N / 2;

/** @type {Record<string, (i: number) => number>} */
const MAKERS = {
  square: (i) => (i < HALF ? 127 : -128),
  saw: (i) => Math.round(-128 + (255 * i) / (N - 1)),
  triangle: (i) => (i < HALF
    ? Math.round(-128 + (255 * i) / (HALF - 1))
    : Math.round(127 - (255 * (i - HALF)) / (HALF - 1))),
  sine: (i) => Math.round(127 * Math.sin((2 * Math.PI * i) / N)),
  pulse25: (i) => (i < N / 4 ? 127 : -128),
};

/**
 * プリセット波形を新しい配列で返す
 * @param {string} name
 * @returns {Int8Array}
 */
export function getPreset(name) {
  const make = MAKERS[name];
  if (!Object.hasOwn(MAKERS, name)) throw new RangeError(`不明なプリセット波形です：${name}`);
  const wave = new Int8Array(N);
  for (let i = 0; i < N; i++) wave[i] = make(i);
  return wave;
}

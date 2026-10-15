// T-101：波形と16進の文字の変換、範囲外の値
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { formatWaveHex, parseWaveHex, clampSample, WaveTextError } from '../src/core/wave-text.js';
import { getPreset } from '../src/core/presets.js';

test('MGSDRV の @s と同じ書き方で出し、読み戻すと同じ波形', () => {
  for (const name of ['square', 'saw', 'triangle', 'sine', 'pulse25']) {
    const w = getPreset(name);
    const text = formatWaveHex(w);
    assert.match(text, /^([0-9A-F]{8} ){7}[0-9A-F]{8}$/);
    assert.deepEqual([...parseWaveHex(text)], [...w], name);
  }
  assert.equal(formatWaveHex(getPreset('square')).slice(0, 8), '7F7F7F7F');
});

test('手元の MML の行をそのまま貼っても読める（注釈・大文字小文字・改行）', () => {
  const line = '@s00 = { 00900030 50607060 503000D0 B0A090A0\n b0d00040 60706040 00C0A090 A0C00070 }; 005289 A';
  const w = parseWaveHex(line);
  assert.equal(w[0], 0);
  assert.equal(w[1], -112); // 0x90
  assert.equal(w[31], 0x70);
});

test('壊れた文字は分かる言葉で断る', () => {
  assert.throws(() => parseWaveHex('00 11 22'), (e) => e instanceof WaveTextError && /32個/.test(e.message));
  assert.throws(() => parseWaveHex('zz'.repeat(32)), /16進/);
  assert.throws(() => parseWaveHex(''), WaveTextError);
});

test('範囲外の値は -128〜127 に丸める', () => {
  assert.equal(clampSample(500), 127);
  assert.equal(clampSample(-500), -128);
  assert.equal(clampSample(12.6), 13);
  assert.equal(clampSample(NaN), 0);
});

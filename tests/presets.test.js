import { test } from 'node:test';
import assert from 'node:assert/strict';
import { PRESET_NAMES, getPreset } from '../src/core/presets.js';

// docs/data-model.md 3章の式から、手で確かめた数値の一覧
const EXPECTED = {
  square: [127, 127, 127, 127, 127, 127, 127, 127, 127, 127, 127, 127, 127, 127, 127, 127,
    -128, -128, -128, -128, -128, -128, -128, -128, -128, -128, -128, -128, -128, -128, -128, -128],
  saw: [-128, -120, -112, -103, -95, -87, -79, -70, -62, -54, -46, -38, -29, -21, -13, -5,
    4, 12, 20, 28, 37, 45, 53, 61, 69, 78, 86, 94, 102, 111, 119, 127],
  triangle: [-128, -111, -94, -77, -60, -43, -26, -9, 8, 25, 42, 59, 76, 93, 110, 127,
    127, 110, 93, 76, 59, 42, 25, 8, -9, -26, -43, -60, -77, -94, -111, -128],
  sine: [0, 25, 49, 71, 90, 106, 117, 125, 127, 125, 117, 106, 90, 71, 49, 25,
    0, -25, -49, -71, -90, -106, -117, -125, -127, -125, -117, -106, -90, -71, -49, -25],
  pulse25: [127, 127, 127, 127, 127, 127, 127, 127,
    -128, -128, -128, -128, -128, -128, -128, -128, -128, -128, -128, -128, -128, -128, -128, -128,
    -128, -128, -128, -128, -128, -128, -128, -128],
};

test('プリセットは5種', () => {
  assert.deepEqual([...PRESET_NAMES], ['square', 'saw', 'triangle', 'sine', 'pulse25']);
});

for (const name of Object.keys(EXPECTED)) {
  test(`${name} が数値一覧と一致`, () => {
    const w = getPreset(name);
    assert.ok(w instanceof Int8Array);
    assert.equal(w.length, 32);
    assert.deepEqual([...w], EXPECTED[name]);
  });
}

test('毎回新しい配列を返す（書き換えが他へ漏れない）', () => {
  const a = getPreset('square');
  a[0] = 0;
  assert.equal(getPreset('square')[0], 127);
});

test('不明な名前は RangeError', () => {
  assert.throws(() => getPreset('noise'), RangeError);
  assert.throws(() => getPreset('toString'), RangeError);
});

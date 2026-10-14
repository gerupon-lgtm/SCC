// T-110：PSG の基準版の出力が、MAME の ay8910.cpp（MSX と同じ設定）と1 tick も違わないこと
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { gunzipSync } from 'node:zlib';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { PsgRef, PSG_TABLE } from '../src/core/psg-ref.js';
import { AY_CASES, generateAyOps } from '../tools/mame-check/ops-ay.js';

const FIXTURES = fileURLToPath(new URL('./fixtures/mame/', import.meta.url));

/** 'MAME の出力（文字） 回数' の行を、32ビット浮動小数点の列に戻す */
function decode(text) {
  const out = [];
  for (const line of text.trim().split('\n')) {
    const [v, n] = line.split(' ');
    const f = Math.fround(Number(v));
    for (let i = 0; i < Number(n); i++) out.push(f);
  }
  return out;
}

function run(opsText) {
  const psg = new PsgRef();
  const out = [];
  for (const line of opsText.trim().split('\n')) {
    const [op, a] = line.split(' ');
    if (op === 'A') psg.writeAddress(parseInt(a, 16));
    else if (op === 'D') psg.writeData(parseInt(a, 16));
    else for (let n = Number(a); n > 0; n--) out.push(PSG_TABLE[psg.tick()]);
  }
  return out;
}

for (const c of AY_CASES) {
  test(`MAME と完全一致：${c.name}`, () => {
    const opsText = readFileSync(join(FIXTURES, `${c.name}.ops`), 'utf8');
    assert.equal(opsText, generateAyOps(c).join('\n') + '\n', '操作列が記録時と違います。record.js で記録し直してください');
    const expected = decode(gunzipSync(readFileSync(join(FIXTURES, `${c.name}.out.gz`))).toString('utf8'));
    const actual = run(opsText);
    assert.equal(actual.length, expected.length, 'tick 数が違います');
    for (let i = 0; i < expected.length; i++) {
      if (actual[i] !== expected[i]) assert.fail(`${i} tick 目が違います：基準版 ${actual[i]}、MAME ${expected[i]}`);
    }
  });
}

test('読み出し：AY-3-8910 は使わないビットが0。上位4ビットが0でないアドレスの後は無効', () => {
  const psg = new PsgRef();
  psg.writeAddress(1); psg.writeData(0xff);
  assert.equal(psg.readData(), 0x0f);
  psg.writeAddress(8); psg.writeData(0xff);
  assert.equal(psg.readData(), 0x1f);
  psg.writeAddress(0x10);
  psg.writeData(0x55);
  assert.equal(psg.readData(), 0xff);
  assert.equal(psg.readReg(0), 0);
});

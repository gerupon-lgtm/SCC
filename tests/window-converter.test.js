// T-008：整数のまま L と和を出す。基準版と高速版で同じ出力
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { WindowConverter, OUTPUT_DIVISOR } from '../src/core/window-converter.js';
import { PostStage, DEFAULT_MASTER, DEFAULT_SLIDER, MAX_MASTER, sliderToGain } from '../src/core/post-stage.js';
import { SccRef } from '../src/core/scc-ref.js';
import { SccFast } from '../src/core/scc-fast.js';
import { SCC_COMPAT, extendedConfig } from '../src/core/config.js';
import { getPreset } from '../src/core/presets.js';

const CLOCK = SCC_COMPAT.clock;

test('48000Hz の L は 74か75、44100Hz は 81か82', () => {
  for (const [rate, lo] of [[48000, 74], [44100, 81]]) {
    const w = new WindowConverter(CLOCK, rate);
    const seen = new Set();
    for (let i = 0; i < rate; i++) seen.add(w.nextL());
    assert.deepEqual([...seen].sort(), [lo, lo + 1]);
  }
});

for (const rate of [44100, 48000]) {
  test(`${rate}Hz：1時間分の L の合計が、クロック×秒数に一致（累積の誤差なし）`, () => {
    const w = new WindowConverter(CLOCK, rate);
    let total = 0;
    for (let sec = 1; sec <= 3600; sec++) {
      for (let i = 0; i < rate; i++) total += w.nextL();
      if (total !== CLOCK * sec) assert.fail(`${sec}秒目：${total} ≠ ${CLOCK * sec}`);
      assert.equal(w.acc, 0);
    }
  });
}

test('引数の検査', () => {
  assert.throws(() => new WindowConverter(CLOCK, 0), RangeError);
  assert.throws(() => new WindowConverter(CLOCK, 44100.5), RangeError);
  assert.throws(() => new WindowConverter(100, 48000), RangeError);
});

function setupChip(chip) {
  const waves = ['square', 'saw', 'triangle', 'sine'].map(getPreset);
  waves.forEach((w, b) => w.forEach((v, i) => chip.writeWave(b, i, v)));
  [9, 254, 427, 1000, 4095].forEach((f, ch) => chip.setFrequency(ch, f));
  chip.setKey(0b11111);
}

test('基準版と高速版で、変換後の音声が同じ（48000Hz・44100Hz）', () => {
  for (const rate of [48000, 44100]) {
    const ref = new SccRef(), fast = new SccFast();
    setupChip(ref); setupChip(fast);
    const wr = new WindowConverter(CLOCK, rate), wf = new WindowConverter(CLOCK, rate);
    const a = new Float32Array(128), b = new Float32Array(128);
    for (let block = 0; block < 200; block++) {
      if (block === 50) for (const c of [ref, fast]) c.setFrequency(2, 33);
      if (block === 120) for (const c of [ref, fast]) c.setVolume(0, 4);
      wr.render(ref, a); wf.render(fast, b);
      assert.deepEqual(b, a, `${rate}Hz block ${block}`);
    }
  }
});

test('render の値は sum / (L*1024)', () => {
  const calls = [];
  const fake = { sumTicks: (n) => { calls.push(n); return n * 100; } };
  const w = new WindowConverter(CLOCK, 48000);
  const out = new Float32Array(4);
  w.render(fake, out, 1, 3);
  assert.equal(calls.length, 2);
  assert.equal(out[0], 0);
  assert.equal(out[1], Math.fround(100 / OUTPUT_DIVISOR));
  assert.equal(out[3], 0);
});

test('後処理：直流を取り除く', () => {
  const p = new PostStage(48000, 5);
  p.setMaster(1);
  p.clear();
  const buf = new Float32Array(48000).fill(0.5);
  p.process(buf);
  assert.ok(Math.abs(buf[47999]) < 0.01, `1秒後 ${buf[47999]}`);
});

test('後処理：スライダー100%が上限（倍率2）、初期位置は80%（倍率1.6）、範囲外は丸める、なめらかに変わる', () => {
  assert.equal(sliderToGain(100), MAX_MASTER);
  assert.equal(MAX_MASTER, 2);
  assert.equal(DEFAULT_SLIDER, 80);
  assert.ok(Math.abs(DEFAULT_MASTER - 1.6) < 1e-12);
  const p = new PostStage(48000, 5);
  assert.equal(p.target, DEFAULT_MASTER);
  p.setMaster(3); assert.equal(p.target, 2);
  p.setMaster(-1); assert.equal(p.target, 0);
  p.setMaster(NaN); assert.equal(p.target, 0);
  p.setMaster(0);
  const buf = new Float32Array(4).fill(0.4);
  p.process(buf);
  assert.ok(p.gain < DEFAULT_MASTER && p.gain > 0, `gain ${p.gain}`);
});

test('後処理：大きすぎる値は -1〜1 に収める。最大値を報告する', () => {
  const p = new PostStage(48000, 5);
  p.setMaster(1); p.clear();
  const buf = Float32Array.of(5, -5, 0);
  p.process(buf);
  assert.equal(buf[0], 1);
  assert.equal(buf[1], -1);
  assert.equal(p.takePeak(), 1);
  assert.equal(p.takePeak(), 0);
});

test('後処理：チャンネルが多いときは 5/チャンネル数 に下げる', () => {
  assert.equal(new PostStage(48000, 5).headroom, 1);
  assert.equal(new PostStage(48000, 16).headroom, 5 / 16);
  assert.equal(new PostStage(48000, extendedConfig(1).channelCount).headroom, 1);
});

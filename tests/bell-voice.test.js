// 鐘の試作：比どおりの高さ、音量は下がり続けて length 秒以内に消える、倍音は時間とともに弱まる
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { BellVoice, BELL_PRESETS, normalizeParams, hzToPeriod, noteToHz } from '../src/bell/bell-voice.js';
import { SccRef } from '../src/core/scc-ref.js';
import { SccRegisters } from '../src/core/scc-registers.js';
import { SCC_COMPAT } from '../src/core/config.js';

const CLOCK = SCC_COMPAT.clock;
const DT = 128 / 48000; // AudioWorklet の1ブロック

function setup(params = BELL_PRESETS.small.params) {
  const chip = new SccRef();
  const bell = new BellVoice(new SccRegisters(chip), CLOCK);
  bell.setParams(params);
  return { chip, bell, ch: () => chip.snapshot().channels };
}

/** 鳴り終わるまで進め、かかった秒数を返す。途中で音量が上がったら失敗 */
function runToEnd(bell, ch, limit = 60) {
  let prev = ch().map((c) => c.volume);
  let t = 0;
  while (bell.ringing && t < limit) {
    bell.advance(DT);
    t += DT;
    const now = ch().map((c) => c.volume);
    now.forEach((v, i) => assert.ok(v <= prev[i], `ch${i} が上がった：${prev[i]}→${v}（${t.toFixed(3)}秒）`));
    prev = now;
  }
  return t;
}

/** 波形の、k倍の倍音の大きさ（離散フーリエ変換の1項） */
function harmonicAmp(chip, bank, k) {
  let re = 0, im = 0;
  for (let i = 0; i < 32; i++) {
    const v = chip.readWave(bank, i);
    re += v * Math.cos((2 * Math.PI * k * i) / 32);
    im += v * Math.sin((2 * Math.PI * k * i) / 32);
  }
  return Math.hypot(re, im) / 16;
}

test('叩くと、各チャンネルが比どおりの高さ・初めの音量で鳴る。音量0のチャンネルは使わない', () => {
  const { bell, ch } = setup();
  bell.strike(60);
  const p = BELL_PRESETS.small.params.partials;
  ch().forEach((c, i) => {
    const hz = noteToHz(60) * p[i].ratio * 2 ** (p[i].cents / 1200);
    assert.equal(c.frequency, hzToPeriod(hz, CLOCK), `ch${i}`);
    assert.equal(c.volume, p[i].level);
    assert.equal(c.key, p[i].level > 0);
  });
});

test('小さな鐘：Cの高さ（C4・C5）で3秒以内に消え、音量は上がらない', () => {
  for (const note of [60, 72]) {
    const { bell, ch } = setup();
    bell.strike(note);
    const t = runToEnd(bell, ch);
    assert.equal(bell.ringing, false);
    assert.ok(t <= 3, `note ${note}：${t.toFixed(2)}秒`);
    assert.ok(ch().every((c) => !c.key && c.volume === 0));
  }
});

test('全体の長さ：減衰が長くても length 秒で必ず消える', () => {
  const params = normalizeParams({ length: 1.0, partials: [{ ratio: 1, level: 15, decay: 30, harmonics: [1] }] });
  const { bell, ch } = setup(params);
  bell.strike(60);
  const t = runToEnd(bell, ch);
  assert.ok(t <= 1.0 + DT, `${t.toFixed(3)}秒`);
});

test('倍音は時間とともに弱まり、正弦波に近づく（1つの波形の中で溶け合う）', () => {
  const { chip, bell } = setup();
  bell.strike(60);
  const a0 = [1, 2, 3].map((k) => harmonicAmp(chip, 0, k));
  assert.ok(a0[1] > 20 && a0[2] > 10, `叩いた直後の2倍・3倍：${a0}`);
  for (let t = 0; t < 1.0; t += DT) bell.advance(DT);
  const a1 = [1, 2, 3].map((k) => harmonicAmp(chip, 0, k));
  assert.ok(a1[1] < a0[1] * 0.3 && a1[2] < a0[2] * 0.1, `1秒後：${a1}`);
  assert.ok(Math.abs(a1[0] - a0[0]) <= 2, '1倍の音は弱めない');
});

test('ずらし（うなり）は、小さな鐘では0', () => {
  assert.ok(BELL_PRESETS.small.params.partials.every((p) => p.cents === 0));
});

test('高い音ほど早く消える（教会の鐘）', () => {
  const { bell, ch } = setup(BELL_PRESETS.church.params);
  bell.strike(60);
  bell.advance(2.0);
  const v = ch().map((c) => c.volume);
  assert.ok(v[0] > v[3], JSON.stringify(v));
});

test('鳴っている途中で叩き直すと、最初の音量と波形に戻る', () => {
  const { chip, bell, ch } = setup();
  bell.strike(60);
  const wave0 = chip.snapshot().waves.slice(0, 32);
  for (let t = 0; t < 1.0; t += DT) bell.advance(DT);
  bell.strike(64);
  assert.deepEqual(ch().map((c) => c.volume), BELL_PRESETS.small.params.partials.map((s) => s.level));
  assert.deepEqual(chip.snapshot().waves.slice(0, 32), wave0);
});

test('止まる高さ（TP 8以下）のチャンネルは使わない', () => {
  const { bell, ch } = setup(BELL_PRESETS.bar.params);
  bell.strike(96); // 8.933倍は止まる高さになる
  const c = ch();
  assert.ok(c[3].frequency <= 8 && !c[3].key, `ch3 TP=${c[3].frequency}`);
  assert.ok(c[0].key);
});

test('強さ（velocity）で初めの音量が比例する', () => {
  const { bell, ch } = setup();
  bell.strike(60, 0.5);
  assert.deepEqual(ch().map((c) => c.volume), BELL_PRESETS.small.params.partials.map((s) => Math.round(s.level * 0.5)));
});

test('止めると全部無音', () => {
  const { bell, ch } = setup();
  bell.strike(60);
  bell.stop();
  assert.ok(ch().every((c) => !c.key && c.volume === 0));
  bell.advance(1);
  assert.equal(bell.ringing, false);
});

test('値の検査：範囲外・壊れた値は丸める。5番目の波形は4番目にそろえる', () => {
  const p = normalizeParams({
    length: 99,
    partials: [{ ratio: 99, level: 40, decay: -1, cents: 500, harmonics: [2, -1, 'x'], bright: 0 }, { ratio: 'x' }, {},
      { harmonics: [1, 0.5], bright: 0.3 }, { harmonics: [1], bright: 5 }],
  });
  assert.equal(p.length, 30);
  assert.deepEqual(p.partials[0], { ratio: 16, level: 15, decay: 0.01, cents: 100, harmonics: [1, 0, 0], bright: 0.01 });
  assert.deepEqual(p.partials[1].harmonics, [1]);
  assert.deepEqual(p.partials[4].harmonics, [1, 0.5]);
  assert.equal(p.partials[4].bright, 0.3);
  assert.deepEqual(normalizeParams({ partials: [{ harmonics: [0, 0] }] }).partials[0].harmonics, [1]);
  assert.equal(normalizeParams(null).partials.length, 5);
});

test('波形は ±127 に収まる（倍音を全部最大にしても）', () => {
  const { chip, bell } = setup(normalizeParams({ partials: [{ level: 15, harmonics: [1, 1, 1, 1, 1, 1] }] }));
  bell.strike(60);
  const w = chip.snapshot().waves.slice(0, 32);
  assert.ok(w.every((v) => v >= -127 && v <= 127), String([...w]));
});

test('出力が実際に鳴っている（基準版で音を作ると0でない）', () => {
  const { chip, bell } = setup();
  bell.strike(60);
  let energy = 0;
  for (let i = 0; i < 2000; i++) energy += Math.abs(chip.sumTicks(75));
  assert.ok(energy > 0);
});

// 鐘の試作：叩くと比どおりの高さで鳴り、音量が時間で下がって、最後にキーが切れる
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { BellVoice, BELL_PRESETS, normalizeParams, hzToPeriod, noteToHz } from '../src/bell/bell-voice.js';
import { SccRef } from '../src/core/scc-ref.js';
import { SccRegisters } from '../src/core/scc-registers.js';
import { SCC_COMPAT } from '../src/core/config.js';
import { getPreset } from '../src/core/presets.js';

const CLOCK = SCC_COMPAT.clock;

function setup(params = BELL_PRESETS.church.params) {
  const chip = new SccRef();
  const bell = new BellVoice(new SccRegisters(chip), CLOCK);
  bell.setParams(params);
  return { chip, bell, ch: () => chip.snapshot().channels };
}

test('叩くと、各チャンネルが比どおりの高さ・初めの音量で鳴る', () => {
  const { bell, ch } = setup();
  bell.strike(60);
  const p = BELL_PRESETS.church.params.partials;
  ch().forEach((c, i) => {
    const hz = noteToHz(60) * p[i].ratio * 2 ** (p[i].cents / 1200);
    assert.equal(c.frequency, hzToPeriod(hz, CLOCK), `ch${i}`);
    assert.equal(c.volume, p[i].level);
    assert.equal(c.key, true);
  });
});

test('音量は時間とともに下がり続け、上がらない。最後はキーが切れる', () => {
  const { bell, ch } = setup();
  bell.strike(60);
  let prev = ch().map((c) => c.volume);
  const dt = 128 / 48000;
  let t = 0;
  while (bell.ringing && t < 60) {
    bell.advance(dt);
    t += dt;
    const now = ch().map((c) => c.volume);
    now.forEach((v, i) => assert.ok(v <= prev[i], `ch${i} が上がった：${prev[i]}→${v}（${t.toFixed(3)}秒）`));
    prev = now;
  }
  assert.equal(bell.ringing, false);
  assert.ok(ch().every((c) => !c.key && c.volume === 0));
  assert.ok(t > 5 && t < 30, `鳴り終わるまで ${t.toFixed(1)} 秒`);
});

test('高い部分音ほど早く消える（教会の鐘）', () => {
  const { bell, ch } = setup();
  bell.strike(60);
  bell.advance(2.0);
  const v = ch().map((c) => c.volume);
  // 2秒後：低い hum（ch0）は、高い nominal（ch4）より大きい
  assert.ok(v[0] > v[4], JSON.stringify(v));
});

test('鳴っている途中で叩き直すと、最初の音量に戻る', () => {
  const { bell, ch } = setup();
  bell.strike(60);
  bell.advance(1.5);
  bell.strike(64);
  assert.deepEqual(ch().map((c) => c.volume), BELL_PRESETS.church.params.partials.map((s) => s.level));
});

test('音量0の部分音と、止まる高さ（TP 8以下）の部分音は使わない', () => {
  const { bell, ch } = setup(BELL_PRESETS.bar.params); // 5番目は音量0
  bell.strike(96); // 高い音：8.933倍は止まる高さになる
  const c = ch();
  assert.equal(c[4].key, false);
  assert.ok(c[3].frequency <= 8 && !c[3].key, `ch3 TP=${c[3].frequency}`);
  assert.ok(c[0].key);
});

test('強さ（velocity）で初めの音量が比例する', () => {
  const { bell, ch } = setup();
  bell.strike(60, 0.5);
  assert.deepEqual(ch().map((c) => c.volume), BELL_PRESETS.church.params.partials.map((s) => Math.round(s.level * 0.5)));
});

test('止めると全部無音', () => {
  const { bell, ch } = setup();
  bell.strike(60);
  bell.stop();
  assert.ok(ch().every((c) => !c.key && c.volume === 0));
  assert.equal(bell.ringing, false);
  bell.advance(1); // 止めた後は何もしない
});

test('波形は全バンクに書かれる', () => {
  const { chip, bell } = setup();
  bell.setParams({ ...BELL_PRESETS.church.params, wave: 'triangle' });
  const tri = getPreset('triangle');
  for (let b = 0; b < 4; b++) for (let i = 0; i < 32; i++) assert.equal(chip.readWave(b, i), tri[i]);
});

test('値の検査：範囲外・壊れた値は丸める', () => {
  const p = normalizeParams({ partials: [{ ratio: 99, level: 40, decay: -1, cents: 500 }, { ratio: 'x' }] });
  assert.deepEqual(p.partials[0], { ratio: 16, level: 15, decay: 0.01, cents: 100 });
  assert.deepEqual(p.partials[1], { ratio: 1, level: 0, decay: 1, cents: 0 });
  assert.equal(p.partials.length, 5);
  assert.equal(normalizeParams(null).wave, 'sine');
});

test('出力が実際に鳴っている（基準版で音を作ると0でない）', () => {
  const { chip, bell } = setup();
  bell.strike(60);
  let energy = 0;
  for (let i = 0; i < 2000; i++) { const v = chip.sumTicks(75); energy += Math.abs(v); }
  assert.ok(energy > 0);
});

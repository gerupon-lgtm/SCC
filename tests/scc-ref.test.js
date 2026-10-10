import { test } from 'node:test';
import assert from 'node:assert/strict';
import { SccRef } from '../src/core/scc-ref.js';
import { extendedConfig } from '../src/core/config.js';

/** バンクに 0,1,2,…,31 を書く（どの位置を読んだか分かるように） */
function rampWave(chip, bank, scale = 1) {
  for (let i = 0; i < 32; i++) chip.writeWave(bank, i, i * scale);
}

test('初期状態：音量15・周波数0・キー切り、出力0', () => {
  const chip = new SccRef();
  const s = chip.snapshot();
  assert.equal(s.channels.length, 5);
  for (const c of s.channels) {
    assert.deepEqual(c, { frequency: 0, volume: 15, key: false, counter: 0, clock: 0, sample: 0 });
  }
  assert.equal(chip.sumTicks(1000), 0);
});

test('frequency=9 の手計算：10クロックごとに次の値を読む', () => {
  const chip = new SccRef();
  rampWave(chip, 0, 2); // wave[i] = 2i
  chip.setKey(0b00001);
  chip.setFrequency(0, 9);
  // 1クロック目：clock -1→0、counter は進まず wave[0]=0 を読む
  // 2〜10クロック目：clock 1〜9、sample そのまま
  // 11クロック目：clock 10>9 → counter 1、clock 0、wave[1]=2 → 2*15=30 → 30>>4=1
  const outs = [];
  for (let k = 0; k < 41; k++) outs.push(chip.tick());
  const expected = [
    ...Array(10).fill(0),            // wave[0]*15=0
    ...Array(10).fill(30 >> 4),      // wave[1]=2  → 30>>4 = 1
    ...Array(10).fill(60 >> 4),      // wave[2]=4  → 60>>4 = 3
    ...Array(10).fill(90 >> 4),      // wave[3]=6  → 90>>4 = 5
    120 >> 4,                        // wave[4]=8  → 7
  ];
  assert.deepEqual(outs, expected);
  const c = chip.snapshot().channels[0];
  assert.equal(c.counter, 4);
  assert.equal(c.clock, 0);
});

test('一周は 32×(frequency+1) クロック', () => {
  const chip = new SccRef();
  rampWave(chip, 0);
  chip.setKey(1);
  chip.setFrequency(0, 100);
  chip.tick();
  const start = chip.snapshot().channels[0];
  chip.sumTicks(32 * 101);
  assert.deepEqual(chip.snapshot().channels[0], start);
});

test('frequency 8以下では止まり、最後の sample を出し続ける', () => {
  const chip = new SccRef();
  for (let i = 0; i < 32; i++) chip.writeWave(0, i, 100);
  chip.setKey(1);
  chip.setFrequency(0, 9);
  chip.tick(); // sample = 100*15 = 1500
  assert.equal(chip.snapshot().channels[0].sample, 1500);
  for (const f of [8, 1, 0]) {
    chip.setFrequency(0, f);
    const before = chip.snapshot().channels[0];
    assert.equal(chip.sumTicks(500), 500 * (1500 >> 4));
    const after = chip.snapshot().channels[0];
    assert.deepEqual(after, before, `frequency=${f}`);
    assert.equal(after.clock, -1);
  }
});

test('clock=-1：周波数の書き込みの次のクロックでは counter が進まない', () => {
  const chip = new SccRef();
  rampWave(chip, 0, 3);
  chip.setKey(1);
  chip.setFrequency(0, 9);
  chip.sumTicks(1 + 10 * 5 + 3); // counter=5、clock=3
  assert.equal(chip.snapshot().channels[0].counter, 5);
  chip.setFrequency(0, 20); // 途中で書き込む
  assert.equal(chip.snapshot().channels[0].clock, -1);
  chip.tick();
  const c = chip.snapshot().channels[0];
  assert.equal(c.counter, 5);
  assert.equal(c.clock, 0);
  assert.equal(c.sample, 15 * 15);
  // 次の読み直しは 21クロック後
  chip.sumTicks(20);
  assert.equal(chip.snapshot().channels[0].counter, 5);
  chip.tick();
  assert.equal(chip.snapshot().channels[0].counter, 6);
});

test('音量・キーの変更は次の読み直しまで音に出ない', () => {
  const chip = new SccRef();
  for (let i = 0; i < 32; i++) chip.writeWave(0, i, 64);
  chip.setKey(1);
  chip.setFrequency(0, 9);
  chip.tick(); // 64*15 = 960 → 60
  chip.setVolume(0, 0);
  chip.setKey(0);
  assert.equal(chip.sumTicks(9), 9 * 60);
  assert.equal(chip.tick(), 0); // 11クロック目で読み直し
});

test('音量0・キー切りでは出力0', () => {
  const chip = new SccRef();
  for (let i = 0; i < 32; i++) chip.writeWave(0, i, 127);
  chip.setFrequency(0, 9);
  chip.setVolume(0, 0);
  chip.setKey(1);
  assert.equal(chip.sumTicks(1000), 0);
  chip.setVolume(0, 15);
  chip.setKey(0);
  assert.equal(chip.sumTicks(1000), 0);
});

test('負の値は切り下げ（算術シフト）', () => {
  const chip = new SccRef();
  for (let i = 0; i < 32; i++) chip.writeWave(0, i, -1);
  chip.setVolume(0, 1);
  chip.setKey(1);
  chip.setFrequency(0, 9);
  assert.equal(chip.tick(), -1); // -1 >> 4 = -1
  chip.setVolume(0, 15);
  chip.writeWave(0, 1, -128);
  chip.sumTicks(9);
  assert.equal(chip.tick(), (-128 * 15) >> 4); // -1920>>4 = -120
});

test('値の範囲：周波数12ビット、音量4ビット、波形は符号付き8ビット', () => {
  const chip = new SccRef();
  chip.setFrequency(0, 0x1fff);
  assert.equal(chip.getFrequency(0), 0xfff);
  chip.setVolume(0, 0x1f);
  assert.equal(chip.snapshot().channels[0].volume, 15);
  chip.writeWave(0, 0, 200);
  assert.equal(chip.readWave(0, 0), 200 - 256);
  chip.writeWave(0, 33, 5); // 位置は 0〜31 に丸める
  assert.equal(chip.readWave(0, 1), 5);
});

test('バンク共有：ch4とch5（番号3と4）は同じ波形を読む', () => {
  const chip = new SccRef();
  for (let i = 0; i < 32; i++) chip.writeWave(3, i, 80);
  chip.setKey(0b11000);
  chip.setFrequency(3, 9);
  chip.setFrequency(4, 9);
  assert.equal(chip.tick(), 2 * ((80 * 15) >> 4));
  // 他のバンクには影響しない
  chip.setKey(0b00111);
  for (const ch of [0, 1, 2]) chip.setFrequency(ch, 9);
  chip.setFrequency(3, 9);
  chip.setFrequency(4, 9);
  assert.equal(chip.tick(), 0);
});

test('最大値：全チャンネル127・音量15の出力', () => {
  const chip = new SccRef();
  for (let b = 0; b < 4; b++) for (let i = 0; i < 32; i++) chip.writeWave(b, i, 127);
  chip.setKey(0b11111);
  for (let ch = 0; ch < 5; ch++) chip.setFrequency(ch, 4095);
  assert.equal(chip.tick(), 5 * ((127 * 15) >> 4)); // 5*119 = 595（/1024 で約0.58）
});

test('リセットは波形と sample を消さない', () => {
  const chip = new SccRef();
  for (let i = 0; i < 32; i++) chip.writeWave(0, i, 50);
  chip.setKey(1);
  chip.setFrequency(0, 9);
  chip.tick();
  chip.reset();
  const s = chip.snapshot();
  assert.equal(s.waves[0], 50);
  assert.equal(s.channels[0].sample, 750);
  assert.equal(s.channels[0].frequency, 0);
  assert.equal(chip.tick(), 750 >> 4);
});

test('範囲外のチャンネル・バンクは RangeError', () => {
  const chip = new SccRef();
  assert.throws(() => chip.setFrequency(5, 100), RangeError);
  assert.throws(() => chip.setVolume(-1, 1), RangeError);
  assert.throws(() => chip.writeWave(4, 0, 0), RangeError);
  assert.throws(() => chip.readWave(1.5, 0), RangeError);
});

test('チャンネル数を変えても動く（16チャンネル、追加分は共有しない）', () => {
  const chip = new SccRef(extendedConfig(16));
  assert.equal(chip.snapshot().channels.length, 16);
  for (let i = 0; i < 32; i++) chip.writeWave(14, i, 16); // ch15 専用
  chip.setKey(1 << 15);
  chip.setFrequency(15, 9);
  chip.setFrequency(14, 9);
  assert.equal(chip.tick(), (16 * 15) >> 4);
  const one = new SccRef(extendedConfig(1));
  assert.equal(one.snapshot().channels.length, 1);
});

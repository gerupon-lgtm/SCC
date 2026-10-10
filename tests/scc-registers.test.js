import { test } from 'node:test';
import assert from 'node:assert/strict';
import { SccRef } from '../src/core/scc-ref.js';
import { SccRegisters, OPEN_BUS } from '../src/core/scc-registers.js';
import { extendedConfig, validateConfig } from '../src/core/config.js';

const make = (cfg) => {
  const chip = new SccRef(cfg);
  return { chip, regs: new SccRegisters(chip) };
};

test('波形：0x00〜0x7F の全アドレスへ書いて読める（符号付きで保存）', () => {
  const { chip, regs } = make();
  for (let a = 0; a < 0x80; a++) regs.write(a, (a * 7 + 3) & 0xff);
  for (let a = 0; a < 0x80; a++) {
    assert.equal(regs.read(a), (a * 7 + 3) & 0xff, `addr ${a}`);
    const v = (a * 7 + 3) & 0xff;
    assert.equal(chip.readWave(a >> 5, a & 31), v >= 128 ? v - 256 : v);
  }
});

test('共有波形：0x60〜0x7F は ch4 と ch5 が同じものを鳴らす', () => {
  const { chip, regs } = make();
  for (let i = 0; i < 32; i++) regs.write(0x60 + i, 0x80); // -128
  regs.write(0x86, 9); regs.write(0x88, 9);
  regs.write(0x8f, 0b11000);
  assert.equal(chip.tick(), 2 * ((-128 * 15) >> 4));
});

test('周波数：下位・上位の書き込みと、clock=-1', () => {
  const { chip, regs } = make();
  for (let ch = 0; ch < 5; ch++) {
    regs.write(0x80 + ch * 2, 0x34);
    regs.write(0x81 + ch * 2, 0xf2); // 上位は下4ビットだけ
    assert.equal(chip.getFrequency(ch), 0x234);
    assert.equal(chip.snapshot().channels[ch].clock, -1);
    regs.write(0x80 + ch * 2, 0xff);
    assert.equal(chip.getFrequency(ch), 0x2ff);
  }
});

test('音量・キー', () => {
  const { chip, regs } = make();
  for (let ch = 0; ch < 5; ch++) regs.write(0x8a + ch, 0xf0 | ch);
  assert.deepEqual(chip.snapshot().channels.map((c) => c.volume), [0, 1, 2, 3, 4]);
  regs.write(0x8f, 0b11110101); // ビット5以上は無視
  assert.deepEqual(chip.snapshot().channels.map((c) => c.key), [true, false, true, false, true]);
});

test('鏡：0x90〜0x9F は 0x80〜0x8F と同じ', () => {
  const a = make(), b = make();
  for (let r = 0; r < 0x10; r++) {
    a.regs.write(0x80 + r, 0x5a + r);
    b.regs.write(0x90 + r, 0x5a + r);
  }
  assert.deepEqual(a.chip.snapshot(), b.chip.snapshot());
});

test('何もないアドレス 0xA0〜0xDF は状態を変えない。書き込み専用はオープンバスを読む', () => {
  const { chip, regs } = make();
  const before = chip.snapshot();
  for (let a = 0xa0; a < 0xe0; a++) regs.write(a, 0xff);
  assert.deepEqual(chip.snapshot(), before);
  for (let a = 0x80; a < 0xe0; a++) assert.equal(regs.read(a), OPEN_BUS, `addr ${a}`);
});

test('テストレジスタ 0xE0〜0xFF：値を保存するだけで、音は変えない', () => {
  const { chip, regs } = make();
  const before = chip.snapshot();
  regs.write(0xe0, 0x60); // MAMEでは波形の書き込み禁止になるビット。MVPでは効かない【設計】
  assert.equal(regs.read(0xff), 0x60);
  regs.write(0xff, 0x20);
  assert.equal(regs.read(0xe0), 0x20);
  assert.deepEqual(chip.snapshot(), before);
  regs.write(0x00, 5);
  assert.equal(regs.read(0x00), 5);
});

test('範囲外のアドレスは RangeError、値は下位8ビット', () => {
  const { regs } = make();
  for (const a of [-1, 0x100, 1.5, NaN]) {
    assert.throws(() => regs.write(a, 0), RangeError);
    assert.throws(() => regs.read(a), RangeError);
  }
  regs.write(0x00, 0x1ff);
  assert.equal(regs.read(0x00), 0xff);
});

test('16チャンネル設定：キーの書き込みは追加チャンネルに触れない', () => {
  const { chip, regs } = make(extendedConfig(16));
  chip.setKey(0xffff);
  regs.write(0x8f, 0);
  const keys = chip.snapshot().channels.map((c) => c.key);
  assert.deepEqual(keys, [...Array(5).fill(false), ...Array(11).fill(true)]);
});

test('チャンネル・バンクが少ない設定：無いものへの書き込みは無視', () => {
  const { chip, regs } = make(validateConfig({ channelCount: 2, waveBankCount: 2, channelWaveBank: [0, 1], clock: 3579545 }));
  regs.write(0x88, 9);   // ch4 の周波数
  regs.write(0x8e, 3);   // ch4 の音量
  regs.write(0x60, 1);   // バンク3
  regs.write(0x8f, 0xff);
  assert.equal(regs.read(0x60), OPEN_BUS);
  assert.equal(chip.snapshot().channels.length, 2);
  assert.deepEqual(chip.snapshot().channels.map((c) => c.key), [true, true]);
});

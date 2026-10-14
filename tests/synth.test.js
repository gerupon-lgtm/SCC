// T-011：発音の割り当て。MIDI → レジスタ → 基準版チップまでつないで確かめる
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { VoiceAllocator } from '../src/engine/voice-allocator.js';
import { Synth, noteToPeriod, velocityToVolume } from '../src/engine/synth.js';
import { SccRef } from '../src/core/scc-ref.js';
import { SccRegisters } from '../src/core/scc-registers.js';
import { getPreset } from '../src/core/presets.js';

function setup() {
  const chip = new SccRef();
  const regs = new SccRegisters(chip);
  let voices = [];
  const synth = new Synth(regs, { onVoices: (v) => { voices = v; } });
  synth.init();
  const ch = () => chip.snapshot().channels;
  return { chip, synth, ch, voices: () => voices };
}

test('音程：A4（69）は 3579545/(32*440)-1 ≒ 253', () => {
  assert.equal(noteToPeriod(69), Math.round(3579545 / (32 * 440)) - 1);
  assert.equal(noteToPeriod(69), 253);
  assert.equal(noteToPeriod(69 + 12), Math.round(3579545 / (32 * 880)) - 1);
  assert.equal(noteToPeriod(0), 4095);    // 低すぎる音は 4095 に丸める
  assert.ok(noteToPeriod(127) <= 8);      // 高すぎる音は止まる範囲
});

test('音量：round(vel/127*15)、最小1、CC7を掛ける', () => {
  assert.equal(velocityToVolume(127), 15);
  assert.equal(velocityToVolume(1), 1);
  assert.equal(velocityToVolume(64), 8);
  assert.equal(velocityToVolume(127, 0), 0);
  assert.equal(velocityToVolume(0), 0);
});

test('初期化：全バンクにプリセット波形、全チャンネル無音', () => {
  const { chip, ch } = setup();
  const sq = getPreset('square');
  for (let b = 0; b < 4; b++) for (let i = 0; i < 32; i++) assert.equal(chip.readWave(b, i), sq[i]);
  assert.ok(ch().every((c) => !c.key && c.volume === 0));
});

test('ノートオン → 空いているチャンネルに周波数・音量・キー', () => {
  const { synth, ch, voices } = setup();
  synth.noteOn(69, 127);
  synth.noteOn(72, 64);
  assert.deepEqual(ch().slice(0, 3).map((c) => [c.frequency, c.volume, c.key]),
    [[253, 15, true], [noteToPeriod(72), 8, true], [0, 0, false]]);
  assert.deepEqual(voices().map((v) => [v.ch, v.note]), [[0, 69], [1, 72]]);
});

test('6音目：一番古い音が止まり、そのチャンネルを使う', () => {
  const { synth, ch, voices } = setup();
  [60, 62, 64, 65, 67].forEach((n) => synth.noteOn(n, 100));
  synth.noteOn(69, 100);
  assert.deepEqual(voices().map((v) => [v.ch, v.note]), [[0, 69], [1, 62], [2, 64], [3, 65], [4, 67]]);
  assert.equal(ch()[0].frequency, 253);
  synth.noteOn(71, 100); // 7音目：次に古い 62（ch1）
  assert.deepEqual(voices().map((v) => v.note), [69, 71, 64, 65, 67]);
  synth.noteOff(60); // 止められた音のノートオフは何もしない
  assert.equal(voices().length, 5);
  assert.ok(ch().every((c) => c.key));
});

test('ノートオフ → 音量0・キー切り。ベロシティ0のノートオンも同じ', () => {
  const { synth, ch, voices } = setup();
  synth.noteOn(60, 100);
  synth.noteOn(64, 100);
  synth.noteOff(60);
  assert.deepEqual([ch()[0].volume, ch()[0].key], [0, false]);
  assert.equal(ch()[1].key, true);
  synth.handle({ type: 'noteOn', note: 64, velocity: 0, channel: 0 });
  assert.deepEqual([ch()[1].volume, ch()[1].key], [0, false]);
  assert.equal(voices().length, 0);
  synth.noteOff(99); // 鳴っていない音
});

test('同音の連打：同じチャンネルで鳴らし直す', () => {
  const { synth, voices } = setup();
  for (let i = 0; i < 10; i++) synth.noteOn(60, 100);
  assert.deepEqual(voices().map((v) => [v.ch, v.note]), [[0, 60]]);
  synth.noteOff(60);
  assert.equal(voices().length, 0);
});

test('全音停止（CC123）', () => {
  const { synth, ch, voices } = setup();
  [60, 62, 64].forEach((n) => synth.noteOn(n, 100));
  synth.handle({ type: 'cc', controller: 123, value: 0, channel: 0 });
  assert.equal(voices().length, 0);
  assert.ok(ch().every((c) => !c.key && c.volume === 0));
});

test('高すぎて止まる音は鳴らさない', () => {
  const { synth, voices } = setup();
  synth.noteOn(127, 100);
  assert.equal(voices().length, 0);
});

test('ピッチベンド ±2半音・CC7・プログラムチェンジ', () => {
  const { chip, synth, ch } = setup();
  synth.noteOn(69, 127);
  synth.handle({ type: 'pitchBend', value: 8191, channel: 0 });
  assert.equal(ch()[0].frequency, noteToPeriod(69 + 2 * 8191 / 8192));
  synth.handle({ type: 'pitchBend', value: -8192, channel: 0 });
  assert.equal(ch()[0].frequency, noteToPeriod(67));
  synth.handle({ type: 'cc', controller: 7, value: 64, channel: 0 });
  assert.equal(ch()[0].volume, 8);
  synth.handle({ type: 'program', program: 3, channel: 0 });
  assert.equal(chip.readWave(0, 8), getPreset('sine')[8]);
  synth.handle({ type: 'program', program: 7, channel: 0 }); // 5種で折り返す → triangle
  assert.equal(chip.readWave(3, 1), getPreset('triangle')[1]);
});

test('割り当て器：空きを先に使い、なければ最古', () => {
  const a = new VoiceAllocator(2);
  assert.equal(a.noteOn(60, 1).voice.ch, 0);
  assert.equal(a.noteOn(61, 1).voice.ch, 1);
  a.noteOff(60);
  assert.equal(a.noteOn(62, 1).voice.ch, 0);
  const r = a.noteOn(63, 1);
  assert.equal(r.voice.ch, 1);
  assert.equal(r.stolen.note, 61);
});

test('16チャンネル：16音まで同時に鳴り、17音目で一番古い音が止まる', async () => {
  const { SccExtRegisters } = await import('../src/core/scc-ext-registers.js');
  const { extendedConfig } = await import('../src/core/config.js');
  const cfg = extendedConfig(16);
  const chip = new SccRef(cfg);
  let voices = [];
  const synth = new Synth(new SccExtRegisters(chip), { config: cfg, onVoices: (v) => { voices = v; } });
  synth.init();
  for (let i = 0; i < 16; i++) synth.noteOn(48 + i, 100);
  let ch = chip.snapshot().channels;
  assert.ok(ch.every((c) => c.key && c.volume > 0), '16音すべて鳴る');
  assert.deepEqual(ch.map((c) => c.frequency), [...Array(16).keys()].map((i) => noteToPeriod(48 + i)));
  synth.noteOn(80, 100);
  assert.equal(voices.length, 16);
  assert.equal(voices.find((v) => v.ch === 0).note, 80);
  synth.noteOff(63); // ch15
  ch = chip.snapshot().channels;
  assert.deepEqual([ch[15].key, ch[15].volume], [false, 0]);
  assert.ok(ch[14].key && ch[4].key, 'ほかは鳴り続ける');
  // 波形は追加チャンネルの専用バンクにも書かれる
  synth.setWave('sine');
  assert.equal(chip.readWave(14, 8), getPreset('sine')[8]);
  synth.allNotesOff();
  assert.ok(chip.snapshot().channels.every((c) => !c.key && c.volume === 0));
});

// T-111：PSG の擬似ドラム（F-019）
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { PsgDrums, DRUM_MAP } from '../src/engine/psg-drums.js';
import { PsgRef } from '../src/core/psg-ref.js';
import { PsgStage } from '../src/core/psg-stage.js';

const BLOCK = 128 / 48000;

test('バスドラム：音程が下がりながら、音量が減って消える', () => {
  const psg = new PsgRef();
  const d = new PsgDrums(psg);
  assert.ok(d.trigger(36, 127));
  const tp = () => psg.readReg(0) | (psg.readReg(1) << 8);
  const tp0 = tp(), vol0 = psg.readReg(8);
  assert.equal(vol0, 15);
  assert.equal(psg.readReg(7) & 1, 0, '音程は鳴る');
  for (let i = 0; i < 20; i++) d.tick(BLOCK);
  assert.ok(tp() > tp0, '音程が下がる（周期が長くなる）');
  assert.ok(psg.readReg(8) < vol0);
  for (let i = 0; i < 200; i++) d.tick(BLOCK);
  assert.equal(psg.readReg(8), 0);
  assert.equal(psg.readReg(7) & 0x3f, 0x3f, '全部止まる');
});

test('3チャンネルを使い回し、4音目は一番古い音を止める。同じ音は同じチャンネル', () => {
  const d = new PsgDrums(new PsgRef());
  d.trigger(36, 100); d.trigger(38, 100); d.trigger(49, 100);
  assert.deepEqual([...d.notes], [36, 38, 49]);
  d.trigger(42, 100);
  assert.deepEqual([...d.notes], [42, 38, 49]);
  d.trigger(38, 100);
  assert.deepEqual([...d.notes], [42, 38, 49]);
});

test('クローズのハイハットはオープンを止める', () => {
  const d = new PsgDrums(new PsgRef());
  d.trigger(46, 100);
  d.trigger(42, 100);
  assert.ok(!d.notes.includes(46));
});

test('ベロシティで音量が下がる。表に無いノートは鳴らさない', () => {
  const psg = new PsgRef();
  const d = new PsgDrums(psg);
  d.trigger(38, 32);
  assert.equal(psg.readReg(8), 15 - 4);
  assert.equal(d.trigger(20, 100), false);
  assert.equal(d.trigger(81, 100), false);
});

test('全部止める：音量0', () => {
  const psg = new PsgRef();
  const d = new PsgDrums(psg);
  d.trigger(36, 127); d.trigger(38, 127); d.trigger(51, 127);
  d.stopAll();
  assert.deepEqual([8, 9, 10].map((r) => psg.readReg(r)), [0, 0, 0]);
});

test('すべての音色が音になり、鳴り終わると無音（0）に戻る', () => {
  const L = 3579545 / 48000;
  for (const note of Object.keys(DRUM_MAP).map(Number)) {
    const stage = new PsgStage();
    const d = new PsgDrums(stage.psg);
    d.trigger(note, 127);
    let peak = 0;
    for (let b = 0; b < (48000 * 1.2) / 128; b++) {
      for (let i = 0; i < 128; i++) peak = Math.max(peak, Math.abs(stage.sample(L)));
      d.tick(BLOCK);
    }
    assert.ok(peak > 0.05, `ノート${note} が鳴る（${peak}）`);
    assert.ok(d.notes.every((n) => n === -1), `ノート${note} が終わる`);
    for (let i = 0; i < 64; i++) stage.sample(L);
    assert.equal(stage.sample(L), 0, `ノート${note} の後は無音`);
  }
});

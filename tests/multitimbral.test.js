// T-103：マルチティンバー（F-015）。MIDI チャンネル1〜8 がパート、パートごとの波形・CC7・ピッチベンド
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { Synth, noteToPeriod, CUSTOM } from '../src/engine/synth.js';
import { SccRef } from '../src/core/scc-ref.js';
import { SccExtRegisters } from '../src/core/scc-ext-registers.js';
import { extendedConfig, SCC_COMPAT } from '../src/core/config.js';
import { getPreset } from '../src/core/presets.js';
import { DRUM_ADDR, DRUM_STOP_ADDR } from '../src/engine/psg-drums.js';

/** SCC のチップへ書き、ドラムのアドレスは別に記録する */
function setup(config = SCC_COMPAT) {
  const chip = new SccRef(config);
  const regs = new SccExtRegisters(chip);
  const drums = [];
  const sink = { write: (a, v) => (a >= DRUM_ADDR ? drums.push([a, v]) : regs.write(a, v)) };
  let voices = [];
  const synth = new Synth(sink, { config, drums: true, onVoices: (v) => { voices = v; } });
  synth.init();
  const on = (channel, note, velocity = 100) => synth.handle({ type: 'noteOn', channel, note, velocity });
  const off = (channel, note) => synth.handle({ type: 'noteOff', channel, note, velocity: 0 });
  const wave = (bank) => Array.from({ length: 32 }, (_, i) => chip.readWave(bank, i));
  return { chip, synth, drums, on, off, wave, voices: () => voices };
}
const preset = (name) => [...getPreset(name)];

test('パートごとの波形：鳴らすときに、そのチャンネルのバンクへ書く', () => {
  const { synth, on, wave, voices } = setup();
  synth.setWave('sine', 1);
  synth.setWave('saw', 2);
  on(0, 60); on(1, 64); on(2, 67);
  assert.deepEqual(voices().map((v) => [v.ch, v.part]), [[0, 0], [1, 1], [2, 2]]);
  assert.deepEqual(wave(0), preset('square'));
  assert.deepEqual(wave(1), preset('sine'));
  assert.deepEqual(wave(2), preset('saw'));
});

test('同じ音でもパートが違えば別の音。ノートオフはそのパートだけ', () => {
  const { on, off, voices } = setup();
  on(0, 60); on(1, 60);
  assert.equal(voices().length, 2);
  off(1, 60);
  assert.deepEqual(voices().map((v) => v.part), [0]);
});

test('ch4・ch5 は波形を共有する：違う波形のパートは同時に入れない', () => {
  const { synth, on, voices, wave } = setup();
  synth.setWave('triangle', 1);
  [60, 62, 64, 65].forEach((n) => on(0, n)); // パート1が ch1〜4
  on(1, 72); // パート2（三角波）：ch5 は ch4 と共有なので使えない → 一番古い ch1 を使う
  const p2 = voices().find((v) => v.part === 1);
  assert.equal(p2.ch, 0);
  assert.deepEqual(wave(0), preset('triangle'));
  assert.deepEqual(wave(3), preset('square'), 'ch4 の波形はそのまま');
  on(0, 67); // 同じ波形のパート1なら ch5 に入れる
  assert.equal(voices().find((v) => v.note === 67).ch, 4);
});

test('16チャンネル：追加チャンネルは専用バンクなので、どのパートでも入れる', () => {
  const cfg = extendedConfig(16);
  const { synth, on, voices, wave } = setup(cfg);
  const names = ['square', 'saw', 'triangle', 'sine', 'pulse25', 'saw', 'sine', 'triangle'];
  names.forEach((n, p) => synth.setWave(n, p));
  for (let p = 0; p < 8; p++) { on(p, 60 + p); on(p, 72 + p); }
  assert.equal(voices().length, 16);
  for (const v of voices()) {
    assert.deepEqual(wave(cfg.channelWaveBank[v.ch]), preset(names[v.part]), `ch${v.ch + 1}`);
  }
});

test('CC7・ピッチベンド・CC123 はそのパートだけに効く', () => {
  const { chip, on, synth, voices } = setup();
  on(0, 69, 127); on(1, 69, 127);
  const ch = () => chip.snapshot().channels;
  synth.handle({ type: 'cc', channel: 1, controller: 7, value: 64 });
  assert.deepEqual([ch()[0].volume, ch()[1].volume], [15, 8]);
  synth.handle({ type: 'pitchBend', channel: 1, value: -8192 });
  assert.deepEqual([ch()[0].frequency, ch()[1].frequency], [noteToPeriod(69), noteToPeriod(67)]);
  synth.handle({ type: 'cc', channel: 1, controller: 123, value: 0 });
  assert.deepEqual(voices().map((v) => v.part), [0]);
});

test('チャンネル9〜16（10 を除く）は鳴らさない', () => {
  const { on, voices } = setup();
  on(8, 60); on(15, 60);
  assert.equal(voices().length, 0);
});

test('自作の波形：CUSTOM のパートに効き、鳴っている音のバンクも書き直す', () => {
  const { synth, on, wave } = setup();
  const w1 = Array.from({ length: 32 }, (_, i) => i * 4 - 64);
  synth.setWaveData(w1, 2);
  on(2, 60);
  assert.deepEqual(wave(0), w1);
  const w2 = w1.map((v) => -v - 1);
  synth.setWaveData(w2, 2);
  assert.deepEqual(wave(0), w2, '鳴っている間に描き直しても変わる');
  assert.equal(synth.waveName, 'square', 'パート1はそのまま');
  assert.equal(synth.partWaves()[2], CUSTOM);
});

test('10チャンネル目はドラム：ベロシティに CC7 を掛けて、ドラムのアドレスへ。全音停止も伝える', () => {
  const { synth, drums, on, voices } = setup();
  on(9, 36, 100);
  synth.handle({ type: 'cc', channel: 9, controller: 7, value: 64 });
  on(9, 38, 127);
  synth.handle({ type: 'noteOff', channel: 9, note: 36, velocity: 0 });
  synth.allNotesOff();
  assert.deepEqual(drums, [[DRUM_ADDR + 36, 100], [DRUM_ADDR + 38, 64], [DRUM_STOP_ADDR, 0]]);
  assert.equal(voices().length, 0, 'SCC は鳴らさない');
});

test('ドラムを使わない設定では、10チャンネル目は何もしない', () => {
  const writes = [];
  const synth = new Synth({ write: (a) => writes.push(a) });
  synth.init();
  writes.length = 0;
  synth.handle({ type: 'noteOn', channel: 9, note: 36, velocity: 100 });
  synth.allNotesOff();
  assert.ok(writes.every((a) => a < DRUM_ADDR));
});

// T-109：SMF の読み取り。テストの中で小さな MIDI ファイルを組み立てて確かめる
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { parseSmf, isSmf, SmfError } from '../src/midi/smf.js';

const vlq = (n) => {
  const out = [n & 0x7f];
  while ((n >>= 7)) out.unshift((n & 0x7f) | 0x80);
  return out;
};
const u32 = (n) => [(n >>> 24) & 0xff, (n >>> 16) & 0xff, (n >>> 8) & 0xff, n & 0xff];
const track = (bytes) => ['M', 'T', 'r', 'k'].map((c) => c.charCodeAt(0)).concat(u32(bytes.length), bytes);
function smf(format, division, tracks) {
  const head = ['M', 'T', 'h', 'd'].map((c) => c.charCodeAt(0)).concat(u32(6), [0, format, 0, tracks.length, division >> 8, division & 0xff]);
  return Uint8Array.from(head.concat(...tracks.map(track)));
}
const END = [0x00, 0xff, 0x2f, 0x00];

test('形式0：4分音符480 tick、120BPM で C4 を1拍、ランニングステータスとベロシティ0のノートオフ', () => {
  const t = [
    0x00, 0x90, 60, 100,       // 0: C4 on
    ...vlq(480), 62, 90,       // 480: ランニングステータスで D4 on
    0x00, 60, 0,               // 480: C4 をベロシティ0で off
    ...vlq(480), 0x80, 62, 64, // 960: D4 off
    ...END];
  const { format, events, duration } = parseSmf(smf(0, 480, [t]));
  assert.equal(format, 0);
  assert.deepEqual(events.map((e) => [e.type, e.note, e.time]), [
    ['noteOn', 60, 0], ['noteOff', 60, 0.5], ['noteOn', 62, 0.5], ['noteOff', 62, 1.0]]);
  assert.equal(duration, 1.0);
});

test('テンポの変化（形式1、テンポは1トラック目）：途中から 60BPM なら1拍1秒', () => {
  const tempo = [0x00, 0xff, 0x51, 0x03, 0x07, 0xa1, 0x20, // 0: 500000µs（120BPM）
    ...vlq(960), 0xff, 0x51, 0x03, 0x0f, 0x42, 0x40,      // 960: 1000000µs（60BPM）
    0x00, 0xff, 0x03, 0x04, 0x54, 0x45, 0x53, 0x54,       // 曲名 "TEST"
    ...END];
  const notes = [...vlq(1920), 0x91, 64, 80, ...vlq(480), 0x81, 64, 0, ...END];
  const { events, title } = parseSmf(smf(1, 480, [tempo, notes]));
  // 960 tick までは 0.5秒/拍で 1.0秒。そこから 960 tick（2拍）は 1秒/拍で +2.0秒 → 3.0秒。さらに 480 tick で 4.0秒
  assert.deepEqual(events.map((e) => [e.type, e.channel, e.time]), [['noteOn', 1, 3.0], ['noteOff', 1, 4.0]]);
  assert.equal(title, 'TEST');
});

test('CC・プログラム・ピッチベンド・システムエクスクルーシブ（飛ばす）', () => {
  const t = [0x00, 0xf0, 0x03, 0x7e, 0x7f, 0xf7, 0x00, 0xb0, 7, 100, 0x00, 0xc0, 5, 0x00, 0xe0, 0x00, 0x40, ...END];
  const { events } = parseSmf(smf(0, 96, [t]));
  assert.deepEqual(events.map((e) => e.type), ['cc', 'program', 'pitchBend']);
  assert.equal(events[2].value, 0);
});

test('同じ時刻ではノートオフを先に並べる（同じ音の連打を切らない）', () => {
  const a = [0x00, 0x90, 60, 100, ...vlq(96), 0x90, 60, 100, ...END];
  const b = [...vlq(96), 0x80, 60, 0, ...END];
  const { events } = parseSmf(smf(1, 96, [a, b]));
  assert.deepEqual(events.map((e) => e.type), ['noteOn', 'noteOff', 'noteOn']);
});

test('対応しない・壊れたファイルは分かる言葉で断る', () => {
  assert.equal(isSmf(new Uint8Array(20)), false);
  assert.throws(() => parseSmf(new Uint8Array(20)), SmfError);
  assert.throws(() => parseSmf(smf(2, 96, [END])), /形式2/);
  assert.throws(() => parseSmf(smf(0, 0xe728, [END])), /SMPTE/);
  const broken = smf(0, 96, [[0x00, 0x90, 60]]);
  assert.throws(() => parseSmf(broken), SmfError);
});

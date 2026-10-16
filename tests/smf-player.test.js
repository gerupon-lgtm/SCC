// T-109：SMF の再生。偽の時計と記録用の Synth で、時刻つきの処理を確かめる
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { SmfPlayer } from '../src/engine/smf-player.js';

function setup(events, duration) {
  let now = 10;
  let schedule = null;
  const log = [];
  const synth = {
    handle: (ev) => log.push([ev.type, ev.channel, ev.note ?? ev.value ?? ev.program, schedule]),
    resetControllers: () => log.push(['reset']),
    allNotesOff: () => log.push(['allOff']),
  };
  let ended = 0;
  const player = new SmfPlayer({
    synth,
    clock: { now: () => now, setScheduleTime: (t) => { schedule = t; } },
    onEnd: () => { ended++; },
    lookahead: 0.2,
    interval: 1e9, // タイマーは使わず、pump() を手で呼ぶ
  });
  player.load({ events, duration });
  return { player, log, advance: (dt) => { now += dt; player.pump(); }, ended: () => ended };
}

test('先渡し：今から0.2秒先までの出来事を、鳴らす時刻を付けて Synth へ渡す', () => {
  const { player, log, advance } = setup([
    { type: 'noteOn', note: 60, velocity: 100, channel: 0, time: 0 },
    { type: 'noteOn', note: 64, velocity: 100, channel: 0, time: 0.25 },
    { type: 'noteOff', note: 60, channel: 0, time: 1.0 },
  ], 1.0);
  player.play(); // 開始は 10.1 秒（0.1秒の余裕）
  assert.deepEqual(log, [['reset'], ['noteOn', 0, 60, 10.1]]);
  advance(0.2); // 10.2 → 曲の 0.1 秒。0.3 秒先までなので 0.25 の音も
  assert.deepEqual(log.at(-1), ['noteOn', 0, 64, 10.35]);
  advance(1.0);
  assert.deepEqual(log.at(-1), ['noteOff', 0, 60, 11.1]);
  player.stop();
});

test('全チャンネル（打楽器・プログラムチェンジ・ピッチベンドも）を Synth へ渡す。振り分けは Synth が行う', () => {
  const { player, log } = setup([
    { type: 'noteOn', note: 36, velocity: 100, channel: 9, time: 0 },
    { type: 'cc', controller: 7, value: 64, channel: 1, time: 0 },
    { type: 'program', program: 3, channel: 1, time: 0 },
    { type: 'pitchBend', value: 4000, channel: 1, time: 0 },
  ], 0);
  player.play();
  assert.deepEqual(log.slice(1).map((e) => e.slice(0, 2)), [['noteOn', 9], ['cc', 1], ['program', 1], ['pitchBend', 1]]);
  player.stop();
});

test('最後まで進むと止まり、鳴っている音を消して onEnd を呼ぶ', () => {
  const { player, log, advance, ended } = setup([{ type: 'noteOn', note: 60, velocity: 100, channel: 0, time: 0 }], 0.5);
  player.play();
  advance(0.5);
  assert.equal(player.playing, true);
  advance(0.5); // 曲の 0.9 秒 > 0.5 + 0.3
  assert.equal(player.playing, false);
  assert.equal(ended(), 1);
  assert.deepEqual(log.at(-1), ['allOff']);
});

test('途中で止めると、鳴っている音を消す。位置は0に戻る', () => {
  const { player, log, advance } = setup([{ type: 'noteOn', note: 60, velocity: 100, channel: 0, time: 0 }], 10);
  player.play();
  advance(1);
  assert.ok(Math.abs(player.position - 0.9) < 1e-9);
  player.stop();
  assert.deepEqual(log.at(-1), ['allOff']);
  assert.equal(player.position, 0);
});

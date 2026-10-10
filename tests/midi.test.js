// T-010：MIDIの解釈と、Web MIDI 入力（拒否・非対応・機器なし・途中で抜く・多数のノート）
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { parseMidi } from '../src/midi/midi-parse.js';
import { MidiInput } from '../src/midi/midi-input.js';

test('ノートオン・オフ・ベロシティ0', () => {
  assert.deepEqual(parseMidi([0x90, 60, 100]), { type: 'noteOn', note: 60, velocity: 100, channel: 0 });
  assert.deepEqual(parseMidi([0x9f, 60, 0]), { type: 'noteOff', note: 60, channel: 15 });
  assert.deepEqual(parseMidi([0x83, 61, 64]), { type: 'noteOff', note: 61, channel: 3 });
});

test('CC・ピッチベンド・プログラムチェンジ', () => {
  assert.deepEqual(parseMidi([0xb0, 7, 90]), { type: 'cc', controller: 7, value: 90, channel: 0 });
  assert.deepEqual(parseMidi([0xe0, 0, 0x40]), { type: 'pitchBend', value: 0, channel: 0 });
  assert.equal(parseMidi([0xe0, 0, 0]).value, -8192);
  assert.equal(parseMidi([0xe0, 0x7f, 0x7f]).value, 8191);
  assert.deepEqual(parseMidi([0xc2, 4]), { type: 'program', program: 4, channel: 2 });
});

test('対応しない・壊れたメッセージは null', () => {
  for (const d of [[], [0x40, 1, 2], [0xf8], [0xf0, 1, 2, 0xf7], [0xa0, 60, 10], [0xd0, 5],
    [0x90, 60], [0x90, 128, 1], [0xb0, 7, 200], null]) {
    assert.equal(parseMidi(d), null, JSON.stringify(d));
  }
});

/** Web MIDI の代わり */
function fakeMidi() {
  const inputs = new Map();
  const access = { inputs, onstatechange: null };
  const add = (id, name) => {
    const port = { id, name, state: 'connected', onmidimessage: null };
    inputs.set(id, port);
    access.onstatechange?.({ port });
    return port;
  };
  const remove = (id) => {
    const port = inputs.get(id);
    inputs.delete(id);
    access.onstatechange?.({ port: { ...port, state: 'disconnected' } });
  };
  return { access, add, remove };
}

function collect(nav) {
  const states = [], events = [];
  let disconnects = 0;
  const midi = new MidiInput({
    nav,
    onEvent: (e) => events.push(e),
    onState: (s, names) => states.push([s, names]),
    onDisconnect: () => { disconnects++; },
  });
  return { midi, states, events, disconnects: () => disconnects };
}

test('非対応：requestMIDIAccess がない', async () => {
  const { midi, states } = collect({});
  assert.equal(await midi.start(), 'unsupported');
  assert.deepEqual(states, [['unsupported', []]]);
});

test('拒否：許可されなかった。もう一度試せる', async () => {
  let allow = false;
  const f = fakeMidi();
  const nav = { requestMIDIAccess: async () => { if (!allow) throw new DOMException('denied', 'SecurityError'); return f.access; } };
  const { midi } = collect(nav);
  assert.equal(await midi.start(), 'denied');
  allow = true;
  assert.equal(await midi.start(), 'noDevice');
});

test('機器なし → 差す → 届く → 途中で抜く', async () => {
  const f = fakeMidi();
  const { midi, states, events, disconnects } = collect({ requestMIDIAccess: async () => f.access });
  assert.equal(await midi.start(), 'noDevice');
  const port = f.add('k1', 'Keyboard');
  assert.deepEqual(states.at(-1), ['ready', ['Keyboard']]);
  port.onmidimessage({ data: Uint8Array.of(0x90, 60, 100) });
  port.onmidimessage({ data: Uint8Array.of(0xfe) }); // アクティブセンシングは無視
  assert.deepEqual(events, [{ type: 'noteOn', note: 60, velocity: 100, channel: 0 }]);
  f.remove('k1');
  assert.deepEqual(states.at(-1), ['noDevice', []]);
  assert.equal(disconnects(), 1);
});

test('同時に多数のノート：全部届く', async () => {
  const f = fakeMidi();
  const port = f.add('k1', 'Keyboard');
  const { midi, events } = collect({ requestMIDIAccess: async () => f.access });
  assert.equal(await midi.start(), 'ready');
  for (let n = 0; n < 128; n++) port.onmidimessage({ data: Uint8Array.of(0x90, n, 64) });
  assert.equal(events.length, 128);
});

// 鐘の WAV 書き出し：形式が正しく、3秒以内に鳴り終わり、最後は無音
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { renderBell, normalize, encodeWav } from '../tools/render-bell.js';
import { BELL_PRESETS } from '../src/bell/bell-voice.js';

test('WAVの見出し：48,000Hz・16ビット・モノラル、長さが合う', () => {
  const buf = encodeWav(new Float64Array(480), 48000);
  assert.equal(buf.toString('ascii', 0, 4), 'RIFF');
  assert.equal(buf.toString('ascii', 8, 12), 'WAVE');
  assert.equal(buf.readUInt16LE(20), 1);
  assert.equal(buf.readUInt16LE(22), 1);
  assert.equal(buf.readUInt32LE(24), 48000);
  assert.equal(buf.readUInt16LE(34), 16);
  assert.equal(buf.readUInt32LE(40), 960);
  assert.equal(buf.length, 44 + 960);
});

for (const name of ['small', 'church']) {
  test(`${name}：C4で3秒の中に収まり、最後の0.05秒は無音。振れ幅は -1dBFS`, () => {
    const s = normalize(renderBell(BELL_PRESETS[name].params, 60, 3.0));
    assert.equal(s.length, 144000);
    const max = s.reduce((m, v) => Math.max(m, Math.abs(v)), 0);
    assert.ok(Math.abs(max - 10 ** (-1 / 20)) < 1e-9);
    const tail = s.subarray(s.length - 2400);
    assert.ok(tail.every((v) => Math.abs(v) < 0.001), '最後に音が残っている');
  });
}

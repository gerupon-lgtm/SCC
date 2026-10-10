// T-013：基準版と高速版の処理時間（Node.js で測る。ブラウザでは画面の「処理の重さ」で見る）
// 使い方：node tools/bench.js
// 全チャンネルを鳴らし、48,000Hz で 5 秒分の音を作る時間を測る
import { SccRef } from '../src/core/scc-ref.js';
import { SccFast } from '../src/core/scc-fast.js';
import { WindowConverter } from '../src/core/window-converter.js';
import { PostStage } from '../src/core/post-stage.js';
import { extendedConfig } from '../src/core/config.js';
import { getPreset } from '../src/core/presets.js';

const RATE = 48000;
const SECONDS = 5;
const BLOCK = 128;

/** @param {'ref'|'fast'} kind @param {number} channels @param {'mid'|'high'} pitch */
function run(kind, channels, pitch) {
  const cfg = extendedConfig(channels);
  const chip = kind === 'ref' ? new SccRef(cfg) : new SccFast(cfg);
  const wave = getPreset('saw');
  for (let b = 0; b < cfg.waveBankCount; b++) for (let i = 0; i < 32; i++) chip.writeWave(b, i, wave[i]);
  for (let ch = 0; ch < channels; ch++) chip.setFrequency(ch, pitch === 'high' ? 9 + ch : 200 + ch * 37);
  chip.setKey((1 << channels) - 1);
  const conv = new WindowConverter(cfg.clock, RATE);
  const post = new PostStage(RATE, channels);
  const buf = new Float32Array(BLOCK);
  const blocks = (RATE * SECONDS) / BLOCK;
  for (let i = 0; i < 200; i++) { conv.render(chip, buf); post.process(buf); } // 慣らし
  const t0 = performance.now();
  for (let i = 0; i < blocks; i++) { conv.render(chip, buf); post.process(buf); }
  const ms = performance.now() - t0;
  return ms / (SECONDS * 1000); // 1 なら実時間ちょうど
}

console.log(`Node ${process.version}、${RATE}Hz、${SECONDS}秒分。値は「実時間に対する処理時間の割合」（小さいほど軽い）`);
console.log('| 版 | チャンネル | 音の高さ | 割合 |');
console.log('| --- | --- | --- | --- |');
for (const channels of [5, 16]) {
  for (const pitch of ['mid', 'high']) {
    for (const kind of ['ref', 'fast']) {
      const r = run(kind, channels, pitch);
      const label = pitch === 'high' ? '最も高い（frequency 9〜）' : '中くらい（frequency 200〜）';
      console.log(`| ${kind === 'ref' ? '基準版' : '高速版'} | ${channels} | ${label} | ${(r * 100).toFixed(2)}% |`);
    }
  }
}

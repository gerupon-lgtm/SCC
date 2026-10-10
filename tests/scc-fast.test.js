// T-007：高速版が基準版と完全一致すること（sumTicks の返り値と、状態の両方）
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { join } from 'node:path';
import { SccRef } from '../src/core/scc-ref.js';
import { SccFast } from '../src/core/scc-fast.js';
import { SccRegisters } from '../src/core/scc-registers.js';
import { extendedConfig } from '../src/core/config.js';
import { CASES, mulberry32, runLengthDecode } from '../tools/mame-check/ops.js';

/** 同じ操作を両方へ */
function pair(config) {
  const ref = new SccRef(config), fast = new SccFast(config);
  return { ref, fast, both: (fn) => { fn(ref); fn(fast); } };
}

function assertSame(ref, fast, n, msg) {
  const a = ref.sumTicks(n), b = fast.sumTicks(n);
  if (a !== b) assert.fail(`${msg}：sumTicks(${n}) 基準版 ${a}、高速版 ${b}`);
}

function assertSameState(ref, fast, msg) {
  assert.deepEqual(fast.snapshot(), ref.snapshot(), msg);
}

/**
 * 乱数の操作列。チップのAPIを直接呼ぶので、追加チャンネルにも使える
 * @param {number} seed
 * @param {import('../src/core/config.js').SccConfig} [config]
 */
function randomRun(seed, config, steps = 3000) {
  const rnd = mulberry32(seed);
  const int = (n) => Math.floor(rnd() * n);
  const { ref, fast, both } = pair(config);
  const cfg = ref.config;
  for (let b = 0; b < cfg.waveBankCount; b++) for (let i = 0; i < 32; i++) {
    const v = int(256) - 128;
    both((c) => c.writeWave(b, i, v));
  }
  const freqs = [0, 1, 8, 9, 10, 11, 4094, 4095];
  for (let s = 0; s < steps; s++) {
    const r = rnd();
    const ch = int(cfg.channelCount);
    if (r < 0.2) {
      const f = rnd() < 0.5 ? freqs[int(freqs.length)] : int(4096);
      both((c) => c.setFrequency(ch, f));
    } else if (r < 0.3) {
      const v = int(16);
      both((c) => c.setVolume(ch, v));
    } else if (r < 0.4) {
      const m = int(1 << cfg.channelCount);
      both((c) => c.setKey(m));
    } else if (r < 0.55) {
      const b = int(cfg.waveBankCount), i = int(32), v = int(256) - 128;
      both((c) => c.writeWave(b, i, v));
    } else {
      // 1音声サンプル分（74・75）・1クロック・長い区間・0 を混ぜる
      const n = [74, 75, 1, 0, int(400), int(20000)][int(6)];
      assertSame(ref, fast, n, `seed ${seed} step ${s}`);
    }
  }
  assertSameState(ref, fast, `seed ${seed} 最終状態`);
}

test('乱数の操作列（5チャンネル、シード固定）', () => {
  for (const seed of [1, 2, 3, 42, 20261010]) randomRun(seed);
});

test('16チャンネル設定でも一致', () => {
  for (const seed of [5, 6]) randomRun(seed, extendedConfig(16));
});

test('チャンネル数1でも一致', () => {
  randomRun(8, extendedConfig(1), 1000);
});

test('境界の周波数 9 と 4095：1クロックずつ一致', () => {
  for (const f of [9, 4095, 8, 10]) {
    const { ref, fast, both } = pair();
    for (let i = 0; i < 32; i++) both((c) => c.writeWave(0, i, i * 8 - 128));
    both((c) => c.setKey(1));
    both((c) => c.setFrequency(0, f));
    const ticks = Math.min(32 * (f + 1) * 2 + 5, 20000);
    for (let k = 0; k < ticks; k++) assertSame(ref, fast, 1, `f=${f} k=${k}`);
    assertSameState(ref, fast, `f=${f}`);
  }
});

test('途中の書き込み：読み直しの直前・直後・同時に周波数を変える', () => {
  for (let offset = 0; offset <= 12; offset++) {
    const { ref, fast, both } = pair();
    for (let i = 0; i < 32; i++) both((c) => c.writeWave(0, i, 100 - i * 7));
    both((c) => c.setKey(1));
    both((c) => c.setFrequency(0, 9));
    assertSame(ref, fast, 1 + 10 * 3 + offset, `offset ${offset}`);
    both((c) => c.setFrequency(0, 11));
    assertSame(ref, fast, 75, `offset ${offset} 書き込み後`);
    both((c) => c.setVolume(0, 3));
    both((c) => c.setKey(0));
    both((c) => c.writeWave(0, 5, -77));
    assertSame(ref, fast, 74, `offset ${offset} 音量・キー後`);
    both((c) => c.setFrequency(0, 8)); // 止める
    assertSame(ref, fast, 75, `offset ${offset} 停止後`);
    both((c) => c.setFrequency(0, 4095));
    assertSame(ref, fast, 75, `offset ${offset} 再開後`);
    assertSameState(ref, fast, `offset ${offset}`);
  }
});

test('全チャンネル同時に鳴らす（共有バンクを含む）', () => {
  const { ref, fast, both } = pair();
  for (let b = 0; b < 4; b++) for (let i = 0; i < 32; i++) both((c) => c.writeWave(b, i, (i * 37 + b * 11) % 256 - 128));
  both((c) => c.setKey(0b11111));
  [9, 100, 523, 1000, 4095].forEach((f, ch) => both((c) => c.setFrequency(ch, f)));
  for (let k = 0; k < 5000; k++) assertSame(ref, fast, k % 2 ? 74 : 75, `block ${k}`);
  assertSameState(ref, fast, '全チャンネル');
});

test('MAMEの記録とも一致（区切りを変えて sumTicks で比べる）', () => {
  const dir = fileURLToPath(new URL('./fixtures/mame/', import.meta.url));
  for (const c of CASES) {
    const ops = readFileSync(join(dir, `${c.name}.ops`), 'utf8').trim().split('\n');
    const expected = runLengthDecode(readFileSync(join(dir, `${c.name}.out`), 'utf8'));
    const fast = new SccFast();
    const regs = new SccRegisters(fast);
    const rnd = mulberry32(c.seed);
    let pos = 0;
    for (const line of ops) {
      const [op, a, b] = line.split(' ');
      if (op === 'W') { regs.write(parseInt(a, 16), parseInt(b, 16)); continue; }
      let n = Number(a);
      while (n > 0) {
        const m = Math.min(n, 1 + Math.floor(rnd() * 120));
        let want = 0;
        for (let i = 0; i < m; i++) want += expected[pos + i];
        const got = fast.sumTicks(m);
        if (got !== want) assert.fail(`${c.name}：${pos} クロック目からの ${m} クロック 高速版 ${got}、MAME ${want}`);
        pos += m; n -= m;
      }
    }
    assert.equal(pos, expected.length);
  }
});

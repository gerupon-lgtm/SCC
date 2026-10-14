// T-102：追加チャンネル（最大16）のアドレス層
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { SccRef } from '../src/core/scc-ref.js';
import { SccFast } from '../src/core/scc-fast.js';
import { SccRegisters } from '../src/core/scc-registers.js';
import { SccExtRegisters, channelAddr, waveAddr } from '../src/core/scc-ext-registers.js';
import { SCC_COMPAT, extendedConfig } from '../src/core/config.js';
import { OPEN_BUS } from '../src/core/scc-registers.js';
import { mulberry32 } from '../tools/mame-check/ops.js';

test('0x00〜0xFF は SCC互換の層と同じ動き', () => {
  const a = new SccRef(), b = new SccRef();
  const ra = new SccRegisters(a), rb = new SccExtRegisters(b);
  const rnd = mulberry32(3);
  for (let i = 0; i < 2000; i++) {
    const addr = Math.floor(rnd() * 256), v = Math.floor(rnd() * 256);
    ra.write(addr, v); rb.write(addr, v);
    assert.equal(rb.read(addr), ra.read(addr));
  }
  assert.deepEqual(b.snapshot(), a.snapshot());
});

test('追加チャンネル：周波数・音量・キー・専用の波形', () => {
  const chip = new SccRef(extendedConfig(16));
  const regs = new SccExtRegisters(chip);
  for (let ch = 5; ch < 16; ch++) {
    const a = channelAddr(ch);
    regs.write(a.freqLo, 0x34);
    regs.write(a.freqHi, 0xf2);
    regs.write(a.volume, 0xf0 | (ch - 5));
    regs.write(a.key, 1);
    const c = chip.snapshot().channels[ch];
    assert.deepEqual([c.frequency, c.volume, c.key, c.clock], [0x234, ch - 5, true, -1], `ch${ch}`);
  }
  // 追加チャンネルのキーは、SCC互換のキー（0x8F）で消えない
  regs.write(0x8f, 0);
  assert.ok(chip.snapshot().channels.slice(5).every((c) => c.key));
  regs.write(channelAddr(9).key, 0);
  assert.equal(chip.snapshot().channels[9].key, false);
  // 波形：バンク4〜14
  for (let bank = 4; bank < 15; bank++) {
    regs.write(waveAddr(bank, 3), 0x80 + bank);
    assert.equal(chip.readWave(bank, 3), 0x80 + bank - 256);
    assert.equal(regs.read(waveAddr(bank, 3)), 0x80 + bank);
  }
});

test('アドレスの対応：ch1〜5 は SCC互換、バンク0〜3 は 0x00〜0x7F', () => {
  assert.deepEqual(channelAddr(0), { freqLo: 0x80, freqHi: 0x81, volume: 0x8a, key: null });
  assert.deepEqual(channelAddr(4), { freqLo: 0x88, freqHi: 0x89, volume: 0x8e, key: null });
  assert.deepEqual(channelAddr(5), { freqLo: 0x100, freqHi: 0x101, volume: 0x102, key: 0x103 });
  assert.deepEqual(channelAddr(15), { freqLo: 0x128, freqHi: 0x129, volume: 0x12a, key: 0x12b });
  assert.equal(waveAddr(3, 31), 0x7f);
  assert.equal(waveAddr(4, 0), 0x200);
  assert.equal(waveAddr(14, 31), 0x200 + 10 * 32 + 31);
});

test('5チャンネルの設定：追加チャンネルのアドレスは無視。範囲外は RangeError', () => {
  const chip = new SccRef(SCC_COMPAT);
  const regs = new SccExtRegisters(chip);
  const before = chip.snapshot();
  regs.write(0x100, 9); regs.write(0x103, 1); regs.write(0x200, 5); regs.write(0x150, 1); regs.write(0x3ff, 1);
  assert.deepEqual(chip.snapshot(), before);
  assert.equal(regs.read(0x200), OPEN_BUS);
  for (const a of [-1, 0x400, 1.5]) assert.throws(() => regs.write(a, 0), RangeError);
});

test('16チャンネル：同じ操作で基準版と高速版が一致（拡張アドレス経由）', () => {
  const cfg = extendedConfig(16);
  const ref = new SccRef(cfg), fast = new SccFast(cfg);
  const rr = new SccExtRegisters(ref), rf = new SccExtRegisters(fast);
  const rnd = mulberry32(16);
  for (let s = 0; s < 3000; s++) {
    if (rnd() < 0.7) {
      const ch = Math.floor(rnd() * 16);
      const a = ch < 5 ? null : channelAddr(ch);
      const choices = a ? [a.freqLo, a.freqHi, a.volume, a.key, waveAddr(ch - 1, Math.floor(rnd() * 32))]
        : [0x80 + ch * 2, 0x81 + ch * 2, 0x8a + ch, 0x8f, Math.floor(rnd() * 0x80)];
      const addr = choices[Math.floor(rnd() * choices.length)];
      const v = Math.floor(rnd() * 256);
      rr.write(addr, v); rf.write(addr, v);
    } else {
      const n = [74, 75, 1, 300][Math.floor(rnd() * 4)];
      assert.equal(fast.sumTicks(n), ref.sumTicks(n), `step ${s}`);
    }
  }
  assert.deepEqual(fast.snapshot(), ref.snapshot());
});

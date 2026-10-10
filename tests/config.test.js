import { test } from 'node:test';
import assert from 'node:assert/strict';
import { SCC_COMPAT, validateConfig, extendedConfig, SccError } from '../src/core/config.js';

const isConfigError = (e) => e instanceof SccError && e.code === 'E_CONFIG';

test('SCC互換の設定は正しい', () => {
  const c = validateConfig(SCC_COMPAT);
  assert.equal(c.channelCount, 5);
  assert.deepEqual([...c.channelWaveBank], [0, 1, 2, 3, 3]);
  assert.ok(Object.isFrozen(c) && Object.isFrozen(c.channelWaveBank));
});

test('不整合な設定は E_CONFIG', () => {
  const base = { ...SCC_COMPAT, channelWaveBank: [...SCC_COMPAT.channelWaveBank] };
  const bad = [
    { ...base, channelWaveBank: [0, 1, 2, 3] },          // 長さ違い
    { ...base, channelWaveBank: [0, 1, 2, 3, 4] },       // 範囲外のバンク
    { ...base, channelWaveBank: [0, 1, 2, 3, -1] },      // 負のバンク
    { ...base, channelWaveBank: [0, 1, 2, 3, 1.5] },     // 整数でない
    { ...base, channelCount: 0, channelWaveBank: [] },   // 0チャンネル
    { ...base, channelCount: 17, channelWaveBank: Array(17).fill(0) }, // 上限超え
    { ...base, waveBankCount: 0 },
    { ...base, clock: 0 },
    { ...base, clock: 3579545.5 },
    { ...base, channelWaveBank: undefined },
    null,
  ];
  for (const cfg of bad) assert.throws(() => validateConfig(cfg), isConfigError, JSON.stringify(cfg));
});

test('元の配列を後から変えても、検査済みの設定は変わらない', () => {
  const banks = [0, 1, 2, 3, 3];
  const c = validateConfig({ ...SCC_COMPAT, channelWaveBank: banks });
  banks[0] = 9;
  assert.equal(c.channelWaveBank[0], 0);
});

test('拡張チャンネル：追加分は共有しない', () => {
  const c16 = extendedConfig(16);
  assert.equal(c16.channelCount, 16);
  assert.deepEqual([...c16.channelWaveBank], [0, 1, 2, 3, 3, 4, 5, 6, 7, 8, 9, 10, 11, 12, 13, 14]);
  assert.equal(c16.waveBankCount, 15);
  const c5 = extendedConfig(5);
  assert.deepEqual([...c5.channelWaveBank], [0, 1, 2, 3, 3]);
  assert.equal(c5.waveBankCount, 4);
  assert.throws(() => extendedConfig(17), isConfigError);
});

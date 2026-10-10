// チップの設定（F-010）。チャンネル数と波形の共有は、コードに直接書かずにここで決める
// 意味は docs/data-model.md 1章

/** 1バンクの波形の長さ */
export const WAVE_LENGTH = 32;

/** 追加チャンネル（F-011）の上限 */
export const MAX_CHANNELS = 16;

/** エラーコードつきの例外（コードは docs/api-design.md 5章） */
export class SccError extends Error {
  /**
   * @param {string} code
   * @param {string} message
   */
  constructor(code, message) {
    super(message);
    this.name = 'SccError';
    this.code = code;
  }
}

/**
 * @typedef {object} SccConfig
 * @property {number} channelCount
 * @property {number} waveBankCount
 * @property {number[]} channelWaveBank チャンネルiが使う波形バンク番号（0始まり）
 * @property {number} clock チップのクロック（Hz）
 */

/** @type {Readonly<SccConfig>} SCC互換（ch4とch5がバンク3を共有）【確認】 */
export const SCC_COMPAT = Object.freeze({
  channelCount: 5,
  waveBankCount: 4,
  channelWaveBank: Object.freeze([0, 1, 2, 3, 3]),
  clock: 3579545, // MSXの値。アーケードは未確認
});

/**
 * 設定を検査し、凍結した写しを返す。不整合なら E_CONFIG を投げる
 * @param {SccConfig} cfg
 * @returns {Readonly<SccConfig>}
 */
export function validateConfig(cfg) {
  const fail = (msg) => { throw new SccError('E_CONFIG', msg); };
  if (cfg === null || typeof cfg !== 'object') fail('設定がありません');
  const { channelCount, waveBankCount, channelWaveBank, clock } = cfg;
  if (!Number.isInteger(channelCount) || channelCount < 1 || channelCount > MAX_CHANNELS) {
    fail(`channelCount は 1〜${MAX_CHANNELS} の整数にしてください（${channelCount}）`);
  }
  if (!Number.isInteger(waveBankCount) || waveBankCount < 1) {
    fail(`waveBankCount は 1以上の整数にしてください（${waveBankCount}）`);
  }
  if (!Array.isArray(channelWaveBank) || channelWaveBank.length !== channelCount) {
    fail(`channelWaveBank の長さ（${channelWaveBank?.length}）が channelCount（${channelCount}）と違います`);
  }
  channelWaveBank.forEach((b, i) => {
    if (!Number.isInteger(b) || b < 0 || b >= waveBankCount) {
      fail(`channelWaveBank[${i}]（${b}）が範囲外です（0〜${waveBankCount - 1}）`);
    }
  });
  if (!Number.isInteger(clock) || clock < 1) {
    fail(`clock は 1以上の整数にしてください（${clock}）`);
  }
  return Object.freeze({
    channelCount, waveBankCount, clock,
    channelWaveBank: Object.freeze([...channelWaveBank]),
  });
}

/**
 * SCC互換の5チャンネルに、共有しないチャンネルを足した設定を作る（F-011）
 * @param {number} channelCount 5〜16
 * @returns {Readonly<SccConfig>}
 */
export function extendedConfig(channelCount) {
  const banks = [...SCC_COMPAT.channelWaveBank];
  for (let ch = banks.length; ch < channelCount; ch++) banks.push(SCC_COMPAT.waveBankCount + ch - SCC_COMPAT.channelCount);
  return validateConfig({
    channelCount,
    waveBankCount: Math.max(...banks) + 1,
    channelWaveBank: banks.slice(0, channelCount),
    clock: SCC_COMPAT.clock,
  });
}

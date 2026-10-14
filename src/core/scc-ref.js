// 基準版（F-001・F-002）。1クロックずつ、MAMEの k051649.cpp と同じ順序で計算する
// 定義は docs/scc-core-spec.md 1〜3章。この動きは変更禁止（CLAUDE.md 変更禁止事項1）
// 音を出す経路には使わない。テストと照合の専用
import { SCC_COMPAT, WAVE_LENGTH, validateConfig } from './config.js';

const WAVE_MASK = WAVE_LENGTH - 1;

/**
 * @typedef {object} ChannelState
 * @property {number} frequency 0〜4095
 * @property {number} volume 0〜15
 * @property {boolean} key
 * @property {number} counter 0〜31
 * @property {number} clock -1〜frequency
 * @property {number} sample -1920〜1905
 */

export class SccRef {
  /** @param {import('./config.js').SccConfig} [config] */
  constructor(config = SCC_COMPAT) {
    this.config = validateConfig(config);
    this.waves = new Int8Array(this.config.waveBankCount * WAVE_LENGTH);
    /** @type {ChannelState[]} */
    this.channels = [];
    for (let i = 0; i < this.config.channelCount; i++) {
      this.channels.push({ frequency: 0, volume: 0, key: false, counter: 0, clock: 0, sample: 0 });
    }
    this.reset();
  }

  /** リセット。波形メモリと sample は消さない【MAME】 */
  reset() {
    for (const ch of this.channels) {
      ch.frequency = 0;
      ch.volume = 15;
      ch.counter = 0;
      ch.clock = 0;
      ch.key = false;
    }
  }

  /** @param {number} ch @param {number} f12 */
  setFrequency(ch, f12) {
    const c = this.#channel(ch);
    c.frequency = f12 & 0xfff;
    c.clock = -1; // 次の1クロックで sample だけ読み直す
  }

  /** @param {number} ch */
  getFrequency(ch) {
    return this.#channel(ch).frequency;
  }

  /** @param {number} ch @param {number} v4 */
  setVolume(ch, v4) {
    this.#channel(ch).volume = v4 & 0xf;
  }

  /**
   * @param {number} mask ビットi がチャンネルiのキー
   * @param {number} [width] 先頭から何チャンネル分を変えるか（既定は全部）
   */
  setKey(mask, width = this.channels.length) {
    const n = Math.min(width, this.channels.length);
    for (let i = 0; i < n; i++) this.channels[i].key = ((mask >> i) & 1) === 1;
  }

  /**
   * 1チャンネルだけキーを変える（追加チャンネル用。F-011）。他のチャンネルには触れない
   * @param {number} ch @param {boolean} on
   */
  setChannelKey(ch, on) {
    this.#channel(ch).key = on;
  }

  /** @param {number} bank @param {number} index @param {number} int8 */
  writeWave(bank, index, int8) {
    this.waves[this.#waveBase(bank) + (index & WAVE_MASK)] = int8;
  }

  /** @param {number} bank @param {number} index @returns {number} -128〜127 */
  readWave(bank, index) {
    return this.waves[this.#waveBase(bank) + (index & WAVE_MASK)];
  }

  /** 1クロック進めて、そのクロックの出力（整数）を返す */
  tick() {
    const banks = this.config.channelWaveBank;
    let out = 0;
    for (let i = 0; i < this.channels.length; i++) {
      const ch = this.channels[i];
      if (ch.frequency > 8) { // 8以下は止まる【確認】
        ch.clock += 1;
        if (ch.clock > ch.frequency) {
          ch.counter = (ch.counter + 1) & WAVE_MASK;
          ch.clock = 0;
        }
        if (ch.clock === 0) {
          ch.sample = (ch.key ? this.waves[banks[i] * WAVE_LENGTH + ch.counter] : 0) * ch.volume;
        }
      }
      out += ch.sample >> 4; // 算術シフト。負の数は切り下げ【MAME】
    }
    return out;
  }

  /**
   * nクロック進めて、各クロックの出力の和（整数）を返す
   * @param {number} n
   */
  sumTicks(n) {
    let sum = 0;
    for (let k = 0; k < n; k++) sum += this.tick();
    return sum;
  }

  /** 状態の写し（テスト・表示用） */
  snapshot() {
    return {
      channels: this.channels.map((c) => ({ ...c })),
      waves: this.waves.slice(),
    };
  }

  #channel(ch) {
    const c = this.channels[ch];
    if (!Number.isInteger(ch) || c === undefined) throw new RangeError(`チャンネル番号が範囲外です：${ch}`);
    return c;
  }

  #waveBase(bank) {
    if (!Number.isInteger(bank) || bank < 0 || bank >= this.config.waveBankCount) {
      throw new RangeError(`波形バンクが範囲外です：${bank}`);
    }
    return bank * WAVE_LENGTH;
  }
}

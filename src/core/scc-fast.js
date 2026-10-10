// 高速版（F-003）。基準版と同じ結果を、音が変わる瞬間（sample の読み直し）だけ計算して出す
// 考え方は docs/scc-core-spec.md 6章。基準版との完全一致を tests/scc-fast.test.js で確かめる
import { SCC_COMPAT, WAVE_LENGTH, validateConfig } from './config.js';

const WAVE_MASK = WAVE_LENGTH - 1;

export class SccFast {
  /** @param {import('./config.js').SccConfig} [config] */
  constructor(config = SCC_COMPAT) {
    this.config = validateConfig(config);
    const n = this.config.channelCount;
    this.waves = new Int8Array(this.config.waveBankCount * WAVE_LENGTH);
    this.frequency = new Int32Array(n);
    this.volume = new Int32Array(n);
    this.key = new Uint8Array(n);
    this.counter = new Int32Array(n);
    this.clock = new Int32Array(n);
    this.sample = new Int32Array(n);
    this.waveBase = Int32Array.from(this.config.channelWaveBank, (b) => b * WAVE_LENGTH);
    this.reset();
  }

  /** リセット。波形メモリと sample は消さない【MAME】 */
  reset() {
    this.frequency.fill(0);
    this.volume.fill(15);
    this.counter.fill(0);
    this.clock.fill(0);
    this.key.fill(0);
  }

  /** @param {number} ch @param {number} f12 */
  setFrequency(ch, f12) {
    this.#check(ch);
    this.frequency[ch] = f12 & 0xfff;
    this.clock[ch] = -1;
  }

  /** @param {number} ch */
  getFrequency(ch) {
    this.#check(ch);
    return this.frequency[ch];
  }

  /** @param {number} ch @param {number} v4 */
  setVolume(ch, v4) {
    this.#check(ch);
    this.volume[ch] = v4 & 0xf;
  }

  /**
   * @param {number} mask ビットi がチャンネルiのキー
   * @param {number} [width] 先頭から何チャンネル分を変えるか（既定は全部）
   */
  setKey(mask, width = this.key.length) {
    const n = Math.min(width, this.key.length);
    for (let i = 0; i < n; i++) this.key[i] = (mask >> i) & 1;
  }

  /** @param {number} bank @param {number} index @param {number} int8 */
  writeWave(bank, index, int8) {
    this.waves[this.#bankBase(bank) + (index & WAVE_MASK)] = int8;
  }

  /** @param {number} bank @param {number} index @returns {number} */
  readWave(bank, index) {
    return this.waves[this.#bankBase(bank) + (index & WAVE_MASK)];
  }

  /** 1クロック進めて、そのクロックの出力を返す */
  tick() {
    return this.sumTicks(1);
  }

  /**
   * nクロック進めて、各クロックの出力の和（整数）を返す
   * process() から呼ぶので、オブジェクトを作らない
   * @param {number} n
   */
  sumTicks(n) {
    const { frequency, volume, key, counter, clock, sample, waves, waveBase } = this;
    let total = 0;
    for (let i = 0; i < frequency.length; i++) {
      const f = frequency[i];
      let s = sample[i];
      if (f <= 8) { // 止まっている：最後の sample を出し続ける
        total += n * (s >> 4);
        continue;
      }
      let clk = clock[i];
      let cnt = counter[i];
      let rem = n;
      // 次の読み直しまでのクロック数。clock=-1 なら次のクロックで（counter は進まない）
      let k = clk === -1 ? 1 : (clk >= f ? 1 : f - clk + 1);
      while (k <= rem) {
        total += (k - 1) * (s >> 4);
        if (clk !== -1) cnt = (cnt + 1) & WAVE_MASK;
        clk = 0;
        s = key[i] ? waves[waveBase[i] + cnt] * volume[i] : 0;
        total += s >> 4;
        rem -= k;
        k = f + 1;
      }
      total += rem * (s >> 4);
      clock[i] = clk + rem;
      counter[i] = cnt;
      sample[i] = s;
    }
    return total;
  }

  /** 状態の写し（テスト・表示用）。基準版と同じ形 */
  snapshot() {
    const channels = [];
    for (let i = 0; i < this.frequency.length; i++) {
      channels.push({
        frequency: this.frequency[i], volume: this.volume[i], key: this.key[i] === 1,
        counter: this.counter[i], clock: this.clock[i], sample: this.sample[i],
      });
    }
    return { channels, waves: this.waves.slice() };
  }

  #check(ch) {
    if (!Number.isInteger(ch) || ch < 0 || ch >= this.frequency.length) throw new RangeError(`チャンネル番号が範囲外です：${ch}`);
  }

  #bankBase(bank) {
    if (!Number.isInteger(bank) || bank < 0 || bank >= this.config.waveBankCount) {
      throw new RangeError(`波形バンクが範囲外です：${bank}`);
    }
    return bank * WAVE_LENGTH;
  }
}

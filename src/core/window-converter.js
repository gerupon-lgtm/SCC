// チップのクロック → 音声サンプルの変換（docs/scc-core-spec.md 5章）【設計】
// 1音声サンプルに入るクロック数 L を整数で配り、その区間の出力の和を平均する
// 割り算は最後の1回だけ（CLAUDE.md 変更禁止事項2）

/** MAMEと同じ、整数の出力を音の大きさへ直す分母 */
export const OUTPUT_DIVISOR = 1024;

export class WindowConverter {
  /**
   * @param {number} clock チップのクロック（Hz、整数）
   * @param {number} sampleRate 音声のサンプルレート（Hz、整数）
   */
  constructor(clock, sampleRate) {
    if (!Number.isInteger(clock) || clock < 1) throw new RangeError(`clock は1以上の整数にしてください：${clock}`);
    if (!Number.isInteger(sampleRate) || sampleRate < 1) throw new RangeError(`sampleRate は1以上の整数にしてください：${sampleRate}`);
    if (clock < sampleRate) throw new RangeError('clock は sampleRate 以上にしてください（L が0になるため）');
    this.clock = clock;
    this.sampleRate = sampleRate;
    this.acc = 0; // 常に 0 <= acc < sampleRate
  }

  /** 次の音声サンプルに入るクロック数（48,000Hzなら74か75） */
  nextL() {
    this.acc += this.clock;
    const L = Math.floor(this.acc / this.sampleRate);
    this.acc -= L * this.sampleRate;
    return L;
  }

  /**
   * チップを進めて、音声サンプルを out[from..to) に書く。オブジェクトを作らない
   * @param {{ sumTicks(n: number): number }} chip
   * @param {Float32Array} out
   * @param {number} [from]
   * @param {number} [to]
   * @param {{ sample(L: number): number } | null} [psg] PSG（F-018）。あれば同じ L で進めて足す
   */
  render(chip, out, from = 0, to = out.length, psg = null) {
    for (let i = from; i < to; i++) {
      const L = this.nextL();
      out[i] = chip.sumTicks(L) / (L * OUTPUT_DIVISOR) + (psg ? psg.sample(L) : 0);
    }
  }
}

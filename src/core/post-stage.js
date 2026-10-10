// 後処理：直流除去と音量（docs/scc-core-spec.md 4・5章）
// 基準版と高速版の両方に、同じ後処理をかける
import { SCC_COMPAT } from './config.js';

/** 音量の初期値（docs/data-model.md 4章、0.5以下：CLAUDE.md 変更禁止事項6） */
export const DEFAULT_MASTER = 0.3;

/** 直流除去の目安の周波数（Hz）【設計】 */
const DC_CUTOFF_HZ = 10;

/** 音量の変化をなめらかにする時間（秒）。急な変化での「プツッ」という音を防ぐ【設計】 */
const GAIN_SMOOTH_SEC = 0.01;

export class PostStage {
  /**
   * @param {number} sampleRate
   * @param {number} channelCount チャンネルを増やしたときの余裕（5 / チャンネル数）に使う
   */
  constructor(sampleRate, channelCount) {
    this.r = Math.exp((-2 * Math.PI * DC_CUTOFF_HZ) / sampleRate);
    this.smooth = 1 - Math.exp(-1 / (GAIN_SMOOTH_SEC * sampleRate));
    this.headroom = Math.min(1, SCC_COMPAT.channelCount / channelCount);
    this.target = DEFAULT_MASTER;
    this.gain = DEFAULT_MASTER;
    this.x1 = 0;
    this.y1 = 0;
    this.peak = 0;
  }

  /** @param {number} g 0〜1。範囲外は丸める */
  setMaster(g) {
    this.target = Number.isFinite(g) ? Math.min(1, Math.max(0, g)) : 0;
  }

  /** 状態を消す（止めて再開するとき） */
  clear() {
    this.x1 = 0;
    this.y1 = 0;
    this.gain = this.target;
    this.peak = 0;
  }

  /**
   * buf をその場で書き換える。オブジェクトを作らない
   * @param {Float32Array} buf
   */
  process(buf) {
    let { x1, y1, gain, peak } = this;
    const { r, smooth, target, headroom } = this;
    for (let i = 0; i < buf.length; i++) {
      const x = buf[i];
      const y = x - x1 + r * y1; // 1次の高域通過（直流除去）
      x1 = x;
      y1 = y;
      gain += (target - gain) * smooth;
      let v = y * gain * headroom;
      if (v > 1) v = 1; else if (v < -1) v = -1;
      buf[i] = v;
      const a = v < 0 ? -v : v;
      if (a > peak) peak = a;
    }
    this.x1 = x1; this.y1 = y1; this.gain = gain; this.peak = peak;
  }

  /** 前回の呼び出しからの最大値を返し、0に戻す（画面の表示用） */
  takePeak() {
    const p = this.peak;
    this.peak = 0;
    return p;
  }
}

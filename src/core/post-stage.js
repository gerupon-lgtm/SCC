// 後処理：直流除去と音量（docs/scc-core-spec.md 4・5章）
// 基準版と高速版の両方に、同じ後処理をかける
import { SCC_COMPAT } from './config.js';

/**
 * 音量の上限（倍率）。0.8.4 までの最大（1）の2倍にした（2026-10-17 発案者）。画面のスライダーの 100% がこれ
 * SCC 1音の最大は約 0.116 なので、単音は余裕がある。5音の和音を最大の強さで弾くと、約83%（倍率1.67）から上は 1 を超えた分が切れる（音割れ）
 */
export const MAX_MASTER = 2;

/** 画面のスライダーの初期位置（%）。2026-10-17 発案者：CLAUDE.md 変更禁止事項6 */
export const DEFAULT_SLIDER = 80;

/**
 * 画面のスライダー（0〜100%）→ 音量の倍率（0〜MAX_MASTER）
 * @param {number} percent
 */
export function sliderToGain(percent) {
  return (percent / 100) * MAX_MASTER;
}

/** 音量の初期値（倍率。スライダーの 80% ＝ 1.6。0.8.4 までの 0.3 の約5倍）docs/data-model.md 4章 */
export const DEFAULT_MASTER = sliderToGain(DEFAULT_SLIDER);

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

  /** @param {number} g 0〜MAX_MASTER。範囲外は丸める */
  setMaster(g) {
    this.target = Number.isFinite(g) ? Math.min(MAX_MASTER, Math.max(0, g)) : 0;
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

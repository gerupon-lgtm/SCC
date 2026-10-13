// 鐘の音（単音）の試作。SCCの複数チャンネルを、整数倍でない高さで重ね、音量を時間で下げる
// 使う操作は SCC のレジスタ書き込み（周波数・音量・キー・波形）だけ。DOM・Web Audio に依存しない
// 時間で音量を下げる advance() は AudioWorklet の process() から呼ぶので、オブジェクトを作らない
import { getPreset } from '../core/presets.js';

/** 鐘に使うチャンネル数（SCC互換のアドレス層が扱う5チャンネル） */
export const BELL_CHANNELS = 5;
const WAVE_REGION_COUNT = 4;

/**
 * @typedef {object} Partial 1つの部分音（1チャンネル）
 * @property {number} ratio 基準の高さに対する比（例：1.2 は短3度上）
 * @property {number} level 叩いた直後の音量 0〜15（0 なら使わない）
 * @property {number} decay 音量が 1/e（約37%）になるまでの秒数
 * @property {number} cents 高さのずらし（1/100半音）。うなりを作る
 */

/**
 * @typedef {object} BellParams
 * @property {string} wave プリセット波形の名前（全チャンネル共通）
 * @property {Partial[]} partials 最大5つ
 */

/**
 * 試作の出発点。比は鐘の音についての一般的な知識（hum 0.5・prime 1・tierce 1.2・quint 1.5・nominal 2）
 * 減衰の秒数・音量・ずらしは、耳で調整するための仮の値【想定】
 * @type {Record<string, { label: string, params: BellParams }>}
 */
export const BELL_PRESETS = {
  church: {
    label: '教会の鐘',
    params: {
      wave: 'sine',
      partials: [
        { ratio: 0.5, level: 9, decay: 5.0, cents: 0 },
        { ratio: 1.0, level: 13, decay: 3.0, cents: 0 },
        { ratio: 1.2, level: 11, decay: 2.2, cents: 0 },
        { ratio: 1.5, level: 7, decay: 1.6, cents: 0 },
        { ratio: 2.0, level: 12, decay: 1.4, cents: 4 },
      ],
    },
  },
  small: {
    label: '小さな鐘',
    params: {
      wave: 'sine',
      partials: [
        { ratio: 1.0, level: 13, decay: 1.4, cents: 0 },
        { ratio: 2.0, level: 10, decay: 1.0, cents: 3 },
        { ratio: 2.4, level: 9, decay: 0.8, cents: 0 },
        { ratio: 3.0, level: 6, decay: 0.5, cents: 0 },
        { ratio: 4.2, level: 5, decay: 0.3, cents: 0 },
      ],
    },
  },
  bar: {
    // 両端が自由な棒の振動の比（1・2.756・5.404・8.933）。鉄琴やチューブラーベルの響きに近い【一般的な知識】
    label: '鉄琴風',
    params: {
      wave: 'sine',
      partials: [
        { ratio: 1.0, level: 14, decay: 2.0, cents: 0 },
        { ratio: 2.756, level: 9, decay: 0.9, cents: 0 },
        { ratio: 5.404, level: 6, decay: 0.4, cents: 0 },
        { ratio: 8.933, level: 3, decay: 0.2, cents: 0 },
        { ratio: 1.0, level: 0, decay: 1.0, cents: 0 },
      ],
    },
  },
};

/**
 * 比とずらしを掛けた高さ（Hz）→ SCCの周波数の値（TP）。0〜4095 に丸める
 * @param {number} hz
 * @param {number} clock
 */
export function hzToPeriod(hz, clock) {
  const tp = Math.round(clock / (32 * hz)) - 1;
  return Math.min(4095, Math.max(0, tp));
}

/** @param {number} note MIDIのノート番号 */
export function noteToHz(note) {
  return 440 * 2 ** ((note - 69) / 12);
}

/**
 * 値の範囲を確かめて、写しを返す（画面やJSONから来た値をそのまま使わない）
 * @param {BellParams} p
 * @returns {BellParams}
 */
export function normalizeParams(p) {
  const num = (v, lo, hi, def) => (Number.isFinite(Number(v)) ? Math.min(hi, Math.max(lo, Number(v))) : def);
  const partials = [];
  for (let i = 0; i < BELL_CHANNELS; i++) {
    const s = p?.partials?.[i] ?? {};
    partials.push({
      ratio: num(s.ratio, 0.125, 16, 1),
      level: Math.round(num(s.level, 0, 15, 0)),
      decay: num(s.decay, 0.01, 30, 1),
      cents: num(s.cents, -100, 100, 0),
    });
  }
  return { wave: typeof p?.wave === 'string' ? p.wave : 'sine', partials };
}

export class BellVoice {
  /**
   * @param {{ write(addr: number, value: number): unknown }} regs SCCのアドレス層（SccRegisters など）
   * @param {number} clock チップのクロック
   */
  constructor(regs, clock) {
    this.regs = regs;
    this.clock = clock;
    this.level = new Float64Array(BELL_CHANNELS);
    this.decay = new Float64Array(BELL_CHANNELS);
    this.ratio = new Float64Array(BELL_CHANNELS);
    this.cents = new Float64Array(BELL_CHANNELS);
    this.current = new Int32Array(BELL_CHANNELS); // いま書いてある音量
    this.velocity = 1;
    this.time = 0;
    this.ringing = false;
    this.keyMask = 0;
    this.waveName = '';
  }

  /** @param {BellParams} params */
  setParams(params) {
    const p = normalizeParams(params);
    p.partials.forEach((s, i) => {
      this.level[i] = s.level;
      this.decay[i] = s.decay;
      this.ratio[i] = s.ratio;
      this.cents[i] = s.cents;
    });
    if (p.wave !== this.waveName) this.setWave(p.wave);
  }

  /** 全バンクに同じ波形を書く @param {string} name */
  setWave(name) {
    const wave = getPreset(name);
    this.waveName = name;
    for (let region = 0; region < WAVE_REGION_COUNT; region++) {
      for (let i = 0; i < wave.length; i++) this.regs.write(region * 32 + i, wave[i] & 0xff);
    }
  }

  /**
   * 叩く。鳴っている途中でも、最初から鳴らし直す
   * @param {number} note MIDIのノート番号（小数可）
   * @param {number} [velocity] 0〜1
   */
  strike(note, velocity = 1) {
    const base = noteToHz(note);
    this.velocity = Math.min(1, Math.max(0, velocity));
    this.time = 0;
    this.keyMask = 0;
    for (let ch = 0; ch < BELL_CHANNELS; ch++) {
      const hz = base * this.ratio[ch] * 2 ** (this.cents[ch] / 1200);
      const tp = hzToPeriod(hz, this.clock);
      const on = this.level[ch] > 0 && tp > 8; // 8以下は止まるので使わない
      this.regs.write(0x80 + ch * 2, tp & 0xff);
      this.regs.write(0x81 + ch * 2, tp >> 8);
      const v = on ? this.#volumeAt(ch, 0) : 0;
      this.current[ch] = v;
      this.regs.write(0x8a + ch, v);
      if (on && v > 0) this.keyMask |= 1 << ch;
    }
    this.regs.write(0x8f, this.keyMask);
    this.ringing = this.keyMask !== 0;
  }

  /**
   * 時間を進め、音量が変わったチャンネルだけ書く。すべて0になったらキーを切る
   * @param {number} dt 秒
   */
  advance(dt) {
    if (!this.ringing) return;
    this.time += dt;
    let mask = 0;
    for (let ch = 0; ch < BELL_CHANNELS; ch++) {
      if ((this.keyMask & (1 << ch)) === 0) continue;
      const v = this.#volumeAt(ch, this.time);
      if (v !== this.current[ch]) {
        this.current[ch] = v;
        this.regs.write(0x8a + ch, v);
      }
      if (v > 0) mask |= 1 << ch;
    }
    if (mask !== this.keyMask) {
      this.keyMask = mask;
      this.regs.write(0x8f, mask);
    }
    this.ringing = mask !== 0;
  }

  /** すぐに止める */
  stop() {
    for (let ch = 0; ch < BELL_CHANNELS; ch++) {
      this.current[ch] = 0;
      this.regs.write(0x8a + ch, 0);
    }
    this.keyMask = 0;
    this.regs.write(0x8f, 0);
    this.ringing = false;
  }

  /** 指数で減る音量を 0〜15 の整数に丸める */
  #volumeAt(ch, t) {
    return Math.round(this.level[ch] * this.velocity * Math.exp(-t / this.decay[ch]));
  }
}

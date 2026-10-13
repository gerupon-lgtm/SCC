// 鐘の音（単音）の試作。SCCの複数チャンネルを重ね、音量と波形を時間で変える
// 使う操作は SCC のレジスタ書き込み（周波数・音量・キー・波形）だけ。DOM・Web Audio に依存しない
// 時間で変える advance() は AudioWorklet の process() から呼ぶので、オブジェクトを作らない
//
// 考え方（docs/bell.md）：
// - 整数倍の音（1・2・3倍…）は、1チャンネルの波形の中の「倍音」にまとめる。1つの波形の中の倍音は必ず溶け合う
// - 整数倍でない音（鐘らしさの元）だけ、別のチャンネルにする
// - 倍音は時間とともに弱める（波形を書き換える）。高い倍音ほど早く消える
// - 全体の長さ（length）で、全チャンネルがそろって消えるようにする

/** 鐘に使うチャンネル数（SCC互換のアドレス層が扱う5チャンネル） */
export const BELL_CHANNELS = 5;
/** 1チャンネルの波形にまとめられる倍音の数 */
export const MAX_HARMONICS = 6;
const WAVE_LEN = 32;
/** チャンネル i が使う波形バンク（SCC互換：ch4とch5が共有） */
const CHANNEL_BANK = [0, 1, 2, 3, 3];
/** 波形を書き換える間隔（秒）【設計】 */
const WAVE_UPDATE_SEC = 0.02;

/**
 * @typedef {object} Partial 1チャンネル
 * @property {number} ratio 基準の高さに対する比
 * @property {number} level 叩いた直後の音量 0〜15（0 なら使わない）
 * @property {number} decay 音量が 1/e（約37%）になるまでの秒数
 * @property {number} cents 高さのずらし（1/100半音）。0以外だと、うなりが出る
 * @property {number[]} harmonics 波形の倍音の強さ（1倍・2倍・3倍…、最大6つ）。[1] なら正弦波
 * @property {number} bright 2倍の倍音が 1/e になるまでの秒数（k倍の倍音は bright/(k-1) 秒）
 */

/**
 * @typedef {object} BellParams
 * @property {number} length 全体の長さ（秒）。この時間で必ず全部消える
 * @property {Partial[]} partials 5つ。5番目の波形は4番目と同じ（SCCの仕様。normalizeParams がそろえる）
 */

const off = { ratio: 1, level: 0, decay: 1, cents: 0, harmonics: [1], bright: 1 };

/** 試作の出発点【想定】。値は耳で調整するための仮のもの @type {Record<string, { label: string, params: BellParams }>} */
export const BELL_PRESETS = {
  small: {
    label: '小さな鐘',
    params: {
      length: 2.5,
      partials: [
        // 1・2・3倍は1つの波形にまとめる。高い倍音から先に消える
        { ratio: 1.0, level: 14, decay: 0.9, cents: 0, harmonics: [1, 0.5, 0.35], bright: 0.5 },
        // 整数倍でない音だけ、別のチャンネルに
        { ratio: 2.4, level: 8, decay: 0.45, cents: 0, harmonics: [1], bright: 1 },
        { ratio: 4.2, level: 5, decay: 0.25, cents: 0, harmonics: [1], bright: 1 },
        off,
        off,
      ],
    },
  },
  church: {
    // 比は鐘の音についての一般的な知識（hum 0.5・prime 1・tierce 1.2・quint 1.5・nominal 2）
    label: '教会の鐘',
    params: {
      length: 8,
      partials: [
        { ratio: 0.5, level: 9, decay: 4.0, cents: 0, harmonics: [1, 0.6], bright: 2.0 }, // hum と prime（2倍）
        { ratio: 1.2, level: 11, decay: 2.2, cents: 0, harmonics: [1], bright: 1 },
        { ratio: 1.5, level: 7, decay: 1.6, cents: 0, harmonics: [1], bright: 1 },
        { ratio: 2.0, level: 10, decay: 1.4, cents: 0, harmonics: [1], bright: 1 },
        { ratio: 2.0, level: 0, decay: 1.4, cents: 0, harmonics: [1], bright: 1 },
      ],
    },
  },
  bar: {
    // 両端が自由な棒の振動の比（1・2.756・5.404・8.933）【一般的な知識】
    label: '鉄琴風',
    params: {
      length: 3,
      partials: [
        { ratio: 1.0, level: 14, decay: 1.2, cents: 0, harmonics: [1], bright: 1 },
        { ratio: 2.756, level: 9, decay: 0.6, cents: 0, harmonics: [1], bright: 1 },
        { ratio: 5.404, level: 6, decay: 0.3, cents: 0, harmonics: [1], bright: 1 },
        { ratio: 8.933, level: 3, decay: 0.15, cents: 0, harmonics: [1], bright: 1 },
        { ratio: 8.933, level: 0, decay: 0.15, cents: 0, harmonics: [1], bright: 1 },
      ],
    },
  },
};

/**
 * 高さ（Hz）→ SCCの周波数の値（TP）。0〜4095 に丸める
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
 * @param {any} p
 * @returns {BellParams}
 */
export function normalizeParams(p) {
  const num = (v, lo, hi, def) => (v !== null && v !== '' && Number.isFinite(Number(v)) ? Math.min(hi, Math.max(lo, Number(v))) : def);
  const partials = [];
  for (let i = 0; i < BELL_CHANNELS; i++) {
    const s = p?.partials?.[i] ?? {};
    let harmonics = Array.isArray(s.harmonics) ? s.harmonics.slice(0, MAX_HARMONICS).map((h) => num(h, 0, 1, 0)) : [1];
    if (!harmonics.some((h) => h > 0)) harmonics = [1];
    partials.push({
      ratio: num(s.ratio, 0.125, 16, 1),
      level: Math.round(num(s.level, 0, 15, 0)),
      decay: num(s.decay, 0.01, 30, 1),
      cents: num(s.cents, -100, 100, 0),
      harmonics,
      bright: num(s.bright, 0.01, 30, 1),
    });
  }
  // ch4とch5は同じ波形バンクを読む（SCCの仕様）。5番目の波形は4番目にそろえる
  partials[4].harmonics = [...partials[3].harmonics];
  partials[4].bright = partials[3].bright;
  return { length: num(p?.length, 0.1, 30, 3), partials };
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
    this.bright = new Float64Array(BELL_CHANNELS);
    this.harm = new Float64Array(BELL_CHANNELS * MAX_HARMONICS);
    this.harmSum = new Float64Array(BELL_CHANNELS); // 波形が ±127 を超えないための分母
    this.morphs = new Uint8Array(BELL_CHANNELS);    // 2倍以上の倍音がある（波形を書き換える）
    this.current = new Int32Array(BELL_CHANNELS);   // いま書いてある音量
    this.sinTable = new Float64Array(MAX_HARMONICS * WAVE_LEN);
    for (let k = 0; k < MAX_HARMONICS; k++) {
      for (let i = 0; i < WAVE_LEN; i++) this.sinTable[k * WAVE_LEN + i] = Math.sin((2 * Math.PI * (k + 1) * i) / WAVE_LEN);
    }
    this.length = 3;
    this.velocity = 1;
    this.time = 0;
    this.nextWaveTime = 0;
    this.ringing = false;
    this.keyMask = 0;
  }

  /** @param {BellParams} params */
  setParams(params) {
    const p = normalizeParams(params);
    this.length = p.length;
    this.harm.fill(0);
    p.partials.forEach((s, ch) => {
      this.level[ch] = s.level;
      this.decay[ch] = s.decay;
      this.ratio[ch] = s.ratio;
      this.cents[ch] = s.cents;
      this.bright[ch] = s.bright;
      let sum = 0;
      s.harmonics.forEach((h, k) => { this.harm[ch * MAX_HARMONICS + k] = h; sum += h; });
      this.harmSum[ch] = sum;
      this.morphs[ch] = s.harmonics.some((h, k) => k > 0 && h > 0) ? 1 : 0;
    });
    for (let ch = 0; ch < BELL_CHANNELS; ch++) this.#writeWave(ch, this.ringing ? this.time : 0);
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
    this.nextWaveTime = WAVE_UPDATE_SEC;
    this.keyMask = 0;
    for (let ch = 0; ch < BELL_CHANNELS; ch++) this.#writeWave(ch, 0);
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
   * 時間を進める。音量が変わったチャンネルだけ書き、倍音のある波形は一定の間隔で書き換える
   * すべて0になったら（遅くとも length 秒で）キーを切る
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
    if (this.time >= this.nextWaveTime) {
      this.nextWaveTime += WAVE_UPDATE_SEC;
      for (let ch = 0; ch < BELL_CHANNELS; ch++) {
        // ch4（番号4）の波形は ch3 のバンクを読むので、ch3 が書く
        if (this.morphs[ch] && CHANNEL_BANK[ch] === ch && (mask & ((1 << ch) | (ch === 3 ? 1 << 4 : 0)))) this.#writeWave(ch, this.time);
      }
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

  /**
   * 指数で減る音量に、終わりで0へなめらかに下げる窓（1 - (t/length)^4）を掛け、0〜15 の整数に丸める
   */
  #volumeAt(ch, t) {
    if (t >= this.length) return 0;
    const x = t / this.length;
    const win = 1 - x * x * x * x;
    return Math.round(this.level[ch] * this.velocity * Math.exp(-t / this.decay[ch]) * win);
  }

  /** 時刻 t の倍音の強さで、チャンネルの波形を作って書く（ch4 は ch3 と同じバンクなので書かない） */
  #writeWave(ch, t) {
    if (CHANNEL_BANK[ch] !== ch) return;
    const base = ch * MAX_HARMONICS;
    const norm = this.harmSum[ch] > 0 ? 127 / this.harmSum[ch] : 0;
    for (let i = 0; i < WAVE_LEN; i++) {
      let s = 0;
      for (let k = 0; k < MAX_HARMONICS; k++) {
        const h = this.harm[base + k];
        if (h === 0) continue;
        const g = k === 0 ? 1 : Math.exp((-t * k) / this.bright[ch]);
        s += h * g * this.sinTable[k * WAVE_LEN + i];
      }
      this.regs.write(CHANNEL_BANK[ch] * WAVE_LEN + i, Math.round(s * norm) & 0xff);
    }
  }
}

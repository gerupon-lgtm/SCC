// 鐘の音（単音）の試作。SCCの複数チャンネルを重ね、音量と波形を時間で変える
// 使う操作は SCC のレジスタ書き込み（周波数・音量・キー・波形）だけ。DOM・Web Audio に依存しない
// 時間で変える advance() は AudioWorklet の process() から呼ぶので、オブジェクトを作らない
//
// 考え方（docs/bell.md）：
// - 整数倍の音（1・2・3倍…）は、1チャンネルの波形の中の「倍音」にまとめる。1つの波形の中の倍音は必ず溶け合う
// - 整数倍でない音（鐘らしさの元）だけ、別のチャンネルにする
// - 倍音は時間とともに弱める（波形を書き換える）。高い倍音ほど早く消える
// - 全体の長さ（length）で、全チャンネルがそろって消えるようにする
// - 音の大きさは、音量レジスター（16段階）と波形の振れ幅（-127〜127）の掛け算で細かく下げる。
//   音量だけで下げると、終わりの 3→2→1→0 の段差で「このチャンネルが消えた」と分かってしまうため

/** 鐘に使うチャンネル数（SCC互換のアドレス層が扱う5チャンネル） */
export const BELL_CHANNELS = 5;
/** 1チャンネルの波形にまとめられる倍音の数 */
export const MAX_HARMONICS = 6;
const WAVE_LEN = 32;
/** チャンネル i が使う波形バンク（SCC互換：ch4とch5が共有） */
const CHANNEL_BANK = [0, 1, 2, 3, 3];
const WAVE_BANKS = 4;
/** 波形と音量をそろえて書き換える間隔（秒）【設計】 */
const WAVE_UPDATE_SEC = 0.01;
/** 波形の振れ幅の最大（符号付き8ビット） */
const WAVE_PEAK = 127;

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
        // 打撃音（0.1.8〜）：叩いた瞬間の「カン」。とても高い音を一瞬だけ鳴らす
        { ratio: 6.3, level: 10, decay: 0.035, cents: 0, harmonics: [1], bright: 1 },
        { ratio: 9.1, level: 8, decay: 0.025, cents: 0, harmonics: [1], bright: 1 },
      ],
    },
  },
  church: {
    // 比は鐘の音についての一般的な知識（hum 0.5・prime 1・tierce 1.2・quint 1.5・nominal 2）
    // 発案者の希望で、3秒以内に消える長さにしている（本物の教会の鐘はもっと長く響く）
    label: '教会の鐘',
    params: {
      length: 2.9,
      partials: [
        { ratio: 0.5, level: 11, decay: 1.6, cents: 0, harmonics: [1, 0.7], bright: 1.0 }, // hum と prime（2倍）
        { ratio: 1.2, level: 11, decay: 1.0, cents: 0, harmonics: [1], bright: 1 },        // tierce（短3度）
        { ratio: 1.5, level: 6, decay: 0.8, cents: 0, harmonics: [1], bright: 1 },         // quint
        { ratio: 2.0, level: 10, decay: 0.6, cents: 0, harmonics: [1], bright: 1 },        // nominal
        // 打撃音（0.1.8〜）：叩いた瞬間の「カン」。波形は nominal と共有（正弦波）
        { ratio: 5.4, level: 10, decay: 0.045, cents: 0, harmonics: [1], bright: 1 },
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
    this.active = new Uint8Array(BELL_CHANNELS);    // 叩いたときに鳴らし始めたチャンネル
    this.amp = new Float64Array(BELL_CHANNELS);      // 計算した大きさ（0〜15 の小数）
    this.current = new Int32Array(BELL_CHANNELS);   // いま書いてある音量
    this.sinTable = new Float64Array(MAX_HARMONICS * WAVE_LEN);
    for (let k = 0; k < MAX_HARMONICS; k++) {
      for (let i = 0; i < WAVE_LEN; i++) this.sinTable[k * WAVE_LEN + i] = Math.sin((2 * Math.PI * (k + 1) * i) / WAVE_LEN);
    }
    this.length = 3;
    this.velocity = 1;
    this.time = 0;
    this.nextUpdate = 0;
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
    });
    if (!this.ringing) for (let ch = 0; ch < BELL_CHANNELS; ch++) if (CHANNEL_BANK[ch] === ch) this.#writeWave(ch, ch, 0, 1);
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
    this.nextUpdate = WAVE_UPDATE_SEC;
    this.keyMask = 0;
    this.active.fill(0);
    for (let ch = 0; ch < BELL_CHANNELS; ch++) {
      const hz = base * this.ratio[ch] * 2 ** (this.cents[ch] / 1200);
      const tp = hzToPeriod(hz, this.clock);
      this.active[ch] = this.level[ch] > 0 && tp > 8 ? 1 : 0; // 8以下は止まるので使わない
      this.regs.write(0x80 + ch * 2, tp & 0xff);
      this.regs.write(0x81 + ch * 2, tp >> 8);
    }
    this.#update(true);
    this.ringing = this.keyMask !== 0;
  }

  /**
   * 時間を進める。波形と音量を WAVE_UPDATE_SEC ごとにそろえて書く。
   * すべて0になったら（遅くとも length 秒で）キーを切る
   * @param {number} dt 秒
   */
  advance(dt) {
    if (!this.ringing) return;
    this.time += dt;
    const tick = this.time >= this.nextUpdate;
    if (tick) this.nextUpdate += WAVE_UPDATE_SEC;
    this.#update(tick);
    this.ringing = this.keyMask !== 0;
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
   * 波形バンクごとに、波形の振れ幅と各チャンネルの音量を決めて書く
   * - バンクを使うチャンネルの中で一番大きいものに合わせ、音量は「その大きさ以上で一番小さい段」、
   *   残りを波形の振れ幅で作る
   * - 同じバンクを使うもう1つのチャンネル（ch4とch5）は、同じ振れ幅のまま音量の段で合わせる
   * @param {boolean} tick 書き換える時刻か（叩いた瞬間も含む）
   */
  #update(tick) {
    if (!tick) return;
    const t = this.time;
    let mask = 0;
    for (let bank = 0; bank < WAVE_BANKS; bank++) {
      let maxA = 0;
      let writer = -1;
      for (let ch = 0; ch < BELL_CHANNELS; ch++) {
        if (CHANNEL_BANK[ch] !== bank || !this.active[ch]) continue;
        if (t > 0 && (this.keyMask & (1 << ch)) === 0) continue; // 鳴り終わったチャンネル
        const a = this.#amplitudeAt(ch, t);
        this.amp[ch] = a;
        if (writer === -1) writer = ch;
        if (a > maxA) maxA = a;
      }
      if (writer === -1) continue;
      const top = maxA * WAVE_PEAK < 0.5 ? 0 : Math.min(15, Math.ceil(maxA - 1e-9));
      const scale = top > 0 ? maxA / top : 0;
      this.#writeWave(bank, writer, t, scale);
      for (let ch = 0; ch < BELL_CHANNELS; ch++) {
        if (CHANNEL_BANK[ch] !== bank || !this.active[ch]) continue;
        if (t > 0 && (this.keyMask & (1 << ch)) === 0) continue;
        const v = top > 0 ? Math.min(15, Math.round(this.amp[ch] / scale)) : 0;
        if (v !== this.current[ch] || t === 0) {
          this.current[ch] = v;
          this.regs.write(0x8a + ch, v);
        }
        if (v > 0) mask |= 1 << ch;
      }
    }
    if (t === 0) {
      for (let ch = 0; ch < BELL_CHANNELS; ch++) {
        if (!this.active[ch]) { this.current[ch] = 0; this.regs.write(0x8a + ch, 0); }
      }
    }
    if (mask !== this.keyMask || t === 0) {
      this.keyMask = mask;
      this.regs.write(0x8f, mask);
    }
  }

  /** 指数で減る大きさに、終わりで0へなめらかに下げる窓（1 - (t/length)^4）を掛ける。0〜15 の小数 */
  #amplitudeAt(ch, t) {
    if (t >= this.length) return 0;
    const x = t / this.length;
    return this.level[ch] * this.velocity * Math.exp(-t / this.decay[ch]) * (1 - x * x * x * x);
  }

  /**
   * 時刻 t の倍音の強さ × 振れ幅 scale で波形を作り、バンクに書く
   * @param {number} bank 書く波形バンク
   * @param {number} ch 倍音の設定を使うチャンネル
   */
  #writeWave(bank, ch, t, scale) {
    const base = ch * MAX_HARMONICS;
    const norm = this.harmSum[ch] > 0 ? (WAVE_PEAK * scale) / this.harmSum[ch] : 0;
    for (let i = 0; i < WAVE_LEN; i++) {
      let s = 0;
      for (let k = 0; k < MAX_HARMONICS; k++) {
        const h = this.harm[base + k];
        if (h === 0) continue;
        const g = k === 0 ? 1 : Math.exp((-t * k) / this.bright[ch]);
        s += h * g * this.sinTable[k * WAVE_LEN + i];
      }
      this.regs.write(bank * WAVE_LEN + i, Math.round(s * norm) & 0xff);
    }
  }
}

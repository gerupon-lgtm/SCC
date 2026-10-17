// PSG の擬似ドラムセット（F-019、T-111）。MIDI チャンネル10 のノートで、PSG（AY-3-8910）の3チャンネルを鳴らす
// 実機の MSX のゲーム音楽と同じく、音程の下がる矩形波（バスドラム・タム）と、ノイズ（スネア・ハイハット・シンバル）で作る
// DOM・Web Audio を使わない（Worklet の中で動く）。tick() の中ではオブジェクトを作らない（CLAUDE.md 変更禁止事項5）
//
// Worklet への伝え方は、レジスタ書き込みと同じ仕組みを使う【設計】（時刻つきの先渡しがそのまま使えるため）
//   DRUM_ADDR + ノート番号 ← ベロシティ（1〜127）：鳴らす
//   DRUM_STOP_ADDR          ← 何でも：全部止める
// 決めごと（このアプリだけ。本物の SCC には無い）
//   - 3チャンネルを使い回す。足りなければ一番古い音を止める
//   - ノイズの高さ（レジスタ6）は3チャンネルで1つなので、最後に鳴らした音のものになる
//   - キーの配置は GM（General MIDI）の打楽器の表（35〜81）のとおり。音色は11種で、GM の音にいちばん近いものを当てる
//   - 止め合う組（GM の慣例）：ハイハット3つ、ホイッスル2つ、ギロ2つ、クイーカ2つ。組の中の音を鳴らすと、同じ組の鳴っている音を止める

export const DRUM_ADDR = 0x400;
export const DRUM_STOP_ADDR = 0x480;

/** PSG のクロック（MSX：3579545÷2） */
const PSG_CLOCK = 3579545 / 2;
const VOICES = 3;
/** 音のない区切り（ミキサーの値の上位2ビット：MSX の入出力ポートの向き） */
const MIXER_IO = 0x80;

/**
 * 音色：時間 t（秒）の音量・音程・ノイズを、数のまとまりで決める【想定：耳で調整する】
 * len 長さ、vol 最初の音量（0〜15）、decay 音量が0になるまでの秒数（音量の段階で直線に下げる）
 * f0→f1 音程（Hz、0 は音程なし）、sweep その下がり方の秒数、toneLen 音程を鳴らす秒数
 * noise ノイズの高さ（1〜31、0 はノイズなし）、noiseLen ノイズを鳴らす秒数
 * @typedef {{ len: number, vol: number, decay: number, f0: number, f1: number, sweep: number, toneLen: number, noise: number, noiseLen: number }} DrumSound
 */
/** @param {Partial<DrumSound>} s @returns {Readonly<DrumSound>} */
const sound = (s) => Object.freeze({ len: 0.2, vol: 15, decay: 0.2, f0: 0, f1: 0, sweep: 0.05, toneLen: 0, noise: 0, noiseLen: 0, ...s });

const KICK = sound({ len: 0.25, decay: 0.24, f0: 170, f1: 45, sweep: 0.045, toneLen: 0.25, noise: 12, noiseLen: 0.008 });
const SNARE = sound({ len: 0.2, decay: 0.19, f0: 240, f1: 180, sweep: 0.03, toneLen: 0.035, noise: 5, noiseLen: 0.2 });
const RIM = sound({ len: 0.04, vol: 13, decay: 0.04, f0: 900, f1: 800, toneLen: 0.04, noise: 3, noiseLen: 0.01 });
const CLAP = sound({ len: 0.15, vol: 14, decay: 0.15, noise: 3, noiseLen: 0.15 });
const HAT_CLOSED = sound({ len: 0.05, vol: 12, decay: 0.05, noise: 1, noiseLen: 0.05 });
const HAT_PEDAL = sound({ len: 0.04, vol: 10, decay: 0.04, noise: 1, noiseLen: 0.04 });
const HAT_OPEN = sound({ len: 0.35, vol: 12, decay: 0.35, noise: 1, noiseLen: 0.35 });
const CRASH = sound({ len: 1.0, vol: 14, decay: 1.0, noise: 2, noiseLen: 1.0 });
const RIDE = sound({ len: 0.5, vol: 11, decay: 0.5, noise: 1, noiseLen: 0.5 });
const TAMB = sound({ len: 0.12, vol: 11, decay: 0.12, noise: 1, noiseLen: 0.12 });
const COWBELL = sound({ len: 0.18, vol: 13, decay: 0.2, f0: 560, f1: 545, toneLen: 0.18 });
/** @param {number} hz */
const tom = (hz) => sound({ len: 0.3, decay: 0.28, f0: hz, f1: hz * 0.6, sweep: 0.12, toneLen: 0.3, noise: 10, noiseLen: 0.006 });
// タム6つ（低い順）。ボンゴ・コンガ・ティンバレス・クイーカにも使う
const TOM1 = tom(85), TOM2 = tom(105), TOM3 = tom(125), TOM4 = tom(150), TOM5 = tom(180), TOM6 = tom(215);

/**
 * GM の打楽器の配置（ノート番号 → 音色）。35〜81 のすべてのキーに、今ある音色のうち近いものを当てる【想定：耳で調整する】
 * 表に無いノート（34 以下・82 以上）は鳴らさない
 */
export const DRUM_MAP = Object.freeze({
  35: KICK,      // Acoustic Bass Drum
  36: KICK,      // Bass Drum 1
  37: RIM,       // Side Stick
  38: SNARE,     // Acoustic Snare
  39: CLAP,      // Hand Clap
  40: SNARE,     // Electric Snare
  41: TOM1,      // Low Floor Tom
  42: HAT_CLOSED, // Closed Hi-Hat
  43: TOM2,      // High Floor Tom
  44: HAT_PEDAL, // Pedal Hi-Hat
  45: TOM3,      // Low Tom
  46: HAT_OPEN,  // Open Hi-Hat
  47: TOM4,      // Low-Mid Tom
  48: TOM5,      // Hi-Mid Tom
  49: CRASH,     // Crash Cymbal 1
  50: TOM6,      // High Tom
  51: RIDE,      // Ride Cymbal 1
  52: CRASH,     // Chinese Cymbal
  53: RIDE,      // Ride Bell
  54: TAMB,      // Tambourine
  55: CRASH,     // Splash Cymbal
  56: COWBELL,   // Cowbell
  57: CRASH,     // Crash Cymbal 2
  58: TAMB,      // Vibraslap（揺れる音の代わりに、短いノイズ）
  59: RIDE,      // Ride Cymbal 2
  60: TOM6,      // Hi Bongo
  61: TOM5,      // Low Bongo
  62: TOM5,      // Mute Hi Conga
  63: TOM5,      // Open Hi Conga
  64: TOM4,      // Low Conga
  65: TOM6,      // High Timbale
  66: TOM4,      // Low Timbale
  67: COWBELL,   // High Agogo
  68: COWBELL,   // Low Agogo
  69: TAMB,      // Cabasa
  70: TAMB,      // Maracas
  71: COWBELL,   // Short Whistle（音程のある音の代わり）
  72: COWBELL,   // Long Whistle
  73: TAMB,      // Short Guiro
  74: TAMB,      // Long Guiro
  75: RIM,       // Claves
  76: RIM,       // Hi Wood Block
  77: RIM,       // Low Wood Block
  78: TOM6,      // Mute Cuica
  79: TOM5,      // Open Cuica
  80: COWBELL,   // Mute Triangle
  81: RIDE,      // Open Triangle
});

/** 止め合う組（ノート番号 → 組の番号）。0 は組なし */
const EXCLUSIVE = new Uint8Array(128);
for (const [group, notes] of [[1, [42, 44, 46]], [2, [71, 72]], [3, [73, 74]], [4, [78, 79]]]) {
  for (const n of notes) EXCLUSIVE[n] = group;
}

export class PsgDrums {
  /** @param {{ writeReg(r: number, v: number): void }} psg */
  constructor(psg) {
    this.psg = psg;
    /** @type {(Readonly<DrumSound> | null)[]} */
    this.sounds = new Array(VOICES).fill(null);
    this.notes = new Int16Array(VOICES).fill(-1);
    this.time = new Float64Array(VOICES);
    this.atten = new Uint8Array(VOICES); // ベロシティによる音量の下げ幅（段階）
    this.order = new Float64Array(VOICES); // 鳴らした順
    this.seq = 0;
    this.cache = new Int16Array(14).fill(-1); // 同じ値は書かない
    this.active = false; // 一度でも鳴らしたか（PSG を音にするか）
  }

  /**
   * @param {number} note
   * @param {number} velocity 1〜127
   * @returns {boolean} 鳴らしたか
   */
  trigger(note, velocity) {
    const s = DRUM_MAP[note];
    if (!s || velocity <= 0) return false;
    const group = EXCLUSIVE[note];
    if (group !== 0) {
      for (let i = 0; i < VOICES; i++) {
        const n = this.notes[i];
        if (n !== -1 && n !== note && EXCLUSIVE[n] === group) this.#stopVoice(i);
      }
    }
    let v = this.notes.indexOf(note); // 同じ音は同じチャンネルで鳴らし直す
    if (v === -1) v = this.sounds.indexOf(null);
    if (v === -1) { v = 0; for (let i = 1; i < VOICES; i++) if (this.order[i] < this.order[v]) v = i; }
    this.sounds[v] = s;
    this.notes[v] = note;
    this.time[v] = 0;
    // PSG の音量は1段階で約3dB【想定】。ベロシティが半分（-6dB）なら2段階下げる
    this.atten[v] = Math.min(15, Math.round(Math.log2(127 / Math.min(127, velocity)) * 2));
    this.order[v] = this.seq++;
    if (s.noise > 0) this.#reg(6, s.noise);
    this.active = true;
    this.#apply(v);
    this.#writeMixer();
    return true;
  }

  /**
   * 時間を進め、レジスタを書く。オブジェクトを作らない
   * @param {number} dt 秒
   */
  tick(dt) {
    let changed = false;
    for (let v = 0; v < VOICES; v++) {
      const s = this.sounds[v];
      if (s === null) continue;
      const t = (this.time[v] += dt);
      const toneWas = t - dt < s.toneLen, noiseWas = t - dt < s.noiseLen;
      if (t >= s.len) { this.sounds[v] = null; this.notes[v] = -1; changed = true; }
      else if (toneWas !== t < s.toneLen || noiseWas !== t < s.noiseLen) changed = true;
      this.#apply(v);
    }
    if (changed) this.#writeMixer();
  }

  stopAll() {
    this.sounds.fill(null);
    this.notes.fill(-1);
    for (let v = 0; v < VOICES; v++) this.#apply(v);
    this.#writeMixer();
  }

  /** PSG を初めの状態に戻したとき（曲の再生の前後）。書いた値の記憶も捨てる */
  reset() {
    this.sounds.fill(null);
    this.notes.fill(-1);
    this.cache.fill(-1);
    this.active = false;
  }

  #stopVoice(v) {
    this.sounds[v] = null;
    this.notes[v] = -1;
    this.#apply(v);
  }

  /** チャンネル v の音量・音程を書く */
  #apply(v) {
    const s = this.sounds[v];
    if (s === null) { this.#reg(8 + v, 0); return; }
    const t = this.time[v];
    // 音程もノイズも止めたチャンネルは一定の値（直流）を出すので、そのときは音量を0にする
    if (t >= s.toneLen && t >= s.noiseLen) { this.#reg(8 + v, 0); return; }
    const env = s.vol * Math.max(0, 1 - t / s.decay);
    this.#reg(8 + v, Math.max(0, Math.round(env) - this.atten[v]));
    if (s.f0 > 0) {
      const f = s.f1 + (s.f0 - s.f1) * Math.exp(-t / s.sweep);
      const tp = Math.min(4095, Math.max(1, Math.round(PSG_CLOCK / (16 * f))));
      this.#reg(v * 2, tp & 0xff);
      this.#reg(v * 2 + 1, tp >> 8);
    }
  }

  /** ミキサー（レジスタ7）：ビットが1なら止める。下位3ビットが音程、次の3ビットがノイズ */
  #writeMixer() {
    let m = MIXER_IO | 0x3f;
    for (let v = 0; v < VOICES; v++) {
      const s = this.sounds[v];
      if (s === null) continue;
      const t = this.time[v];
      if (t < s.toneLen) m &= ~(1 << v);
      if (t < s.noiseLen) m &= ~(8 << v);
    }
    this.#reg(7, m);
  }

  #reg(r, value) {
    if (this.cache[r] === value) return;
    this.cache[r] = value;
    this.psg.writeReg(r, value);
  }
}

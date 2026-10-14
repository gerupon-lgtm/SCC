// PSG（AY-3-8910、MSX と同じ仕様）の基準版（F-018、T-110）
// MAME の ay8910.cpp（BSD-3-Clause、Couriersud）の動きにそろえる。1回の計算（tick）は PSG のクロックの8周期ぶん
// MSX の PSG のクロックは 3,579,545 ÷ 2 Hz なので、1 tick は SCC のクロックの16周期ぶん（MAME の msx.cpp）
// 出力は MAME の「3チャンネルを1本にまとめる」方式（AY8910_SINGLE_OUTPUT）。音量の段階→電圧は抵抗の模型で作る表
// DOM・Web Audio を使わない（C-2）

/** SCC のクロック何周期で PSG の1 tick か */
export const SCC_CLOCKS_PER_PSG_TICK = 16;

/** 抵抗の模型（MAME ay8910.cpp の ay8910_param：Matthew Westcott の実測をもとにした値） */
const AY_R_UP = 800000;
const AY_R_DOWN = 8000000;
const AY_RES = [15950, 15350, 15090, 14760, 14275, 13620, 12890, 11370,
  10600, 8590, 7190, 5985, 4820, 3945, 3017, 2345];
/** 負荷抵抗（MAME の初期値 1000Ω） */
const AY_LOAD = 1000;

/**
 * 出力の表を作る（MAME の build_3D_table と同じ計算。normalize なし、zero_is_off あり）
 * 添字 = (エンベロープを使うチャンネルのビット e << 12) | (C の段階 << 8) | (B << 4) | A
 * 値は MAME と同じく32ビット浮動小数点に丸める
 */
function buildTable() {
  const tab = new Float32Array(8 * 16 * 16 * 16);
  for (let e = 0; e < 8; e++) {
    for (let j1 = 0; j1 < 16; j1++) {
      for (let j2 = 0; j2 < 16; j2++) {
        for (let j3 = 0; j3 < 16; j3++) {
          let n = (j1 !== 0 || (e & 1)) ? 1 : 0;
          n += (j2 !== 0 || (e & 2)) ? 1 : 0;
          n += (j3 !== 0 || (e & 4)) ? 1 : 0;
          let rt = n / AY_R_UP + 3.0 / AY_R_DOWN + 1.0 / AY_LOAD;
          let rw = n / AY_R_UP;
          rw += 1.0 / AY_RES[j1]; rt += 1.0 / AY_RES[j1];
          rw += 1.0 / AY_RES[j2]; rt += 1.0 / AY_RES[j2];
          rw += 1.0 / AY_RES[j3]; rt += 1.0 / AY_RES[j3];
          tab[(e << 12) | (j3 << 8) | (j2 << 4) | j1] = rw / rt;
        }
      }
    }
  }
  return tab;
}

/** 出力の表（全チャンネル共通、一度だけ作る） */
export const PSG_TABLE = buildTable();

const READ_MASK = Uint8Array.of(0xff, 0x0f, 0xff, 0x0f, 0xff, 0x0f, 0x1f, 0xff, 0x1f, 0x1f, 0x1f, 0xff, 0xff, 0x0f, 0xff, 0xff);
const ENV_STEP_MASK = 0x0f; // AY-3-8910 のエンベロープは16段階
const ENV_STEP = 2;         // AY-3-8910 はエンベロープを YM2149 の半分の速さで進める（MAME の m_step）

export class PsgRef {
  constructor() {
    this.regs = new Uint8Array(16);
    this.tonePeriod = new Int32Array(3);
    this.toneVolume = new Uint8Array(3);
    this.toneCount = new Int32Array(3);
    this.toneDuty = new Uint8Array(3);
    this.toneOutput = new Uint8Array(3);
    this.volEnabled = new Uint8Array(3);
    this.reset();
  }

  /** MAME の ay8910_reset_ym と同じ */
  reset() {
    this.active = false;
    this.latch = 0;
    this.rng = 1;
    this.tonePeriod.fill(0); this.toneVolume.fill(0); this.toneCount.fill(0);
    this.toneDuty.fill(0); this.toneOutput.fill(0); this.volEnabled.fill(0);
    this.envPeriod = 0; this.envCount = 0; this.envStep = 0; this.envVolume = 0;
    this.envHold = 0; this.envAlternate = 0; this.envAttack = 0; this.envHolding = 0;
    this.countNoise = 0;
    this.prescaleNoise = 0;
    for (let r = 0; r < 14; r++) this.writeReg(r, 0);
  }

  /** @param {number} r 0〜15 @param {number} v 0〜255 */
  writeReg(r, v) {
    r &= 0x0f;
    v &= 0xff;
    this.regs[r] = v;
    switch (r) {
      case 0: case 1: this.tonePeriod[0] = this.regs[0] | ((this.regs[1] & 0x0f) << 8); break;
      case 2: case 3: this.tonePeriod[1] = this.regs[2] | ((this.regs[3] & 0x0f) << 8); break;
      case 4: case 5: this.tonePeriod[2] = this.regs[4] | ((this.regs[5] & 0x0f) << 8); break;
      case 8: case 9: case 10: this.toneVolume[r - 8] = v; break;
      case 11: case 12: this.envPeriod = this.regs[11] | (this.regs[12] << 8); break;
      case 13: { // エンベロープの形（MAME の set_shape）
        this.envAttack = (v & 0x04) ? ENV_STEP_MASK : 0;
        if ((v & 0x08) === 0) { this.envHold = 1; this.envAlternate = this.envAttack; } else { this.envHold = v & 0x01; this.envAlternate = v & 0x02; }
        this.envStep = ENV_STEP_MASK;
        this.envHolding = 0;
        this.envVolume = this.envStep ^ this.envAttack;
        break;
      }
      default: break; // 6 ノイズ周期、7 有効、14・15 入出力ポートは値を持つだけ
    }
  }

  /** 読み出し。AY-3-8910 では、使わないビットは0で読める（MAME の ay8910_read_ym、実機で確認済みとの記述） */
  readReg(r) { return this.regs[r & 0x0f] & READ_MASK[r & 0x0f]; }

  // ---- MSX の I/O ポートと同じ使い方（0xA0：アドレス、0xA1：データ、0xA2：読み出し） ----
  /** @param {number} v 上位4ビットが0でないと、以後の書き込み・読み出しは無効（MAME の m_active） */
  writeAddress(v) {
    this.active = ((v & 0xff) >> 4) === 0;
    if (this.active) this.latch = v & 0x0f;
  }
  /** @param {number} v */
  writeData(v) { if (this.active) this.writeReg(this.latch, v); }
  readData() { return this.active ? this.readReg(this.latch) : 0xff; }

  /**
   * 1 tick 進めて、出力の表の添字を返す（MAME の sound_stream_update の1サンプルぶんと mix_3D）
   * @returns {number}
   */
  tick() {
    const regs = this.regs;
    for (let ch = 0; ch < 3; ch++) {
      const period = this.tonePeriod[ch] < 1 ? 1 : this.tonePeriod[ch];
      this.toneCount[ch] += 1;
      while (this.toneCount[ch] >= period) {
        this.toneDuty[ch] = (this.toneDuty[ch] - 1) & 0x1f;
        this.toneOutput[ch] = this.toneDuty[ch] & 1;
        this.toneCount[ch] -= period;
      }
    }
    if (++this.countNoise >= (regs[6] & 0x1f)) {
      this.countNoise = 0;
      this.prescaleNoise ^= 1;
      if (!this.prescaleNoise) {
        // 17ビットのシフトレジスタ。入力は bit0 XOR bit3（MAME、AY-3-8910 と YM2149 で確認済みとの記述）
        this.rng = (this.rng >>> 1) | (((this.rng & 1) ^ ((this.rng >>> 3) & 1)) << 16);
      }
    }
    const enable = regs[7];
    const noiseOut = this.rng & 1;
    for (let ch = 0; ch < 3; ch++) {
      this.volEnabled[ch] = (this.toneOutput[ch] | ((enable >> ch) & 1)) & (noiseOut | ((enable >> (3 + ch)) & 1));
    }
    // エンベロープ（AY は1つ）
    if (this.envHolding === 0) {
      if (++this.envCount >= this.envPeriod * ENV_STEP) {
        this.envCount = 0;
        this.envStep--;
        if (this.envStep < 0) {
          if (this.envHold) {
            if (this.envAlternate) this.envAttack ^= ENV_STEP_MASK;
            this.envHolding = 1;
            this.envStep = 0;
          } else {
            if (this.envAlternate && (this.envStep & (ENV_STEP_MASK + 1))) this.envAttack ^= ENV_STEP_MASK;
            this.envStep &= ENV_STEP_MASK;
          }
        }
      }
    }
    this.envVolume = this.envStep ^ this.envAttack;
    // 出力の表の添字（MAME の mix_3D）
    let idx = 0;
    for (let ch = 0; ch < 3; ch++) {
      const vol = this.toneVolume[ch];
      if (vol & 0x10) idx |= (1 << (12 + ch)) | (this.volEnabled[ch] ? this.envVolume << (ch * 4) : 0);
      else idx |= this.volEnabled[ch] ? (vol & 0x0f) << (ch * 4) : 0;
    }
    return idx;
  }

  /**
   * n tick 進めて、出力の値の和を返す
   * @param {number} n
   */
  sumTicks(n) {
    let s = 0;
    for (let i = 0; i < n; i++) s += PSG_TABLE[this.tick()];
    return s;
  }

  snapshot() {
    return {
      regs: [...this.regs],
      tone: [0, 1, 2].map((c) => ({ period: this.tonePeriod[c], volume: this.toneVolume[c], count: this.toneCount[c], output: this.toneOutput[c] })),
      noise: { count: this.countNoise, prescale: this.prescaleNoise, rng: this.rng },
      env: { period: this.envPeriod, count: this.envCount, step: this.envStep, volume: this.envVolume, holding: this.envHolding },
    };
  }
}

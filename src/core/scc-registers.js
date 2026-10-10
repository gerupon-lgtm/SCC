// SCC互換のアドレス層（F-012）。MAMEの scc_map と同じ割り当て
//   0x00〜0x7F  波形（0x60〜0x7F は ch4・ch5 の共有バンク）
//   0x80〜0x89  周波数（ch0〜4、偶数が下位8ビット・奇数が上位4ビット）
//   0x8A〜0x8E  音量
//   0x8F        キー（ビット0〜4）
//   0x90〜0x9F  0x80〜0x8F の鏡
//   0xA0〜0xDF  何もない
//   0xE0〜0xFF  テストレジスタ（値を保存するだけ。MVP【設計】）

/** 書き込み専用・何もないアドレスの読み出し値（オープンバス）【設計】 */
export const OPEN_BUS = 0xff;

/** アドレス層が扱うチャンネル数（SCC互換） */
const REG_CHANNELS = 5;

export class SccRegisters {
  /** @param {import('./scc-ref.js').SccRef} chip 基準版か高速版（同じ形） */
  constructor(chip) {
    this.chip = chip;
    this.test = 0;
  }

  /**
   * @param {number} addr 0x00〜0xFF
   * @param {number} value 0〜255
   */
  write(addr, value) {
    if (!Number.isInteger(addr) || addr < 0 || addr > 0xff) throw new RangeError(`アドレスが範囲外です：${addr}`);
    const v = value & 0xff;
    if (addr < 0x80) {
      // 符号付き8ビットへ。設定に無いバンクは無視
      if ((addr >> 5) < this.chip.config.waveBankCount) this.chip.writeWave(addr >> 5, addr & 0x1f, (v << 24) >> 24);
      return;
    }
    if (addr >= 0xe0) {
      this.test = v;
      return;
    }
    if (addr >= 0xa0) return;
    const reg = addr & 0x0f; // 0x90〜0x9F は鏡
    const channelCount = this.chip.config.channelCount;
    if (reg <= 0x09) {
      const ch = reg >> 1;
      if (ch >= channelCount) return; // 設定に無いチャンネルは無視
      const f = this.chip.getFrequency(ch);
      this.chip.setFrequency(ch, reg & 1 ? (f & 0x0ff) | ((v << 8) & 0xf00) : (f & 0xf00) | v);
    } else if (reg <= 0x0e) {
      if (reg - 0x0a < channelCount) this.chip.setVolume(reg - 0x0a, v);
    } else {
      this.chip.setKey(v, REG_CHANNELS); // ch0〜4 だけを変える。追加チャンネルには触れない
    }
  }

  /**
   * @param {number} addr 0x00〜0xFF
   * @returns {number} 0〜255
   */
  read(addr) {
    if (!Number.isInteger(addr) || addr < 0 || addr > 0xff) throw new RangeError(`アドレスが範囲外です：${addr}`);
    if (addr < 0x80) {
      if ((addr >> 5) >= this.chip.config.waveBankCount) return OPEN_BUS;
      return this.chip.readWave(addr >> 5, addr & 0x1f) & 0xff;
    }
    if (addr >= 0xe0) return this.test;
    return OPEN_BUS;
  }
}

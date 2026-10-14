// 追加チャンネル（F-011、最大16）のアドレス層。SCC互換の 0x00〜0xFF はそのまま SccRegisters に任せる
// 本物のSCCには無い、このアプリだけの決めごと【設計】（docs/api-design.md 2章）
//   0x100 + (ch-5)*4 + 0   周波数の下位8ビット（ch = 5〜15）
//                    + 1   周波数の上位4ビット
//                    + 2   音量（下位4ビット）
//                    + 3   キー（ビット0）
//   0x200 + (bank-4)*32 + i  波形（bank = 4〜14。追加チャンネルは共有しない専用バンク）
import { SccRegisters, OPEN_BUS } from './scc-registers.js';
import { WAVE_LENGTH } from './config.js';

/** SCC互換のチャンネル数（これより後ろが追加チャンネル） */
export const COMPAT_CHANNELS = 5;
/** SCC互換の波形バンク数（これより後ろが追加チャンネルのバンク） */
export const COMPAT_BANKS = 4;
export const EXT_CHANNEL_BASE = 0x100;
export const EXT_CHANNEL_STRIDE = 4;
export const EXT_WAVE_BASE = 0x200;
/** 拡張アドレスの終わり（この値は含まない） */
export const EXT_ADDR_END = 0x400;

/** チャンネル ch の周波数（下位）・音量・キーのアドレス。ch < 5 なら SCC互換のアドレス */
export function channelAddr(ch) {
  if (ch < COMPAT_CHANNELS) return { freqLo: 0x80 + ch * 2, freqHi: 0x81 + ch * 2, volume: 0x8a + ch, key: null };
  const base = EXT_CHANNEL_BASE + (ch - COMPAT_CHANNELS) * EXT_CHANNEL_STRIDE;
  return { freqLo: base, freqHi: base + 1, volume: base + 2, key: base + 3 };
}

/** 波形バンク bank の i 番目のアドレス */
export function waveAddr(bank, i) {
  return bank < COMPAT_BANKS ? bank * WAVE_LENGTH + i : EXT_WAVE_BASE + (bank - COMPAT_BANKS) * WAVE_LENGTH + i;
}

export class SccExtRegisters extends SccRegisters {
  /**
   * @param {number} addr 0x000〜0x3FF
   * @param {number} value 0〜255
   */
  write(addr, value) {
    if (Number.isInteger(addr) && addr >= 0 && addr < 0x100) { super.write(addr, value); return; }
    const loc = this.#locate(addr);
    if (!loc) return;
    const v = value & 0xff;
    if (loc.kind === 'wave') { this.chip.writeWave(loc.bank, loc.index, (v << 24) >> 24); return; }
    const { ch, reg } = loc;
    if (reg === 0 || reg === 1) {
      const f = this.chip.getFrequency(ch);
      this.chip.setFrequency(ch, reg === 1 ? (f & 0x0ff) | ((v << 8) & 0xf00) : (f & 0xf00) | v);
    } else if (reg === 2) {
      this.chip.setVolume(ch, v);
    } else {
      this.chip.setChannelKey(ch, (v & 1) === 1);
    }
  }

  /** @param {number} addr */
  read(addr) {
    if (Number.isInteger(addr) && addr >= 0 && addr < 0x100) return super.read(addr);
    const loc = this.#locate(addr);
    if (loc?.kind === 'wave') return this.chip.readWave(loc.bank, loc.index) & 0xff;
    return OPEN_BUS;
  }

  /** 拡張アドレスを、チャンネル・波形の位置に直す。設定に無いもの・何もないアドレスは null */
  #locate(addr) {
    if (!Number.isInteger(addr) || addr < 0 || addr >= EXT_ADDR_END) throw new RangeError(`アドレスが範囲外です：${addr}`);
    const { channelCount, waveBankCount } = this.chip.config;
    if (addr >= EXT_WAVE_BASE) {
      const bank = COMPAT_BANKS + ((addr - EXT_WAVE_BASE) >> 5);
      return bank < waveBankCount ? { kind: 'wave', bank, index: addr & 0x1f } : null;
    }
    if (addr >= EXT_CHANNEL_BASE) {
      const ch = COMPAT_CHANNELS + Math.floor((addr - EXT_CHANNEL_BASE) / EXT_CHANNEL_STRIDE);
      return ch < channelCount ? { kind: 'channel', ch, reg: (addr - EXT_CHANNEL_BASE) % EXT_CHANNEL_STRIDE } : null;
    }
    return null;
  }
}

// 最小限の CP/M（昔の OS）。Z80 の上で、本物の MGSC.COM（MML → MGS の変換）と、
// Z80 の検査プログラム（ZEXDOC）を動かすために使う。ファイルはメモリ上だけで扱う（外部に送らない）
// MGSC の説明書：「-e オプションで CP/M のファンクションのみを使用する」
import { Z80 } from './z80.js';

const BDOS_ENTRY = 0xfe00; // ここへ来たら BDOS の呼び出しとして処理する
const TPA = 0x0100;
const FCB1 = 0x005c, FCB2 = 0x006c, TAIL = 0x0080;

export class CpmMachine {
  /**
   * @param {Record<string, Uint8Array>} [files] ファイル名（大文字、例 "SONG.MUS"）→ 中身
   */
  constructor(files = {}) {
    this.mem = new Uint8Array(0x10000);
    /** @type {Map<string, Uint8Array>} */
    this.files = new Map(Object.entries(files).map(([k, v]) => [k.toUpperCase(), v]));
    this.output = '';
    this.dma = 0x0080;
    this.exited = false;
    /** 開いているファイル：FCB のアドレス → { name, data（書き込み中は伸びる配列） } */
    this.open = new Map();
    const self = this;
    this.cpu = new Z80({
      read: (a) => self.mem[a],
      write: (a, v) => { self.mem[a] = v; },
      input: () => 0xff,
      output: () => {},
    });
  }

  /**
   * .COM を読み込んで動かす
   * @param {Uint8Array} com
   * @param {string} [args] コマンド行の引数（例 "SONG -e"）
   * @param {number} [maxSteps]
   * @returns {{ exited: boolean, output: string }}
   */
  run(com, args = '', maxSteps = 2_000_000_000) {
    const m = this.mem;
    m.fill(0);
    m.set(com, TPA);
    m[0] = 0xc3; m[1] = 0x03; m[2] = 0xff; // JP 0FF03h（ウォームブート：終了の印）
    m[5] = 0xc3; m[6] = BDOS_ENTRY & 0xff; m[7] = BDOS_ENTRY >> 8; // JP BDOS
    m[BDOS_ENTRY] = 0xc9;
    // コマンド行と FCB
    const tail = args ? ` ${args.toUpperCase()}` : '';
    m[TAIL] = tail.length;
    for (let i = 0; i < tail.length; i++) m[TAIL + 1 + i] = tail.charCodeAt(i);
    const words = args.toUpperCase().split(/\s+/).filter((w) => w && !w.startsWith('-') && !w.startsWith('/'));
    this.#setFcbName(FCB1, words[0] ?? '');
    this.#setFcbName(FCB2, words[1] ?? '');
    const cpu = this.cpu;
    cpu.reset();
    cpu.sp = BDOS_ENTRY - 2;
    cpu.ww(cpu.sp, 0x0000);
    cpu.pc = TPA;
    this.exited = false;
    for (let i = 0; i < maxSteps && !this.exited; i++) {
      if (cpu.pc === BDOS_ENTRY) { this.#bdos(); cpu.pc = cpu.pop(); continue; }
      if (cpu.pc === 0xff03 || cpu.pc === 0x0000) { this.exited = true; break; }
      cpu.step();
    }
    return { exited: this.exited, output: this.output };
  }

  #setFcbName(addr, word) {
    const m = this.mem;
    m.fill(0, addr, addr + 16);
    let s = word;
    if (/^[A-P]:/.test(s)) { m[addr] = s.charCodeAt(0) - 64; s = s.slice(2); }
    const [name = '', ext = ''] = s.split('.');
    for (let i = 0; i < 8; i++) m[addr + 1 + i] = i < name.length ? name.charCodeAt(i) : 0x20;
    for (let i = 0; i < 3; i++) m[addr + 9 + i] = i < ext.length ? ext.charCodeAt(i) : 0x20;
  }

  #fcbName(addr) {
    let name = '', ext = '';
    for (let i = 0; i < 8; i++) name += String.fromCharCode(this.mem[addr + 1 + i] & 0x7f);
    for (let i = 0; i < 3; i++) ext += String.fromCharCode(this.mem[addr + 9 + i] & 0x7f);
    name = name.trim(); ext = ext.trim();
    return ext ? `${name}.${ext}` : name;
  }

  /** FCB の位置（レコード番号）。順番の読み書き用 */
  #seqRecord(addr) {
    const m = this.mem;
    return (((m[addr + 14] & 0x3f) * 32 + (m[addr + 12] & 0x1f)) * 128) + m[addr + 32];
  }
  #setSeqRecord(addr, rec) {
    const m = this.mem;
    m[addr + 32] = rec % 128;
    m[addr + 12] = Math.floor(rec / 128) % 32;
    m[addr + 14] = Math.floor(rec / 4096);
  }
  #randRecord(addr) {
    const m = this.mem;
    return m[addr + 33] | (m[addr + 34] << 8) | ((m[addr + 35] & 3) << 16);
  }

  #readRecord(addr, rec) {
    const f = this.open.get(addr) ?? this.#reopen(addr);
    if (!f) return 0xff;
    const start = rec * 128;
    if (start >= f.data.length) return 1; // ファイルの終わり
    for (let i = 0; i < 128; i++) this.mem[this.dma + i] = start + i < f.data.length ? f.data[start + i] : 0x1a;
    return 0;
  }

  #writeRecord(addr, rec) {
    const f = this.open.get(addr) ?? this.#reopen(addr);
    if (!f) return 0xff;
    const need = (rec + 1) * 128;
    if (f.data.length < need) { const d = new Uint8Array(need); d.set(f.data); f.data = d; }
    f.data.set(this.mem.subarray(this.dma, this.dma + 128), rec * 128);
    this.files.set(f.name, f.data);
    return 0;
  }

  /** FCB を作り直して呼ばれたとき（同じ名前のファイルを開き直す） */
  #reopen(addr) {
    const name = this.#fcbName(addr);
    const data = this.files.get(name);
    if (!data) return null;
    const f = { name, data };
    this.open.set(addr, f);
    return f;
  }

  #bdos() {
    const cpu = this.cpu, m = this.mem;
    const fn = cpu.c, de = cpu.de;
    let ret = 0;
    switch (fn) {
      case 0: this.exited = true; break;
      case 1: ret = 0x1a; break; // 入力は無い
      case 2: this.output += String.fromCharCode(cpu.e); break;
      case 6: if (cpu.e !== 0xff && cpu.e !== 0xfe) this.output += String.fromCharCode(cpu.e); break;
      case 9: { let a = de; for (let n = 0; n < 0x10000 && m[a] !== 0x24; n++, a = (a + 1) & 0xffff) this.output += String.fromCharCode(m[a]); break; }
      case 10: m[de + 1] = 0; break;
      case 11: ret = 0; break;
      case 12: cpu.hl = 0x0022; ret = 0x22; break;
      case 13: case 14: case 25: case 32: ret = 0; break;
      case 15: { // 開く
        const name = this.#fcbName(de);
        const data = this.files.get(name);
        if (data) { this.open.set(de, { name, data }); m[de + 12] = 0; m[de + 14] = 0; m[de + 32] = 0; m[de + 15] = 0x80; ret = 0; } else ret = 0xff;
        break;
      }
      case 16: this.open.delete(de); ret = 0; break; // 閉じる
      case 17: case 18: ret = 0xff; break; // 検索（使わない）
      case 19: this.files.delete(this.#fcbName(de)); ret = 0; break; // 消す
      case 20: { const rec = this.#seqRecord(de); ret = this.#readRecord(de, rec); if (ret === 0) this.#setSeqRecord(de, rec + 1); break; }
      case 21: { const rec = this.#seqRecord(de); ret = this.#writeRecord(de, rec); if (ret === 0) this.#setSeqRecord(de, rec + 1); break; }
      case 22: { // 作る
        const name = this.#fcbName(de);
        const data = new Uint8Array(0);
        this.files.set(name, data);
        this.open.set(de, { name, data });
        m[de + 12] = 0; m[de + 14] = 0; m[de + 32] = 0;
        ret = 0;
        break;
      }
      case 23: { // 名前を変える
        const from = this.#fcbName(de), to = this.#fcbName(de + 16);
        const data = this.files.get(from);
        if (data) { this.files.delete(from); this.files.set(to, data); ret = 0; } else ret = 0xff;
        break;
      }
      case 26: this.dma = de; break;
      case 33: ret = this.#readRecord(de, this.#randRecord(de)); break;
      case 34: case 40: ret = this.#writeRecord(de, this.#randRecord(de)); break;
      case 35: { // 大きさ
        const data = this.files.get(this.#fcbName(de));
        const recs = data ? Math.ceil(data.length / 128) : 0;
        m[de + 33] = recs & 0xff; m[de + 34] = (recs >> 8) & 0xff; m[de + 35] = recs >> 16;
        ret = data ? 0 : 0xff;
        break;
      }
      case 36: { const rec = this.#seqRecord(de); m[de + 33] = rec & 0xff; m[de + 34] = (rec >> 8) & 0xff; m[de + 35] = rec >> 16; break; }
      default: ret = 0; break; // 知らない呼び出しは何もしない
    }
    cpu.a = ret & 0xff;
    cpu.l = ret & 0xff;
    if (fn !== 12) cpu.h = 0;
    cpu.b = cpu.h;
  }
}

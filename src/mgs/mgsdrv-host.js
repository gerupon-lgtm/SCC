// 本物の MGSDRV を Z80 の上で動かし、SCC・PSG への書き込みを取り出す（F-016、T-108 案B）
// 環境は libkss（MSXplay が使う部品）の mgs2kss.c・vm.c と同じにする：
//   - メモリ64KB。0x0000〜0x3FFF は RET（0xC9）で埋め、BIOS は PSG の読み書き（0x93・0x96）だけ用意する
//   - MGSDRV.COM の 0x0D から 8KB を 0x6000 に置く。曲（MGS）は 0x0200 から
//   - 0x8000〜0xBFFF は書き込めない。0x9800〜0x98FF への書き込みは SCC、ポート 0xA0・0xA1 は PSG
//   - 呼ぶ順：0x6010（初期化）→ (IX+0)=(IX+1)=1 → SCC を有効に → 0x6016（演奏開始、DE=0x0200、B=H=L=0xFF）
//     → 以後 1/60 秒ごとに 0x601F
// DOM・Web Audio に依存しない。frame() はオブジェクトを作らない（AudioWorklet の中で呼ぶため）
import { Z80 } from './z80.js';

const DRIVER_ADDR = 0x6000;
const DRIVER_OFFSET = 0x0d;
const DRIVER_SIZE = 0x2000;
const SONG_ADDR = 0x0200;
const SENTINEL = 0xf37c; // call() の戻り先の印（libkss の exec_setup のスタック付近。中身は実行しない）
const STACK_TOP = 0xf380;
export const INIT_ENTRY = 0x6010;
export const PLAY_ENTRY = 0x6016;
export const INTER_ENTRY = 0x601f;
/** 曲データの最大の大きさ（0x0200〜0x5FFF） */
export const MAX_SONG_SIZE = DRIVER_ADDR - SONG_ADDR;

export class MgsdrvError extends Error {
  constructor(message) { super(message); this.name = 'MgsdrvError'; }
}

export class MgsdrvHost {
  /**
   * @param {object} opts
   * @param {Uint8Array} opts.driver MGSDRV.COM の中身
   * @param {(addr: number, value: number) => void} opts.onScc SCC への書き込み（addr は 0x00〜0xFF）
   * @param {(reg: number, value: number) => void} [opts.onPsg] PSG への書き込み（reg は 0〜15）
   */
  constructor({ driver, onScc, onPsg = () => {} }) {
    if (!(driver instanceof Uint8Array) || driver.length < DRIVER_OFFSET + 0x20) throw new MgsdrvError('MGSDRV.COM ではないようです（小さすぎます）');
    this.driver = driver;
    this.onScc = onScc;
    this.onPsg = onPsg;
    this.mem = new Uint8Array(0x10000);
    this.psgLatch = 0;
    this.psgRegs = new Uint8Array(16);
    this.sccEnabled = false;
    this.mib = 0;
    const host = this;
    this.cpu = new Z80({
      read: (a) => host.mem[a],
      write: (a, v) => host.#write(a, v),
      input: (p) => ((p & 0xff) === 0xa2 ? host.psgRegs[host.psgLatch & 0x0f] : 0xff),
      output: (p, v) => host.#output(p & 0xff, v),
    });
  }

  #write(a, v) {
    if (a === 0x9000) { this.sccEnabled = (v & 0x3f) === 0x3f; return; }
    if (a >= 0x9800 && a <= 0x98ff) {
      if (this.sccEnabled) this.onScc(a & 0xff, v);
      return;
    }
    if (a >= 0x8000 && a < 0xc000) return; // 書き込めないページ（libkss と同じ）
    this.mem[a] = v;
  }

  #output(p, v) {
    if (p === 0xa0) this.psgLatch = v;
    else if (p === 0xa1) {
      const reg = this.psgLatch & 0x0f;
      this.psgRegs[reg] = v;
      this.onPsg(reg, v);
    }
  }

  /**
   * 曲（MGS）を読み込み、演奏を始める
   * @param {Uint8Array} mgs MGS 形式（先頭が "MGS"）
   */
  load(mgs) {
    if (!(mgs instanceof Uint8Array) || mgs.length < 32 || String.fromCharCode(mgs[0], mgs[1], mgs[2]) !== 'MGS') {
      throw new MgsdrvError('MGS 形式のデータではありません');
    }
    if (mgs.length > MAX_SONG_SIZE) throw new MgsdrvError(`曲データが大きすぎます（${mgs.length} バイト、最大 ${MAX_SONG_SIZE}）`);
    const m = this.mem;
    m.fill(0xc9, 0, 0x4000);
    m.fill(0, 0x4000);
    // BIOS の代わり（libkss の vm.c と同じ）：0x93 WRTPSG → 0x01、0x96 RDPSG → 0x09
    m.set([0xc3, 0x01, 0x00, 0xc3, 0x09, 0x00], 0x93);
    m.set([0xd3, 0xa0, 0xf5, 0x7b, 0xd3, 0xa1, 0xf1, 0xc9], 0x01);
    m.set([0xd3, 0xa0, 0xdb, 0xa2, 0xc9], 0x09);
    m.set(mgs, SONG_ADDR);
    m.set(this.driver.subarray(DRIVER_OFFSET, DRIVER_OFFSET + DRIVER_SIZE), DRIVER_ADDR);
    this.psgRegs.fill(0);
    this.sccEnabled = false;

    const cpu = this.cpu;
    cpu.reset();
    cpu.sp = STACK_TOP;
    if (!cpu.call(INIT_ENTRY, SENTINEL)) throw new MgsdrvError('MGSDRV の初期化が終わりませんでした');
    this.mib = cpu.ix;
    this.mem[this.mib] = 1;
    this.mem[(this.mib + 1) & 0xffff] = 1;
    // SCC を有効にする（libkss と同じ。メガROM の動き）
    this.#write(0xbffe, 0);
    this.#write(0x9000, 0x3f);
    cpu.de = SONG_ADDR;
    cpu.b = 0xff; cpu.h = 0xff; cpu.l = 0xff;
    if (!cpu.call(PLAY_ENTRY, SENTINEL)) throw new MgsdrvError('MGSDRV の演奏開始が終わりませんでした');
  }

  /** 1/60 秒ぶん進める。終わらなかったら false */
  frame() {
    const cpu = this.cpu;
    cpu.sp = STACK_TOP;
    return cpu.call(INTER_ENTRY, SENTINEL, 2_000_000);
  }

  /** 演奏中か（MIB+8 が0なら止まった。libkss と同じ） */
  get playing() { return this.mem[(this.mib + 8) & 0xffff] !== 0; }
  /** 何回くり返したか（MIB+5） */
  get loopCount() { return this.mem[(this.mib + 5) & 0xffff]; }
}

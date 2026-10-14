// Z80（MSX の CPU）の再現。本物の MGSDRV・MGSC を動かすための部品（F-016、T-108 案B）
// DOM・Web Audio に依存しない。step() はオブジェクトを作らない（AudioWorklet の中で動かすため）
//
// バスは次の4つの関数を持つもの：
//   read(addr) → 0〜255、write(addr, value)、input(port) → 0〜255、output(port, value)
//
// 未定義命令の扱い・フラグのビット3と5（X・Y）は、一般に知られている実機の動きにそろえる。
// 正しさは tests/z80.test.js（命令ごとの確認）と、ZEXDOC（Z80 の命令検査プログラム）で確かめる

const FC = 0x01, FN = 0x02, FPV = 0x04, FX = 0x08, FH = 0x10, FY = 0x20, FZ = 0x40, FS = 0x80;

/** S・Z・Y・X と、偶数パリティ（PV）の表 */
const SZ = new Uint8Array(256);
const SZP = new Uint8Array(256);
for (let i = 0; i < 256; i++) {
  SZ[i] = (i & (FS | FY | FX)) | (i === 0 ? FZ : 0);
  let p = i; p ^= p >> 4; p ^= p >> 2; p ^= p >> 1;
  SZP[i] = SZ[i] | ((p & 1) ? 0 : FPV);
}

export class Z80 {
  /** @param {{read(a:number):number, write(a:number,v:number):void, input(p:number):number, output(p:number,v:number):void}} bus */
  constructor(bus) {
    this.bus = bus;
    this.reset();
  }

  reset() {
    this.a = 0xff; this.f = 0xff;
    this.b = 0; this.c = 0; this.d = 0; this.e = 0; this.h = 0; this.l = 0;
    this.a_ = 0; this.f_ = 0; this.b_ = 0; this.c_ = 0; this.d_ = 0; this.e_ = 0; this.h_ = 0; this.l_ = 0;
    this.ix = 0xffff; this.iy = 0xffff; this.sp = 0xffff; this.pc = 0;
    this.i = 0; this.r = 0; this.iff1 = 0; this.iff2 = 0; this.im = 0;
    this.halted = false;
    this.eiDelay = false;
    this.cycles = 0;
    /** 0：HL、1：IX、2：IY（DD・FD の接頭辞で切り替える） */
    this.idx = 0;
  }

  // ---- 16ビットのレジスタ ----
  get bc() { return (this.b << 8) | this.c; }
  set bc(v) { this.b = (v >> 8) & 0xff; this.c = v & 0xff; }
  get de() { return (this.d << 8) | this.e; }
  set de(v) { this.d = (v >> 8) & 0xff; this.e = v & 0xff; }
  get hl() { return (this.h << 8) | this.l; }
  set hl(v) { this.h = (v >> 8) & 0xff; this.l = v & 0xff; }
  get af() { return (this.a << 8) | this.f; }
  set af(v) { this.a = (v >> 8) & 0xff; this.f = v & 0xff; }

  // ---- メモリ ----
  rb(a) { return this.bus.read(a & 0xffff); }
  wb(a, v) { this.bus.write(a & 0xffff, v & 0xff); }
  rw(a) { return this.rb(a) | (this.rb(a + 1) << 8); }
  ww(a, v) { this.wb(a, v); this.wb(a + 1, v >> 8); }
  fetch() { const v = this.rb(this.pc); this.pc = (this.pc + 1) & 0xffff; return v; }
  fetchw() { const v = this.rw(this.pc); this.pc = (this.pc + 2) & 0xffff; return v; }
  fetchd() { const d = this.fetch(); return d < 128 ? d : d - 256; }
  push(v) { this.sp = (this.sp - 2) & 0xffff; this.ww(this.sp, v); }
  pop() { const v = this.rw(this.sp); this.sp = (this.sp + 2) & 0xffff; return v; }
  incR() { this.r = (this.r & 0x80) | ((this.r + 1) & 0x7f); }

  // ---- HL / IX / IY の切り替え ----
  getHL() { return this.idx === 0 ? this.hl : this.idx === 1 ? this.ix : this.iy; }
  setHL(v) { v &= 0xffff; if (this.idx === 0) this.hl = v; else if (this.idx === 1) this.ix = v; else this.iy = v; }
  /** (HL) か (IX+d) のアドレス。d はこの時点で読む */
  addrHL() { return this.idx === 0 ? this.hl : ((this.idx === 1 ? this.ix : this.iy) + this.fetchd()) & 0xffff; }

  /**
   * 8ビットのレジスタ番号（0:B 1:C 2:D 3:E 4:H 5:L 6:(HL) 7:A）
   * useIdx が真なら H・L は IXH・IXL（または IYH・IYL）を指す
   */
  getR(n, useIdx) {
    switch (n) {
      case 0: return this.b; case 1: return this.c; case 2: return this.d; case 3: return this.e;
      case 4: return useIdx && this.idx ? ((this.idx === 1 ? this.ix : this.iy) >> 8) : this.h;
      case 5: return useIdx && this.idx ? ((this.idx === 1 ? this.ix : this.iy) & 0xff) : this.l;
      case 7: return this.a;
      default: return 0;
    }
  }
  setR(n, v, useIdx) {
    v &= 0xff;
    switch (n) {
      case 0: this.b = v; break; case 1: this.c = v; break; case 2: this.d = v; break; case 3: this.e = v; break;
      case 4:
        if (useIdx && this.idx === 1) this.ix = (this.ix & 0xff) | (v << 8);
        else if (useIdx && this.idx === 2) this.iy = (this.iy & 0xff) | (v << 8);
        else this.h = v;
        break;
      case 5:
        if (useIdx && this.idx === 1) this.ix = (this.ix & 0xff00) | v;
        else if (useIdx && this.idx === 2) this.iy = (this.iy & 0xff00) | v;
        else this.l = v;
        break;
      case 7: this.a = v; break;
      default: break;
    }
  }

  /** 16ビットのレジスタ対（0:BC 1:DE 2:HL/IX/IY 3:SP） */
  getRP(p) { return p === 0 ? this.bc : p === 1 ? this.de : p === 2 ? this.getHL() : this.sp; }
  setRP(p, v) { v &= 0xffff; if (p === 0) this.bc = v; else if (p === 1) this.de = v; else if (p === 2) this.setHL(v); else this.sp = v; }
  /** PUSH・POP 用（3:AF） */
  getRP2(p) { return p === 3 ? this.af : this.getRP(p); }
  setRP2(p, v) { if (p === 3) this.af = v & 0xffff; else this.setRP(p, v); }

  /** 条件（0:NZ 1:Z 2:NC 3:C 4:PO 5:PE 6:P 7:M） */
  cond(y) {
    switch (y) {
      case 0: return !(this.f & FZ); case 1: return !!(this.f & FZ);
      case 2: return !(this.f & FC); case 3: return !!(this.f & FC);
      case 4: return !(this.f & FPV); case 5: return !!(this.f & FPV);
      case 6: return !(this.f & FS); default: return !!(this.f & FS);
    }
  }

  // ---- 演算 ----
  add8(v, cy) {
    const a = this.a, r = a + v + cy;
    this.f = SZ[r & 0xff] | ((r >> 8) & FC) | ((a ^ v ^ r) & FH) | ((((a ^ ~v) & (a ^ r)) & 0x80) >> 5);
    this.a = r & 0xff;
  }
  sub8(v, cy) {
    const a = this.a, r = a - v - cy;
    this.f = SZ[r & 0xff] | FN | ((r >> 8) & FC) | ((a ^ v ^ r) & FH) | ((((a ^ v) & (a ^ r)) & 0x80) >> 5);
    this.a = r & 0xff;
  }
  cp8(v) {
    const a = this.a, r = a - v;
    this.f = (SZ[r & 0xff] & ~(FX | FY)) | (v & (FX | FY)) | FN | ((r >> 8) & FC) | ((a ^ v ^ r) & FH) | ((((a ^ v) & (a ^ r)) & 0x80) >> 5);
  }
  alu(op, v) {
    switch (op) {
      case 0: this.add8(v, 0); break;
      case 1: this.add8(v, this.f & FC); break;
      case 2: this.sub8(v, 0); break;
      case 3: this.sub8(v, this.f & FC); break;
      case 4: this.a &= v; this.f = SZP[this.a] | FH; break;
      case 5: this.a ^= v; this.f = SZP[this.a]; break;
      case 6: this.a |= v; this.f = SZP[this.a]; break;
      default: this.cp8(v); break;
    }
  }
  inc8(v) {
    const r = (v + 1) & 0xff;
    this.f = (this.f & FC) | SZ[r] | ((v & 0x0f) === 0x0f ? FH : 0) | (v === 0x7f ? FPV : 0);
    return r;
  }
  dec8(v) {
    const r = (v - 1) & 0xff;
    this.f = (this.f & FC) | FN | SZ[r] | ((v & 0x0f) === 0 ? FH : 0) | (v === 0x80 ? FPV : 0);
    return r;
  }
  add16(a, b) {
    const r = a + b;
    this.f = (this.f & (FS | FZ | FPV)) | ((r >> 16) & FC) | (((a ^ b ^ r) >> 8) & FH) | ((r >> 8) & (FX | FY));
    return r & 0xffff;
  }
  adc16(b) {
    const a = this.getHL(), r = a + b + (this.f & FC);
    this.f = ((r >> 16) & FC) | (((a ^ b ^ r) >> 8) & FH) | ((((a ^ ~b) & (a ^ r)) & 0x8000) >> 13)
      | ((r >> 8) & (FS | FX | FY)) | ((r & 0xffff) === 0 ? FZ : 0);
    this.setHL(r);
  }
  sbc16(b) {
    const a = this.getHL(), r = a - b - (this.f & FC);
    this.f = FN | ((r >> 16) & FC) | (((a ^ b ^ r) >> 8) & FH) | ((((a ^ b) & (a ^ r)) & 0x8000) >> 13)
      | ((r >> 8) & (FS | FX | FY)) | ((r & 0xffff) === 0 ? FZ : 0);
    this.setHL(r);
  }
  /** CB の回転・シフト（0:RLC 1:RRC 2:RL 3:RR 4:SLA 5:SRA 6:SLL 7:SRL） */
  rot(op, v) {
    let r, c;
    switch (op) {
      case 0: c = v >> 7; r = (v << 1) | c; break;
      case 1: c = v & 1; r = (v >> 1) | (c << 7); break;
      case 2: c = v >> 7; r = (v << 1) | (this.f & FC); break;
      case 3: c = v & 1; r = (v >> 1) | ((this.f & FC) << 7); break;
      case 4: c = v >> 7; r = v << 1; break;
      case 5: c = v & 1; r = (v >> 1) | (v & 0x80); break;
      case 6: c = v >> 7; r = (v << 1) | 1; break;
      default: c = v & 1; r = v >> 1; break;
    }
    r &= 0xff;
    this.f = SZP[r] | c;
    return r;
  }
  daa() {
    let a = this.a, corr = 0, c = this.f & FC;
    const h = this.f & FH, n = this.f & FN;
    if (h || (a & 0x0f) > 9) corr |= 0x06;
    if (c || a > 0x99) { corr |= 0x60; c = FC; }
    const r = n ? a - corr : a + corr;
    const nh = n ? (h && (a & 0x0f) < 6 ? FH : 0) : ((a & 0x0f) > 9 ? FH : 0);
    a = r & 0xff;
    this.a = a;
    this.f = SZP[a] | n | c | nh;
  }

  /** 割り込み（IM 1 なら 0x38 へ）。割り込みが禁止なら何もしない */
  interrupt() {
    if (!this.iff1 || this.eiDelay) return false;
    this.halted = false;
    this.iff1 = 0; this.iff2 = 0;
    this.incR();
    this.push(this.pc);
    if (this.im === 2) this.pc = this.rw((this.i << 8) | 0xff);
    else this.pc = 0x38;
    this.cycles += 13;
    return true;
  }

  /** 1命令を実行する */
  step() {
    this.eiDelay = false;
    if (this.halted) { this.incR(); this.cycles += 4; return; }
    this.idx = 0;
    let op = this.fetch();
    this.incR();
    // DD・FD の接頭辞（重なったら最後のものが有効）
    while (op === 0xdd || op === 0xfd) {
      this.idx = op === 0xdd ? 1 : 2;
      op = this.fetch();
      this.incR();
      this.cycles += 4;
    }
    if (op === 0xcb) { this.execCB(); return; }
    if (op === 0xed) { this.idx = 0; this.execED(); return; }
    this.execMain(op);
  }

  execMain(op) {
    const x = op >> 6, y = (op >> 3) & 7, z = op & 7, p = y >> 1, q = y & 1;
    this.cycles += 4;
    if (x === 1) {
      if (op === 0x76) { this.halted = true; return; }
      // LD r,r'。(HL) が絡むときは H・L を IX の上下に置き換えない
      if (y === 6) { this.wb(this.addrHL(), this.getR(z, false)); return; }
      if (z === 6) { this.setR(y, this.rb(this.addrHL()), false); return; }
      this.setR(y, this.getR(z, true), true);
      return;
    }
    if (x === 2) {
      this.alu(y, z === 6 ? this.rb(this.addrHL()) : this.getR(z, true));
      return;
    }
    if (x === 0) {
      switch (z) {
        case 0:
          switch (y) {
            case 0: return; // NOP
            case 1: { // EX AF,AF'
              let t = this.a; this.a = this.a_; this.a_ = t;
              t = this.f; this.f = this.f_; this.f_ = t; return;
            }
            case 2: { // DJNZ
              const d = this.fetchd();
              this.b = (this.b - 1) & 0xff;
              if (this.b !== 0) this.pc = (this.pc + d) & 0xffff;
              return;
            }
            case 3: { const d = this.fetchd(); this.pc = (this.pc + d) & 0xffff; return; } // JR
            default: { const d = this.fetchd(); if (this.cond(y - 4)) this.pc = (this.pc + d) & 0xffff; return; }
          }
        case 1:
          if (q === 0) this.setRP(p, this.fetchw());
          else this.setHL(this.add16(this.getHL(), this.getRP(p)));
          return;
        case 2:
          switch (y) {
            case 0: this.wb(this.bc, this.a); return;
            case 1: this.a = this.rb(this.bc); return;
            case 2: this.wb(this.de, this.a); return;
            case 3: this.a = this.rb(this.de); return;
            case 4: this.ww(this.fetchw(), this.getHL()); return;
            case 5: this.setHL(this.rw(this.fetchw())); return;
            case 6: this.wb(this.fetchw(), this.a); return;
            default: this.a = this.rb(this.fetchw()); return;
          }
        case 3:
          this.setRP(p, q === 0 ? this.getRP(p) + 1 : this.getRP(p) - 1);
          return;
        case 4:
          if (y === 6) { const a = this.addrHL(); this.wb(a, this.inc8(this.rb(a))); } else this.setR(y, this.inc8(this.getR(y, true)), true);
          return;
        case 5:
          if (y === 6) { const a = this.addrHL(); this.wb(a, this.dec8(this.rb(a))); } else this.setR(y, this.dec8(this.getR(y, true)), true);
          return;
        case 6:
          if (y === 6) { const a = this.addrHL(); this.wb(a, this.fetch()); } else this.setR(y, this.fetch(), true);
          return;
        default:
          switch (y) {
            case 0: { const c = this.a >> 7; this.a = ((this.a << 1) | c) & 0xff; this.f = (this.f & (FS | FZ | FPV)) | c | (this.a & (FX | FY)); return; } // RLCA
            case 1: { const c = this.a & 1; this.a = (this.a >> 1) | (c << 7); this.f = (this.f & (FS | FZ | FPV)) | c | (this.a & (FX | FY)); return; } // RRCA
            case 2: { const c = this.a >> 7; this.a = ((this.a << 1) | (this.f & FC)) & 0xff; this.f = (this.f & (FS | FZ | FPV)) | c | (this.a & (FX | FY)); return; } // RLA
            case 3: { const c = this.a & 1; this.a = (this.a >> 1) | ((this.f & FC) << 7); this.f = (this.f & (FS | FZ | FPV)) | c | (this.a & (FX | FY)); return; } // RRA
            case 4: this.daa(); return;
            case 5: this.a ^= 0xff; this.f = (this.f & (FS | FZ | FPV | FC)) | FH | FN | (this.a & (FX | FY)); return; // CPL
            case 6: this.f = (this.f & (FS | FZ | FPV)) | FC | (this.a & (FX | FY)); return; // SCF
            default: this.f = ((this.f & (FS | FZ | FPV | FC)) | ((this.f & FC) << 4) | (this.a & (FX | FY))) ^ FC; return; // CCF
          }
      }
    }
    // x === 3
    switch (z) {
      case 0: if (this.cond(y)) this.pc = this.pop(); return; // RET cc
      case 1:
        if (q === 0) { this.setRP2(p, this.pop()); return; }
        switch (p) {
          case 0: this.pc = this.pop(); return; // RET
          case 1: { // EXX
            let t;
            t = this.b; this.b = this.b_; this.b_ = t; t = this.c; this.c = this.c_; this.c_ = t;
            t = this.d; this.d = this.d_; this.d_ = t; t = this.e; this.e = this.e_; this.e_ = t;
            t = this.h; this.h = this.h_; this.h_ = t; t = this.l; this.l = this.l_; this.l_ = t;
            return;
          }
          case 2: this.pc = this.getHL(); return; // JP (HL)
          default: this.sp = this.getHL(); return; // LD SP,HL
        }
      case 2: { const a = this.fetchw(); if (this.cond(y)) this.pc = a; return; } // JP cc
      case 3:
        switch (y) {
          case 0: this.pc = this.fetchw(); return; // JP
          case 2: { const n = this.fetch(); this.bus.output((this.a << 8) | n, this.a); return; } // OUT (n),A
          case 3: { const n = this.fetch(); this.a = this.bus.input((this.a << 8) | n) & 0xff; return; } // IN A,(n)
          case 4: { // EX (SP),HL
            const v = this.rw(this.sp); this.ww(this.sp, this.getHL()); this.setHL(v); return;
          }
          case 5: { const t = this.de; this.de = this.hl; this.hl = t; return; } // EX DE,HL（IX は無関係）
          case 6: this.iff1 = 0; this.iff2 = 0; return; // DI
          case 7: this.iff1 = 1; this.iff2 = 1; this.eiDelay = true; return; // EI
          default: return; // CB は step() で処理済み
        }
      case 4: { const a = this.fetchw(); if (this.cond(y)) { this.push(this.pc); this.pc = a; } return; } // CALL cc
      case 5:
        if (q === 0) { this.push(this.getRP2(p)); return; }
        if (p === 0) { const a = this.fetchw(); this.push(this.pc); this.pc = a; return; } // CALL
        return; // DD・ED・FD は step() で処理済み
      case 6: this.alu(y, this.fetch()); return;
      default: this.push(this.pc); this.pc = y * 8; return; // RST
    }
  }

  execCB() {
    let addr, v, n;
    this.cycles += 8;
    if (this.idx) {
      // DD CB d op：(IX+d) が対象。結果はレジスタにも写る（未定義命令の動き）
      addr = this.addrHL();
      n = this.fetch();
      v = this.rb(addr);
    } else {
      n = this.fetch();
      this.incR();
      if ((n & 7) === 6) { addr = this.hl; v = this.rb(addr); } else v = this.getR(n & 7, false);
    }
    const x = n >> 6, y = (n >> 3) & 7, z = n & 7;
    if (x === 1) { // BIT
      const bit = v & (1 << y);
      let f = (this.f & FC) | FH | (bit ? 0 : FZ | FPV) | (y === 7 && bit ? FS : 0);
      f |= (this.idx || z === 6) ? ((addr >> 8) & (FX | FY)) : (v & (FX | FY));
      this.f = f;
      return;
    }
    let r;
    if (x === 0) r = this.rot(y, v);
    else if (x === 2) r = v & ~(1 << y);
    else r = v | (1 << y);
    if (this.idx) {
      this.wb(addr, r);
      if (z !== 6) this.setR(z, r, false);
    } else if (z === 6) this.wb(addr, r);
    else this.setR(z, r, false);
  }

  execED() {
    const op = this.fetch();
    this.incR();
    this.cycles += 4;
    const x = op >> 6, y = (op >> 3) & 7, z = op & 7, p = y >> 1, q = y & 1;
    if (x === 1) {
      switch (z) {
        case 0: { // IN r,(C)
          const v = this.bus.input(this.bc) & 0xff;
          if (y !== 6) this.setR(y, v, false);
          this.f = (this.f & FC) | SZP[v];
          return;
        }
        case 1: this.bus.output(this.bc, y === 6 ? 0 : this.getR(y, false)); return; // OUT (C),r
        case 2: if (q === 0) this.sbc16(this.getRP(p)); else this.adc16(this.getRP(p)); return;
        case 3: { const a = this.fetchw(); if (q === 0) this.ww(a, this.getRP(p)); else this.setRP(p, this.rw(a)); return; }
        case 4: { const v = this.a; this.a = 0; this.sub8(v, 0); return; } // NEG
        case 5: this.pc = this.pop(); this.iff1 = this.iff2; return; // RETN・RETI
        case 6: this.im = [0, 0, 1, 2, 0, 0, 1, 2][y]; return;
        default:
          switch (y) {
            case 0: this.i = this.a; return;
            case 1: this.r = this.a; return;
            case 2: this.a = this.i; this.f = (this.f & FC) | SZ[this.a] | (this.iff2 ? FPV : 0); return;
            case 3: this.a = this.r; this.f = (this.f & FC) | SZ[this.a] | (this.iff2 ? FPV : 0); return;
            case 4: { // RRD
              const m = this.rb(this.hl);
              this.wb(this.hl, ((this.a << 4) | (m >> 4)) & 0xff);
              this.a = (this.a & 0xf0) | (m & 0x0f);
              this.f = (this.f & FC) | SZP[this.a];
              return;
            }
            case 5: { // RLD
              const m = this.rb(this.hl);
              this.wb(this.hl, ((m << 4) | (this.a & 0x0f)) & 0xff);
              this.a = (this.a & 0xf0) | (m >> 4);
              this.f = (this.f & FC) | SZP[this.a];
              return;
            }
            default: return; // NOP 扱い
          }
      }
    }
    if (x === 2 && z <= 3 && y >= 4) {
      const inc = (y & 1) === 0, repeat = y >= 6;
      switch (z) {
        case 0: { // LDI・LDD・LDIR・LDDR
          const v = this.rb(this.hl);
          this.wb(this.de, v);
          this.hl = (this.hl + (inc ? 1 : -1)) & 0xffff;
          this.de = (this.de + (inc ? 1 : -1)) & 0xffff;
          this.bc = (this.bc - 1) & 0xffff;
          const n = (v + this.a) & 0xff;
          this.f = (this.f & (FS | FZ | FC)) | (this.bc ? FPV : 0) | (n & FX) | ((n << 4) & FY);
          if (repeat && this.bc) this.pc = (this.pc - 2) & 0xffff;
          return;
        }
        case 1: { // CPI・CPD・CPIR・CPDR
          const v = this.rb(this.hl);
          const r = (this.a - v) & 0xff;
          const h = (this.a ^ v ^ r) & FH;
          this.hl = (this.hl + (inc ? 1 : -1)) & 0xffff;
          this.bc = (this.bc - 1) & 0xffff;
          const n = (r - (h ? 1 : 0)) & 0xff;
          this.f = (this.f & FC) | FN | (SZ[r] & (FS | FZ)) | h | (this.bc ? FPV : 0) | (n & FX) | ((n << 4) & FY);
          if (repeat && this.bc && r !== 0) this.pc = (this.pc - 2) & 0xffff;
          return;
        }
        case 2: { // INI・IND・INIR・INDR
          const v = this.bus.input(this.bc) & 0xff;
          this.wb(this.hl, v);
          this.hl = (this.hl + (inc ? 1 : -1)) & 0xffff;
          this.b = (this.b - 1) & 0xff;
          this.f = (SZ[this.b]) | FN;
          if (repeat && this.b) this.pc = (this.pc - 2) & 0xffff;
          return;
        }
        default: { // OUTI・OUTD・OTIR・OTDR
          const v = this.rb(this.hl);
          this.b = (this.b - 1) & 0xff;
          this.bus.output(this.bc, v);
          this.hl = (this.hl + (inc ? 1 : -1)) & 0xffff;
          this.f = (SZ[this.b]) | FN;
          if (repeat && this.b) this.pc = (this.pc - 2) & 0xffff;
          return;
        }
      }
    }
    // その他の ED は何もしない（NOP 扱い）
  }

  /**
   * サブルーチンを呼び、戻ってくるまで動かす。戻り先には印のアドレスを積む
   * @param {number} addr 呼ぶアドレス
   * @param {number} sentinel 戻ってきたと判断するアドレス（その番地の中身は実行しない）
   * @param {number} [maxSteps] 暴走したときに止める命令数
   * @returns {boolean} 戻ってきたら真
   */
  call(addr, sentinel, maxSteps = 5_000_000) {
    this.push(sentinel);
    this.pc = addr & 0xffff;
    this.halted = false;
    for (let i = 0; i < maxSteps; i++) {
      if (this.pc === sentinel) return true;
      this.step();
    }
    return false;
  }
}

export const FLAGS = Object.freeze({ FC, FN, FPV, FX, FH, FY, FZ, FS });

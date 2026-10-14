// Z80 の基本の確認（手で答えを出した小さなプログラム）。網羅的な確認は ZEXDOC で行う
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { Z80, FLAGS } from '../src/mgs/z80.js';
import { CpmMachine } from '../src/mgs/cpm.js';

const { FC, FN, FPV, FH, FZ, FS } = FLAGS;

function machine(bytes, org = 0) {
  const mem = new Uint8Array(0x10000);
  mem.set(bytes, org);
  const io = [];
  const cpu = new Z80({
    read: (a) => mem[a], write: (a, v) => { mem[a] = v; },
    input: (p) => p & 0xff, output: (p, v) => io.push([p & 0xff, v]),
  });
  cpu.pc = org; cpu.sp = 0xf000;
  const run = (n = 1000) => { for (let i = 0; i < n && !cpu.halted; i++) cpu.step(); };
  return { mem, cpu, io, run };
}

test('LD・ADD・フラグ：0x7F+1 は桁あふれ（PV）、0xFF+1 は桁上がり（C）とゼロ', () => {
  const { cpu, run } = machine([0x3e, 0x7f, 0xc6, 0x01, 0x76]); // LD A,7F; ADD A,1; HALT
  run();
  assert.equal(cpu.a, 0x80);
  assert.equal(cpu.f & (FS | FZ | FH | FPV | FN | FC), FS | FH | FPV);
  const m2 = machine([0x3e, 0xff, 0xc6, 0x01, 0x76]);
  m2.run();
  assert.equal(m2.cpu.a, 0);
  assert.equal(m2.cpu.f & (FZ | FC | FH), FZ | FC | FH);
});

test('SUB・CP・SBC', () => {
  const { cpu, run } = machine([0x3e, 0x10, 0xd6, 0x20, 0x76]); // 0x10-0x20
  run();
  assert.equal(cpu.a, 0xf0);
  assert.equal(cpu.f & (FS | FN | FC | FZ), FS | FN | FC);
  const m2 = machine([0x3e, 0x05, 0xfe, 0x05, 0x76]); // CP 5
  m2.run();
  assert.equal(m2.cpu.a, 5);
  assert.ok(m2.cpu.f & FZ);
});

test('DJNZ のループと CALL・RET：1〜10 の和', () => {
  // LD B,10; XOR A; loop: ADD A,B; DJNZ loop; CALL sub; HALT; sub: INC A; RET
  const { cpu, run } = machine([0x06, 10, 0xaf, 0x80, 0x10, 0xfd, 0xcd, 0x0b, 0x00, 0x76, 0x00, 0x3c, 0xc9]);
  run();
  assert.equal(cpu.a, 56);
});

test('IX+d の読み書き、CB の BIT・SET・RES', () => {
  // LD IX,1000h; LD (IX+5),33h; LD A,(IX+5); SET 7,(IX+5); BIT 7,(IX+5); LD B,(IX+5); RES 0,B; HALT
  const { cpu, mem, run } = machine([
    0xdd, 0x21, 0x00, 0x10, 0xdd, 0x36, 0x05, 0x33, 0xdd, 0x7e, 0x05,
    0xdd, 0xcb, 0x05, 0xfe, 0xdd, 0xcb, 0x05, 0x7e, 0xdd, 0x46, 0x05, 0xcb, 0x80, 0x76]);
  run();
  assert.equal(cpu.a, 0x33);
  assert.equal(mem[0x1005], 0xb3);
  assert.ok(!(cpu.f & FZ), 'BIT 7 は1');
  assert.equal(cpu.b, 0xb2);
});

test('LDIR でブロックを写す、ADD HL・SBC HL', () => {
  // LD HL,2000h; LD DE,3000h; LD BC,4; LDIR; LD HL,1234h; LD DE,0234h; OR A; SBC HL,DE; HALT
  const { cpu, mem, run } = machine([0x21, 0x00, 0x20, 0x11, 0x00, 0x30, 0x01, 0x04, 0x00, 0xed, 0xb0,
    0x21, 0x34, 0x12, 0x11, 0x34, 0x02, 0xb7, 0xed, 0x52, 0x76]);
  mem.set([1, 2, 3, 4], 0x2000);
  run();
  assert.deepEqual([...mem.subarray(0x3000, 0x3004)], [1, 2, 3, 4]);
  assert.equal(cpu.bc, 0);
  assert.equal(cpu.hl, 0x1000);
});

test('DAA：BCD の足し算 0x19+0x28=0x47、引き算 0x47-0x28=0x19', () => {
  const { cpu, run } = machine([0x3e, 0x19, 0xc6, 0x28, 0x27, 0x76]);
  run();
  assert.equal(cpu.a, 0x47);
  const m2 = machine([0x3e, 0x47, 0xd6, 0x28, 0x27, 0x76]);
  m2.run();
  assert.equal(m2.cpu.a, 0x19);
});

test('OUT・PUSH・POP・EX・EXX', () => {
  // LD A,0Eh; OUT (A0h),A; LD BC,1122h; PUSH BC; POP DE; EXX; LD B,9; EXX; HALT
  const { cpu, io, run } = machine([0x3e, 0x0e, 0xd3, 0xa0, 0x01, 0x22, 0x11, 0xc5, 0xd1, 0xd9, 0x06, 0x09, 0xd9, 0x76]);
  run();
  assert.deepEqual(io, [[0xa0, 0x0e]]);
  assert.equal(cpu.de, 0x1122);
  assert.equal(cpu.b, 0x11);
  assert.equal(cpu.b_, 0x09);
});

test('call()：サブルーチンを呼んで戻る', () => {
  const { cpu, mem } = machine([]);
  mem.set([0x3e, 0x42, 0xc9], 0x6010); // LD A,42h; RET
  assert.equal(cpu.call(0x6010, 0xfff0), true);
  assert.equal(cpu.a, 0x42);
});

test('CP/M：BDOS 9（文字列の表示）と 2（1文字）、終了', () => {
  // LD DE,msg; LD C,9; CALL 5; LD E,'!'; LD C,2; CALL 5; JP 0; msg: "HI$"
  const com = Uint8Array.from([0x11, 0x0f, 0x01, 0x0e, 0x09, 0xcd, 0x05, 0x00, 0x1e, 0x21, 0x0e, 0x02, 0xcd, 0x05, 0x00,
    0x48, 0x49, 0x24]);
  // JP 0 を msg の前に入れる
  const prog = Uint8Array.from([...com.subarray(0, 15), 0xc3, 0x00, 0x00, 0x48, 0x49, 0x24]);
  prog[1] = 0x12; // msg のアドレス 0x0112
  const r = new CpmMachine().run(prog);
  assert.equal(r.exited, true);
  assert.equal(r.output, 'HI!');
});

test('CP/M：ファイルを開いて読み、別のファイルに書く', () => {
  const cpm = new CpmMachine({ 'IN.TXT': new TextEncoder().encode('A'.repeat(130)) });
  // FCB1=IN.TXT を開く→1レコード読む→FCB2=OUT.TXT を作る→書く→閉じる→終了
  const prog = Uint8Array.from([
    0x11, 0x5c, 0x00, 0x0e, 0x0f, 0xcd, 0x05, 0x00, // open FCB1
    0x11, 0x5c, 0x00, 0x0e, 0x14, 0xcd, 0x05, 0x00, // read seq
    0x11, 0x6c, 0x00, 0x0e, 0x16, 0xcd, 0x05, 0x00, // make FCB2
    0x11, 0x6c, 0x00, 0x0e, 0x15, 0xcd, 0x05, 0x00, // write seq
    0x11, 0x6c, 0x00, 0x0e, 0x10, 0xcd, 0x05, 0x00, // close
    0xc3, 0x00, 0x00]);
  const r = cpm.run(prog, 'IN.TXT OUT.TXT');
  assert.equal(r.exited, true);
  const out = cpm.files.get('OUT.TXT');
  assert.equal(out.length, 128);
  assert.equal(out[0], 0x41);
});

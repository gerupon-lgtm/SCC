// MGSDRV を動かす枠の確認。本物の MGSDRV.COM の代わりに、同じ入口を持つ小さな偽物を使う
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { MgsdrvHost, MgsdrvError, MAX_SONG_SIZE } from '../src/mgs/mgsdrv-host.js';

/** 0x6000 に置かれる偽の MGSDRV（.COM の 0x0D バイト目からが 0x6000） */
function fakeDriver() {
  const img = new Uint8Array(0x2000);
  img.set([0xc3, 0x00, 0x61], 0x10); // 6010h: JP init
  img.set([0xc3, 0x10, 0x61], 0x16); // 6016h: JP play
  img.set([0xc3, 0x20, 0x61], 0x1f); // 601Fh: JP inter
  // init: LD IX,7000h; RET
  img.set([0xdd, 0x21, 0x00, 0x70, 0xc9], 0x100);
  // play: LD (7010h),DE; LD A,1; LD (IX+8),A; RET
  img.set([0xed, 0x53, 0x10, 0x70, 0x3e, 0x01, 0xdd, 0x77, 0x08, 0xc9], 0x110);
  // inter: LD A,(7020h); INC A; LD (7020h),A; LD (988Ah),A; LD A,7; OUT (A0h),A; LD A,38h; OUT (A1h),A; CALL 0093h; RET
  img.set([0x3a, 0x20, 0x70, 0x3c, 0x32, 0x20, 0x70, 0x32, 0x8a, 0x98,
    0x3e, 0x07, 0xd3, 0xa0, 0x3e, 0x38, 0xd3, 0xa1,
    0x3e, 0x08, 0x1e, 0x0f, 0xcd, 0x93, 0x00, 0xc9], 0x120);
  const com = new Uint8Array(0x0d + img.length);
  com.set(img, 0x0d);
  return com;
}

const song = () => { const s = new Uint8Array(64); s.set([0x4d, 0x47, 0x53]); return s; }; // "MGS"

test('初期化・演奏開始・1/60秒ごとの呼び出しで、SCC と PSG への書き込みが取り出せる', () => {
  const scc = [], psg = [];
  const host = new MgsdrvHost({ driver: fakeDriver(), onScc: (a, v) => scc.push([a, v]), onPsg: (r, v) => psg.push([r, v]) });
  host.load(song());
  assert.equal(host.mib, 0x7000);
  assert.equal(host.mem[0x7000], 1, '(IX+0)=1');
  assert.equal(host.mem[0x7010] | (host.mem[0x7011] << 8), 0x0200, '曲のアドレスが DE で渡る');
  assert.equal(host.playing, true);
  for (let i = 0; i < 3; i++) assert.equal(host.frame(), true);
  assert.deepEqual(scc, [[0x8a, 1], [0x8a, 2], [0x8a, 3]]);
  // OUT での書き込みと、BIOS（0x93 WRTPSG）経由の書き込みの両方
  assert.deepEqual(psg, [[7, 0x38], [8, 0x0f], [7, 0x38], [8, 0x0f], [7, 0x38], [8, 0x0f]]);
});

test('SCC を有効にする前の 0x9800 への書き込みは捨てる。0x8000〜0xBFFF には書けない', () => {
  const scc = [];
  const host = new MgsdrvHost({ driver: fakeDriver(), onScc: (a, v) => scc.push([a, v]) });
  host.load(song());
  host.sccEnabled = false;
  host.frame();
  assert.deepEqual(scc, []);
  assert.equal(host.mem[0x988a], 0);
});

test('間違ったデータは分かる言葉で止める', () => {
  assert.throws(() => new MgsdrvHost({ driver: new Uint8Array(4), onScc() {} }), MgsdrvError);
  const host = new MgsdrvHost({ driver: fakeDriver(), onScc() {} });
  assert.throws(() => host.load(new Uint8Array(64)), MgsdrvError);
  const big = new Uint8Array(MAX_SONG_SIZE + 1); big.set([0x4d, 0x47, 0x53]);
  assert.throws(() => host.load(big), MgsdrvError);
});

test('暴走しても止まる（初期化が戻らない）', () => {
  const com = fakeDriver();
  com.set([0x18, 0xfe], 0x0d + 0x100); // init: JR $（無限ループ）
  const host = new MgsdrvHost({ driver: com, onScc() {} });
  host.cpu.call = function (addr, sentinel) { return Object.getPrototypeOf(this).call.call(this, addr, sentinel, 10000); };
  assert.throws(() => host.load(song()), /初期化が終わりませんでした/);
});

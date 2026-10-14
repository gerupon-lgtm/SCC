// 本物の MGSC.COM・MGSDRV.COM での確認（T-108 案B）
// これらは配布の条件のためリポジトリに入れない。local/ に置いてあるときだけ動き、無ければ飛ばす
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { existsSync, readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { compileMml } from '../src/mgs/mgsc.js';
import { encodeSjisForCpm } from '../src/mgs/sjis.js';
import { MgsdrvHost, looksLikeMgsdrv, looksLikeMgsc } from '../src/mgs/mgsdrv-host.js';
import { SccFast } from '../src/core/scc-fast.js';
import { SccRegisters } from '../src/core/scc-registers.js';

const local = (name) => fileURLToPath(new URL(`../local/${name}`, import.meta.url));
const has = existsSync(local('MGSC.COM')) && existsSync(local('MGSDRV.COM'));
const skip = has ? false : 'local/ に MGSC.COM・MGSDRV.COM が無いので飛ばす';

// 著作権のない、短い自作の MML（SCC のトラック4・5）
const MML = `#opll_mode 1
#title { "test" }
@s00 = { 7f7f7f7f 7f7f7f7f 7f7f7f7f 7f7f7f7f 80808080 80808080 80808080 80808080 }
@e00 = { ,, f }
4 t120 @0 @e0 v15 o4 l4 cdefg
5 t120 @0 @e0 v15 o3 l2 c g
`;

test('Shift_JIS への変換：改行は CR+LF、半角カナと漢字、最後に 0x1A', () => {
  const { bytes, unknown } = encodeSjisForCpm('A\nｱ漢');
  assert.deepEqual([...bytes], [0x41, 0x0d, 0x0a, 0xb1, 0x8a, 0xbf, 0x1a]);
  assert.deepEqual(unknown, []);
  assert.deepEqual(encodeSjisForCpm('😀').unknown, ['😀']);
});

test('ファイルの見分け：本物の MGSDRV.COM・MGSC.COM は受け付け、取り違えや別のファイルは断る', { skip }, () => {
  const drv = new Uint8Array(readFileSync(local('MGSDRV.COM')));
  const mgsc = new Uint8Array(readFileSync(local('MGSC.COM')));
  assert.equal(looksLikeMgsdrv(drv), true, `MGSDRV.COM（${drv.length} バイト）`);
  assert.equal(looksLikeMgsc(mgsc), true, `MGSC.COM（${mgsc.length} バイト）`);
  assert.equal(looksLikeMgsdrv(mgsc), false);
  assert.equal(looksLikeMgsc(drv), false);
  assert.equal(looksLikeMgsdrv(new TextEncoder().encode('hello'.repeat(100))), false);
});

test('本物の MGSC で MML を変換できる', { skip }, () => {
  const { mgs, log } = compileMml(new Uint8Array(readFileSync(local('MGSC.COM'))), MML);
  assert.match(log, /Compile complete/);
  assert.equal(String.fromCharCode(...mgs.subarray(0, 3)), 'MGS');
});

test('MML の誤りは、MGSC のメッセージ付きで止まる', { skip }, () => {
  assert.throws(() => compileMml(new Uint8Array(readFileSync(local('MGSC.COM'))), '#opll_mode 1\n4 cde@@@xyz\n'), (e) => e.name === 'MgscError' && e.log.length > 0);
});

test('本物の MGSDRV で鳴らすと、トラック4は C4 から始まり、1拍（0.5秒）ごとに次の音へ', { skip }, () => {
  const { mgs } = compileMml(new Uint8Array(readFileSync(local('MGSC.COM'))), MML);
  const chip = new SccFast();
  const regs = new SccRegisters(chip);
  const host = new MgsdrvHost({ driver: new Uint8Array(readFileSync(local('MGSDRV.COM'))), onScc: (a, v) => regs.write(a, v) });
  host.load(mgs);
  const freqs = [];
  let soundingMid = false;
  for (let f = 0; f < 60 * 3; f++) {
    host.frame();
    if (f % 30 === 15) freqs.push(chip.snapshot().channels[0].frequency);
    if (f === 15) soundingMid = chip.snapshot().channels[0].key && chip.snapshot().channels[0].volume > 0;
  }
  // 1拍 = 30フレーム。4分音符 c d e f g → 周波数の値は下がっていく（音は高くなる）
  const perBeat = [0, 2, 4].map((i) => freqs[i]);
  assert.ok(perBeat[0] > perBeat[1] && perBeat[1] > perBeat[2], JSON.stringify(freqs));
  // C4 ≒ 261.6Hz → 3579545 / (32 × 261.6) − 1 ≒ 427（MGSDRV の音程表の値なので ±2 まで許す）
  assert.ok(Math.abs(freqs[0] - 427) <= 2, `C4 の値 ${freqs[0]}`);
  assert.ok(soundingMid, '1音目の途中で鳴っている');
  // 5音（2.5秒）で曲が終わり、3秒の時点では音量0
  assert.equal(chip.snapshot().channels[0].volume, 0);
});

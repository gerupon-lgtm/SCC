// 照合用の操作列を、固定のシードの乱数で作る（T-006）
// 形式：'W <addr> <value>'（16進）と 'T <n>'（nクロック進める）の行
// テストレジスタ（0xE0〜）は MVP では動きを再現しない【設計】ので書かない

/** @param {number} seed */
export function mulberry32(seed) {
  let a = seed >>> 0;
  return () => {
    a = (a + 0x6d2b79f5) >>> 0;
    let t = a;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

const hex = (n) => n.toString(16);

/**
 * @param {object} p
 * @param {number} p.seed
 * @param {number} p.steps 操作の数
 * @param {'random'|'low'} p.freqMode low：周波数を 0〜40 付近に寄せる（止まる境界と最速の周波数）
 * @returns {string[]}
 */
export function generateOps({ seed, steps, freqMode }) {
  const rnd = mulberry32(seed);
  const int = (n) => Math.floor(rnd() * n);
  const pick = (arr) => arr[int(arr.length)];
  const ops = [];
  for (let a = 0; a < 0x80; a++) ops.push(`W ${hex(a)} ${hex(int(256))}`);
  for (let s = 0; s < steps; s++) {
    const r = rnd();
    const mirror = rnd() < 0.2 ? 0x10 : 0;
    if (r < 0.25) {
      const ch = int(5);
      const hi = rnd() < 0.5;
      let v;
      if (freqMode === 'low') v = hi ? 0 : pick([0, 1, 7, 8, 9, 10, 11, 12, 20, 31, 40, int(41)]);
      else v = hi ? pick([0, 0xf, 0xff, int(16), int(256)]) : pick([0, 8, 9, 0xff, int(256)]);
      ops.push(`W ${hex(0x80 + mirror + ch * 2 + (hi ? 1 : 0))} ${hex(v)}`);
    } else if (r < 0.35) {
      ops.push(`W ${hex(0x8a + mirror + int(5))} ${hex(int(256))}`);
    } else if (r < 0.45) {
      ops.push(`W ${hex(0x8f + mirror)} ${hex(int(256))}`);
    } else if (r < 0.6) {
      ops.push(`W ${hex(int(0x80))} ${hex(int(256))}`);
    } else if (r < 0.62) {
      ops.push(`W ${hex(0xa0 + int(0x40))} ${hex(int(256))}`);
    } else {
      ops.push(`T ${rnd() < 0.9 ? 1 + int(300) : 1 + int(5000)}`);
    }
  }
  ops.push('T 1000');
  return ops;
}

/**
 * 1クロックごとの出力の列を、'値 回数' の行に縮める
 * @param {Iterable<number>} values
 * @returns {string}
 */
export function runLengthEncode(values) {
  const lines = [];
  let prev = null, count = 0;
  for (const v of values) {
    if (v === prev) { count++; continue; }
    if (count > 0) lines.push(`${prev} ${count}`);
    prev = v; count = 1;
  }
  if (count > 0) lines.push(`${prev} ${count}`);
  return lines.join('\n') + '\n';
}

/** @param {string} text @returns {Int32Array} */
export function runLengthDecode(text) {
  const pairs = text.trim().split('\n').map((l) => l.split(' ').map(Number));
  const total = pairs.reduce((s, [, n]) => s + n, 0);
  const out = new Int32Array(total);
  let i = 0;
  for (const [v, n] of pairs) { out.fill(v, i, i + n); i += n; }
  return out;
}

/** 照合に使う操作列の一覧（名前・シード・条件は固定） */
export const CASES = [
  { name: 'random-1', seed: 1, steps: 4000, freqMode: 'random' },
  { name: 'random-2', seed: 20261010, steps: 4000, freqMode: 'random' },
  { name: 'low-1', seed: 7, steps: 4000, freqMode: 'low' },
  { name: 'low-2', seed: 99, steps: 4000, freqMode: 'low' },
];

// PSG の照合用の操作列（T-110）。形式：'A <16進>'（アドレス）、'D <16進>'（データ）、'T <n>'（n tick）
import { mulberry32 } from './ops.js';

const hex = (n) => n.toString(16);

/**
 * @param {object} p
 * @param {number} p.seed
 * @param {number} p.steps
 * @param {'random'|'edge'} p.mode edge：周期を 0・1・2 など境界に寄せ、エンベロープを頻繁に変える
 */
export function generateAyOps({ seed, steps, mode }) {
  const rnd = mulberry32(seed);
  const int = (n) => Math.floor(rnd() * n);
  const pick = (a) => a[int(a.length)];
  const ops = [];
  const write = (r, v) => { ops.push(`A ${hex(r)}`, `D ${hex(v & 0xff)}`); };
  for (let r = 0; r < 14; r++) write(r, int(256));
  for (let s = 0; s < steps; s++) {
    const r = rnd();
    if (r < 0.15) { // 音の周期
      const ch = int(3);
      write(ch * 2, mode === 'edge' ? pick([0, 1, 2, 3, 0xff, int(256)]) : int(256));
      if (rnd() < 0.5) write(ch * 2 + 1, mode === 'edge' ? pick([0, 0, 1, 0x0f, 0xff]) : int(256));
    } else if (r < 0.22) { // ノイズ周期
      write(6, mode === 'edge' ? pick([0, 1, 2, 0x1f, 0xff]) : int(256));
    } else if (r < 0.32) { // 有効（トーン・ノイズ）
      write(7, int(256));
    } else if (r < 0.45) { // 音量（ビット4 はエンベロープを使う）
      write(8 + int(3), pick([int(16), 0x10, 0x1f, int(256)]));
    } else if (r < 0.52) { // エンベロープの周期
      write(11, mode === 'edge' ? pick([0, 1, 2, int(256)]) : int(256));
      write(12, mode === 'edge' ? pick([0, 0, 1]) : int(4));
    } else if (r < 0.6) { // エンベロープの形（書くたびに最初から）
      write(13, int(256));
    } else if (r < 0.62) { // 入出力ポートと、上位4ビットが0でないアドレス（以後の書き込みは無視される）
      ops.push(`A ${hex(pick([14, 15, 0x10 + int(16), 0xff]))}`, `D ${hex(int(256))}`);
    } else {
      ops.push(`T ${rnd() < 0.9 ? 1 + int(400) : 1 + int(20000)}`);
    }
  }
  ops.push('T 2000');
  return ops;
}

export const AY_CASES = [
  { name: 'ay-random-1', seed: 11, steps: 3000, mode: 'random' },
  { name: 'ay-random-2', seed: 20261015, steps: 3000, mode: 'random' },
  { name: 'ay-edge-1', seed: 13, steps: 3000, mode: 'edge' },
  { name: 'ay-edge-2', seed: 17, steps: 3000, mode: 'edge' },
];

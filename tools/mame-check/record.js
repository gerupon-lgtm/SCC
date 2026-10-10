// MAMEの出力を記録する（T-006 案A）
// 使い方：tools\mame-check\build.bat でプログラムを作ってから
//   node tools/mame-check/record.js
// tests/fixtures/mame/<名前>.ops と <名前>.out（'値 回数' の行）を書き出す
import { execFileSync } from 'node:child_process';
import { mkdirSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { CASES, generateOps, runLengthEncode } from './ops.js';

const HERE = fileURLToPath(new URL('.', import.meta.url));
const HARNESS = join(HERE, 'build', process.platform === 'win32' ? 'harness.exe' : 'harness');
const OUT_DIR = join(HERE, '..', '..', 'tests', 'fixtures', 'mame');

mkdirSync(OUT_DIR, { recursive: true });
for (const c of CASES) {
  const ops = generateOps(c).join('\n') + '\n';
  const raw = execFileSync(HARNESS, { input: ops, maxBuffer: 1 << 30, encoding: 'utf8' });
  const values = raw.trim().split('\n').map(Number);
  writeFileSync(join(OUT_DIR, `${c.name}.ops`), ops);
  writeFileSync(join(OUT_DIR, `${c.name}.out`), runLengthEncode(values));
  console.log(`${c.name}: ${ops.split('\n').length - 1} 命令、${values.length} クロック`);
}

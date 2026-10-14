// Z80 の再現を、検査プログラム ZEXDOC で確かめる（T-108 案B）
// 使い方：local/work/zexdoc.com を置いて node tools/zexdoc.js（PCで約4分）
// ZEXDOC は GPL のため、リポジトリには入れない
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { CpmMachine } from '../src/mgs/cpm.js';

const com = readFileSync(fileURLToPath(new URL('../local/work/zexdoc.com', import.meta.url)));
const t0 = Date.now();
const cpm = new CpmMachine();
const result = cpm.run(new Uint8Array(com), '', 50_000_000_000);
console.log(cpm.output);
console.log(`終了：${result.exited}、${((Date.now() - t0) / 1000).toFixed(0)} 秒`);

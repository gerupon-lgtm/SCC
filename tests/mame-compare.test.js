// T-006：基準版の出力が、MAMEの k051649.cpp の出力と1クロックも違わないこと
// MAMEの出力は tools/mame-check/record.js で記録したもの（tests/fixtures/mame/）
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { SccRef } from '../src/core/scc-ref.js';
import { SccRegisters } from '../src/core/scc-registers.js';
import { CASES, generateOps, runLengthDecode } from '../tools/mame-check/ops.js';

const FIXTURES = fileURLToPath(new URL('./fixtures/mame/', import.meta.url));

/** 操作列を基準版で実行し、1クロックごとの出力を返す */
function runRef(opsText) {
  const chip = new SccRef();
  const regs = new SccRegisters(chip);
  const out = [];
  for (const line of opsText.split('\n')) {
    if (line === '' || line[0] === '#') continue;
    const [op, a, b] = line.split(' ');
    if (op === 'W') regs.write(parseInt(a, 16), parseInt(b, 16));
    else for (let n = Number(a); n > 0; n--) out.push(chip.tick());
  }
  return out;
}

for (const c of CASES) {
  test(`MAMEと完全一致：${c.name}`, () => {
    const opsText = readFileSync(join(FIXTURES, `${c.name}.ops`), 'utf8');
    // 記録した操作列が、今のシードの生成と同じであること（生成の変更に気づくため）
    assert.equal(opsText, generateOps(c).join('\n') + '\n', '操作列が記録時と違います。record.js で記録し直してください');
    const expected = runLengthDecode(readFileSync(join(FIXTURES, `${c.name}.out`), 'utf8'));
    const actual = runRef(opsText);
    assert.equal(actual.length, expected.length, 'クロック数が違います');
    for (let i = 0; i < expected.length; i++) {
      if (actual[i] !== expected[i]) assert.fail(`${i} クロック目が違います：基準版 ${actual[i]}、MAME ${expected[i]}`);
    }
  });
}

test('照合が働く：1クロックだけ変えると失敗する', () => {
  const c = CASES[0];
  const expected = runLengthDecode(readFileSync(join(FIXTURES, `${c.name}.out`), 'utf8'));
  const actual = runRef(readFileSync(join(FIXTURES, `${c.name}.ops`), 'utf8'));
  actual[12345] += 1;
  assert.ok(actual.some((v, i) => v !== expected[i]));
});

// C-2・C-3 の検査：src/core/ が画面・音声・MIDI・通信のAPIを使っていないこと
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync, readdirSync } from 'node:fs';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { VERSION } from '../src/version.js';

const ROOT = fileURLToPath(new URL('..', import.meta.url));
const CORE = join(ROOT, 'src', 'core');

const FORBIDDEN = [
  'document', 'window', 'navigator', 'globalThis', 'self',
  'AudioContext', 'AudioWorklet', 'AudioWorkletProcessor', 'registerProcessor',
  'requestMIDIAccess', 'MIDIAccess',
  'fetch', 'XMLHttpRequest', 'WebSocket', 'EventSource', 'importScripts',
  'localStorage', 'sessionStorage', 'indexedDB',
  'postMessage', 'setTimeout', 'setInterval', 'console',
];

/** コメントと文字列を取り除いて、識別子だけを検査する */
function stripCommentsAndStrings(src) {
  return src
    .replace(/\/\*[\s\S]*?\*\//g, ' ')
    .replace(/\/\/.*$/gm, ' ')
    .replace(/`(?:\\[\s\S]|[^`\\])*`/g, '""')
    .replace(/'(?:\\.|[^'\\\n])*'/g, '""')
    .replace(/"(?:\\.|[^"\\\n])*"/g, '""');
}

/** @returns {string[]} 見つかった禁止語 */
export function findForbidden(src) {
  const code = stripCommentsAndStrings(src);
  return FORBIDDEN.filter((w) => new RegExp(`(?<![\\w$.])${w}(?![\\w$])`).test(code));
}

/** @returns {string[]} src/core 外への import */
export function findOutsideImports(src) {
  const out = [];
  for (const m of src.matchAll(/(?:import|export)[^'"]*from\s*['"]([^'"]+)['"]|import\s*\(\s*['"]([^'"]+)['"]/g)) {
    const spec = m[1] ?? m[2];
    if (!spec.startsWith('./')) out.push(spec);
  }
  return out;
}

test('src/core に禁止APIがない', () => {
  const files = readdirSync(CORE).filter((f) => f.endsWith('.js'));
  assert.ok(files.length > 0);
  for (const f of files) {
    const src = readFileSync(join(CORE, f), 'utf8');
    assert.deepEqual(findForbidden(src), [], `${f} に禁止APIがあります`);
    assert.deepEqual(findOutsideImports(src), [], `${f} が src/core の外を読み込んでいます`);
  }
});

test('鐘の部品（bell-voice.js）も、画面・音声のAPIを使わない（別のアプリへ切り出すため）', () => {
  const src = readFileSync(join(ROOT, 'src', 'bell', 'bell-voice.js'), 'utf8');
  assert.deepEqual(findForbidden(src), []);
  const imports = findOutsideImports(src).filter((s) => !s.startsWith('../core/'));
  assert.deepEqual(imports, [], 'src/core 以外を読み込んでいます');
});

test('MML 再生の部品（src/mgs）も、画面・音声・通信のAPIを使わない（AudioWorklet の中で動かすため）', () => {
  const dir = join(ROOT, 'src', 'mgs');
  for (const f of readdirSync(dir).filter((n) => n.endsWith('.js'))) {
    const src = readFileSync(join(dir, f), 'utf8');
    assert.deepEqual(findForbidden(src), [], `${f} に禁止APIがあります`);
  }
});

test('検査が働く：document や fetch を書くと見つかる', () => {
  assert.deepEqual(findForbidden('const x = document.body;'), ['document']);
  assert.deepEqual(findForbidden('await fetch(u)'), ['fetch']);
  assert.deepEqual(findForbidden('new AudioContext()'), ['AudioContext']);
  // コメント・文字列・プロパティ名は対象外
  assert.deepEqual(findForbidden('// document\nconst s = "fetch"; a.document = 1;'), []);
  assert.deepEqual(findOutsideImports("import { x } from '../ui/a.js';"), ['../ui/a.js']);
  assert.deepEqual(findOutsideImports("import { x } from './config.js';"), []);
});

test('index.html の CSP が外部通信を禁止している（C-3）', () => {
  const html = readFileSync(join(ROOT, 'index.html'), 'utf8');
  const m = html.match(/http-equiv="Content-Security-Policy"\s+content="([^"]+)"/);
  assert.ok(m, 'CSPがありません');
  assert.match(m[1], /connect-src 'none'/);
  assert.match(m[1], /default-src 'self'/);
  assert.doesNotMatch(m[1], /https?:/);
});

test('notice.html は NOTICE と同じ内容。CSP も同じく外部通信を禁止', () => {
  const html = readFileSync(join(ROOT, 'notice.html'), 'utf8');
  const notice = readFileSync(join(ROOT, 'NOTICE'), 'utf8');
  const m = html.match(/<pre id="notice">([\s\S]*?)<\/pre>/);
  assert.ok(m, 'notice.html に本文がありません');
  assert.equal(m[1], notice, 'notice.html を NOTICE に合わせてください');
  assert.match(html, /connect-src 'none'/);
});

test('各ページの app-version が VERSION と一致（公開時の版の食い違いを見つけるため）', () => {
  for (const page of ['index.html', 'bell.html']) {
    const html = readFileSync(join(ROOT, page), 'utf8');
    const m = html.match(/<meta name="app-version" content="([^"]+)">/);
    assert.ok(m, `${page} に app-version がありません`);
    assert.equal(m[1], VERSION, `${page} の app-version を ${VERSION} にしてください`);
  }
});

test('バージョンの形式と、NOTICE との一致', () => {
  assert.match(VERSION, /^0\.\d+\.\d+$/);
  const notice = readFileSync(join(ROOT, 'NOTICE'), 'utf8');
  assert.ok(notice.includes(`version ${VERSION}`), 'NOTICE のバージョンが違います');
});

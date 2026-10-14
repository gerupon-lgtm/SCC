// 文字列 → Shift_JIS（MGSC.COM が読む文字コード）。表は、ブラウザ・Node の TextDecoder("shift_jis") から作る
// 改行は CR+LF にし、最後に CP/M の終わりの印（0x1A）を付ける

let table = null;

function buildTable() {
  const dec = new TextDecoder('shift_jis');
  const map = new Map();
  for (let b = 0xa1; b <= 0xdf; b++) map.set(dec.decode(Uint8Array.of(b)), [b]); // 半角カナ
  const leads = [];
  for (let b = 0x81; b <= 0x9f; b++) leads.push(b);
  for (let b = 0xe0; b <= 0xfc; b++) leads.push(b);
  for (const lead of leads) {
    for (let trail = 0x40; trail <= 0xfc; trail++) {
      if (trail === 0x7f) continue;
      const ch = dec.decode(Uint8Array.of(lead, trail));
      if (ch.length === 1 && ch !== '�' && !map.has(ch)) map.set(ch, [lead, trail]);
    }
  }
  return map;
}

/**
 * @param {string} text
 * @returns {{ bytes: Uint8Array, unknown: string[] }} 表に無い文字は "?" にして unknown に入れる
 */
export function encodeSjisForCpm(text) {
  table ??= buildTable();
  const out = [];
  const unknown = [];
  const src = text.replace(/\r\n?/g, '\n');
  for (const ch of src) {
    const code = ch.codePointAt(0);
    if (ch === '\n') { out.push(0x0d, 0x0a); continue; }
    if (code < 0x80) { out.push(code); continue; }
    const b = table.get(ch);
    if (b) out.push(...b);
    else { out.push(0x3f); unknown.push(ch); }
  }
  out.push(0x1a);
  return { bytes: Uint8Array.from(out), unknown };
}

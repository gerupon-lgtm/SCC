// SMF（標準 MIDI ファイル）の読み取り（F-017、T-109）。Web MIDI・DOM に依存しない
// 形式0・1に対応。時間の単位は「4分音符あたりの tick 数」（division の最上位ビットが0）だけ（SMPTE 形式は断る）
// 返す出来事は src/midi/midi-parse.js と同じ形に、時刻（秒）を足したもの

export class SmfError extends Error {
  constructor(message) { super(message); this.name = 'SmfError'; }
}

/**
 * @typedef {import('./midi-parse.js').MidiEvent & { time: number }} TimedEvent
 */

/** @param {Uint8Array} b */
function reader(b) {
  let p = 0;
  return {
    get pos() { return p; },
    set pos(v) { p = v; },
    eof: () => p >= b.length,
    u8() { if (p >= b.length) throw new SmfError('ファイルが途中で終わっています'); return b[p++]; },
    u16() { return (this.u8() << 8) | this.u8(); },
    u32() { return ((this.u8() << 24) >>> 0) + (this.u8() << 16) + (this.u8() << 8) + this.u8(); },
    vlq() { // 可変長の数（最大4バイト）
      let v = 0;
      for (let i = 0; i < 4; i++) { const c = this.u8(); v = (v << 7) | (c & 0x7f); if (!(c & 0x80)) return v; }
      throw new SmfError('可変長の数が長すぎます');
    },
    tag() { return String.fromCharCode(this.u8(), this.u8(), this.u8(), this.u8()); },
  };
}

/** @param {Uint8Array} bytes */
export function isSmf(bytes) {
  return bytes.length >= 14 && String.fromCharCode(bytes[0], bytes[1], bytes[2], bytes[3]) === 'MThd';
}

/**
 * @param {Uint8Array} bytes
 * @returns {{ format: number, division: number, events: TimedEvent[], duration: number, title: string }}
 */
export function parseSmf(bytes) {
  if (!isSmf(bytes)) throw new SmfError('SMF（MIDI ファイル）ではありません');
  const r = reader(bytes);
  r.tag();
  const headerLen = r.u32();
  const format = r.u16();
  const ntrks = r.u16();
  const division = r.u16();
  r.pos = 8 + headerLen;
  if (format > 1) throw new SmfError(`形式${format}には対応していません（形式0・1だけ）`);
  if (division & 0x8000) throw new SmfError('SMPTE の時間単位には対応していません');
  if (division === 0) throw new SmfError('4分音符あたりの tick 数が0です');

  /** @type {{ tick: number, order: number, ev: any }[]} */
  const raw = [];
  /** @type {{ tick: number, usPerQuarter: number }[]} */
  const tempos = [];
  let title = '';
  let order = 0;
  for (let t = 0; t < ntrks && !r.eof(); t++) {
    const tag = r.tag();
    const len = r.u32();
    const end = r.pos + len;
    if (tag !== 'MTrk') { r.pos = end; t--; continue; } // 知らない塊は飛ばす
    let tick = 0;
    let running = 0;
    while (r.pos < end) {
      tick += r.vlq();
      let status = r.u8();
      if (status < 0x80) { // ランニングステータス
        if (!running) throw new SmfError('ランニングステータスの前にステータスがありません');
        r.pos--;
        status = running;
      }
      if (status === 0xff) { // メタイベント
        const type = r.u8();
        const n = r.vlq();
        const start = r.pos;
        if (type === 0x51 && n === 3) tempos.push({ tick, usPerQuarter: (bytes[start] << 16) | (bytes[start + 1] << 8) | bytes[start + 2] });
        if (type === 0x03 && !title && t === 0) title = new TextDecoder('shift_jis').decode(bytes.subarray(start, start + n)).trim();
        r.pos = start + n;
        if (type === 0x2f) break;
        continue;
      }
      if (status === 0xf0 || status === 0xf7) { r.pos += r.vlq(); running = 0; continue; } // システムエクスクルーシブは飛ばす
      running = status;
      const kind = status & 0xf0, channel = status & 0x0f;
      const d1 = r.u8();
      const d2 = (kind === 0xc0 || kind === 0xd0) ? 0 : r.u8();
      let ev = null;
      if (kind === 0x90) ev = d2 === 0 ? { type: 'noteOff', note: d1, channel } : { type: 'noteOn', note: d1, velocity: d2, channel };
      else if (kind === 0x80) ev = { type: 'noteOff', note: d1, channel };
      else if (kind === 0xb0) ev = { type: 'cc', controller: d1, value: d2, channel };
      else if (kind === 0xe0) ev = { type: 'pitchBend', value: ((d2 << 7) | d1) - 8192, channel };
      else if (kind === 0xc0) ev = { type: 'program', program: d1, channel };
      if (ev) raw.push({ tick, order: order++, ev });
    }
    r.pos = end;
  }

  // tick → 秒（テンポの変化をたどる。初期値は 120BPM = 500000µs）
  tempos.sort((a, b) => a.tick - b.tick);
  raw.sort((a, b) => a.tick - b.tick || a.order - b.order);
  const toSeconds = (() => {
    const pts = [{ tick: 0, sec: 0, us: 500000 }];
    for (const tp of tempos) {
      const last = pts[pts.length - 1];
      const sec = last.sec + ((tp.tick - last.tick) * last.us) / (division * 1e6);
      if (tp.tick === last.tick) { last.us = tp.usPerQuarter; } else pts.push({ tick: tp.tick, sec, us: tp.usPerQuarter });
    }
    return (tick) => {
      let i = pts.length - 1;
      while (i > 0 && pts[i].tick > tick) i--;
      return pts[i].sec + ((tick - pts[i].tick) * pts[i].us) / (division * 1e6);
    };
  })();
  const events = raw.map(({ tick, ev }) => ({ ...ev, time: toSeconds(tick) }));
  // 同じ時刻ではノートオフを先に（同じ音の連打を切らないため）
  events.sort((a, b) => a.time - b.time || (a.type === 'noteOff' ? -1 : 0) - (b.type === 'noteOff' ? -1 : 0));
  return { format, division, events, duration: events.length ? events[events.length - 1].time : 0, title };
}

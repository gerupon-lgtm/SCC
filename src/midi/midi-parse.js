// MIDIメッセージの解釈（Web MIDIに依存しない。Node.jsでテストする）
// MVPでは MIDIチャンネルを区別しない（OMNI）。docs/api-design.md 4章

/**
 * @typedef {{ type: 'noteOn', note: number, velocity: number, channel: number }
 *   | { type: 'noteOff', note: number, channel: number }
 *   | { type: 'cc', controller: number, value: number, channel: number }
 *   | { type: 'pitchBend', value: number, channel: number }
 *   | { type: 'program', program: number, channel: number }} MidiEvent
 * pitchBend の value は -8192〜8191
 */

/**
 * @param {ArrayLike<number>} data 1つのMIDIメッセージ
 * @returns {MidiEvent | null} 対応しないメッセージは null
 */
export function parseMidi(data) {
  if (!data || data.length < 1) return null;
  const status = data[0];
  if (status < 0x80 || status >= 0xf0) return null; // データバイトのみ・システムメッセージ
  const kind = status & 0xf0;
  const channel = status & 0x0f;
  const d1 = data[1], d2 = data[2];
  const valid = (v) => Number.isInteger(v) && v >= 0 && v <= 0x7f;
  switch (kind) {
    case 0x90:
      if (!valid(d1) || !valid(d2)) return null;
      // ベロシティ0のノートオンは、ノートオフとして扱う
      return d2 === 0 ? { type: 'noteOff', note: d1, channel } : { type: 'noteOn', note: d1, velocity: d2, channel };
    case 0x80:
      if (!valid(d1)) return null;
      return { type: 'noteOff', note: d1, channel };
    case 0xb0:
      if (!valid(d1) || !valid(d2)) return null;
      return { type: 'cc', controller: d1, value: d2, channel };
    case 0xe0:
      if (!valid(d1) || !valid(d2)) return null;
      return { type: 'pitchBend', value: ((d2 << 7) | d1) - 8192, channel };
    case 0xc0:
      if (!valid(d1)) return null;
      return { type: 'program', program: d1, channel };
    default:
      return null; // ポリフォニックキープレッシャー・チャンネルプレッシャーは対象外
  }
}

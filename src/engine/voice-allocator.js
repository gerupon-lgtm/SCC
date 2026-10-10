// 発音の割り当て（F-009）。発音数ベース：空いているチャンネルへ。空きがなければ一番古い音を止める（確定）

/** @typedef {{ ch: number, note: number, velocity: number, startedAt: number }} Voice */

export class VoiceAllocator {
  /** @param {number} channelCount */
  constructor(channelCount) {
    /** @type {(Voice | null)[]} */
    this.slots = new Array(channelCount).fill(null);
    this.seq = 0; // 発音の順番（同じ時刻でも古い順が決まるように）
  }

  /**
   * @param {number} note
   * @param {number} velocity
   * @returns {{ voice: Voice, stolen: Voice | null }}
   */
  noteOn(note, velocity) {
    // 同じ音が鳴っていれば、そのチャンネルで鳴らし直す（同音の連打で別チャンネルを使い切らない）
    let ch = this.slots.findIndex((v) => v !== null && v.note === note);
    let stolen = null;
    if (ch === -1) ch = this.slots.indexOf(null);
    if (ch === -1) {
      ch = 0;
      for (let i = 1; i < this.slots.length; i++) if (this.slots[i].startedAt < this.slots[ch].startedAt) ch = i;
      stolen = this.slots[ch];
    }
    const voice = { ch, note, velocity, startedAt: this.seq++ };
    this.slots[ch] = voice;
    return { voice, stolen };
  }

  /**
   * @param {number} note
   * @returns {Voice | null} 止めた音（鳴っていなければ null）
   */
  noteOff(note) {
    const ch = this.slots.findIndex((v) => v !== null && v.note === note);
    if (ch === -1) return null;
    const v = this.slots[ch];
    this.slots[ch] = null;
    return v;
  }

  /** @returns {Voice[]} 止めた音 */
  allOff() {
    const vs = this.active();
    this.slots.fill(null);
    return vs;
  }

  /** @returns {Voice[]} 発音中の音（チャンネル順） */
  active() {
    return this.slots.filter((v) => v !== null);
  }
}

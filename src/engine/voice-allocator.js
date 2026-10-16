// 発音の割り当て（F-009、F-015）。発音数ベース：空いているチャンネルへ。空きがなければ一番古い音を止める（確定）
// マルチティンバー：パートごとに同時発音の上限があり、超えたらそのパートの一番古い音を止める
// チャンネルが使えるかどうか（ch4・ch5 は波形を共有する、など）は、呼ぶ側が canUse で教える

/** @typedef {{ ch: number, note: number, velocity: number, part: number, startedAt: number }} Voice */

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
   * @param {object} [opts]
   * @param {number} [opts.part] パート（0始まり）
   * @param {number} [opts.partLimit] そのパートの同時発音の上限
   * @param {(ch: number) => boolean} [opts.canUse] そのチャンネルを使ってよいか
   * @returns {{ voice: Voice, stolen: Voice | null } | null} 使えるチャンネルが無ければ null
   */
  noteOn(note, velocity, { part = 0, partLimit = Infinity, canUse = () => true } = {}) {
    // 1. 同じパートで同じ音が鳴っていれば、そのチャンネルで鳴らし直す（同音の連打で使い切らない）
    let ch = this.slots.findIndex((v) => v !== null && v.note === note && v.part === part);
    let stolen = null;
    if (ch === -1) {
      const mine = this.slots.filter((v) => v !== null && v.part === part);
      if (mine.length >= partLimit) {
        // 2. パートの上限に達していれば、そのパートの一番古い音のチャンネルを使う
        const oldest = mine.reduce((a, b) => (b.startedAt < a.startedAt ? b : a));
        ch = oldest.ch;
        stolen = oldest;
      } else {
        // 3. 使える空きチャンネル。4. 無ければ、使えるチャンネルの中で一番古い音を止める
        ch = this.slots.findIndex((v, i) => v === null && canUse(i));
        if (ch === -1) {
          for (let i = 0; i < this.slots.length; i++) {
            if (!canUse(i)) continue;
            if (ch === -1 || this.slots[i].startedAt < this.slots[ch].startedAt) ch = i;
          }
          if (ch === -1) return null;
          stolen = this.slots[ch];
        }
      }
    }
    const voice = { ch, note, velocity, part, startedAt: this.seq++ };
    this.slots[ch] = voice;
    return { voice, stolen };
  }

  /**
   * @param {number} note
   * @param {number} [part]
   * @returns {Voice | null} 止めた音（鳴っていなければ null）
   */
  noteOff(note, part = 0) {
    const ch = this.slots.findIndex((v) => v !== null && v.note === note && v.part === part);
    if (ch === -1) return null;
    const v = this.slots[ch];
    this.slots[ch] = null;
    return v;
  }

  /**
   * @param {number} [part] 省略なら全パート
   * @returns {Voice[]} 止めた音
   */
  allOff(part) {
    const vs = this.active().filter((v) => part === undefined || v.part === part);
    for (const v of vs) this.slots[v.ch] = null;
    return vs;
  }

  /** @returns {Voice[]} 発音中の音（チャンネル順） */
  active() {
    return this.slots.filter((v) => v !== null);
  }
}

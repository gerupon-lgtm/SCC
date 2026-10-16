// MIDIの出来事 → SCCのレジスタ書き込み（docs/api-design.md 4章）
// 書き込み先は write(addr, value) を持つもの（AudioEngine か、テストでは SccExtRegisters）
// ch1〜5 は SCC互換のアドレス、ch6 以降は追加チャンネルのアドレス（src/core/scc-ext-registers.js）
//
// マルチティンバー（F-015、T-103）：MIDI チャンネル1〜8 がパート1〜8。パートの音色（波形）は画面で選ぶ
// （プログラムチェンジは使わない）。MIDI チャンネル10 は PSG の擬似ドラム（F-019）。ほかのチャンネルは鳴らさない
// 波形は、ノートオンのとき、そのチャンネルの波形バンクへパートの波形を書く（同じ波形が入っていれば書かない）
// SCC互換の ch4・ch5 は1つのバンクを共有するので、違う波形のパートを同時には鳴らせない（canUse で避ける）
import { SCC_COMPAT } from '../core/config.js';
import { PRESET_NAMES, getPreset } from '../core/presets.js';
import { COMPAT_CHANNELS, channelAddr, waveAddr } from '../core/scc-ext-registers.js';
import { VoiceAllocator } from './voice-allocator.js';
import { DRUM_ADDR, DRUM_STOP_ADDR } from './psg-drums.js';

/** 波形エディターの波形の名前 */
export const CUSTOM = 'custom';
/** パートの数（MIDI チャンネル1〜8） */
export const PART_COUNT = 8;
/** 打楽器の MIDI チャンネル（0始まりで9 = 10チャンネル目） */
export const DRUM_CHANNEL = 9;

/** SCC互換のキーのアドレス（ch1〜5 のビット） */
const COMPAT_KEY_ADDR = 0x8f;
const PITCH_BEND_RANGE = 2; // ±2半音【想定】

/**
 * MIDIのノート番号 → SCCの周波数の値（TP）
 * TP = round(clock / (32 f)) - 1、0〜4095 に丸める
 * @param {number} note 小数可（ピッチベンド込み）
 * @param {number} [clock]
 */
export function noteToPeriod(note, clock = SCC_COMPAT.clock) {
  const f = 440 * 2 ** ((note - 69) / 12);
  const tp = Math.round(clock / (32 * f)) - 1;
  return Math.min(4095, Math.max(0, tp));
}

/**
 * ベロシティ（と CC7）→ SCCの音量 0〜15。鳴らすときは最小1
 * @param {number} velocity 1〜127
 * @param {number} [cc7] 0〜127
 */
export function velocityToVolume(velocity, cc7 = 127) {
  if (velocity <= 0 || cc7 <= 0) return 0;
  return Math.max(1, Math.round((velocity / 127) * (cc7 / 127) * 15));
}

/** @typedef {{ waveName: string, cc7: number, bend: number }} Part */

export class Synth {
  /**
   * @param {{ write(addr: number, value: number): unknown }} sink
   * @param {object} [opts]
   * @param {import('../core/config.js').SccConfig} [opts.config] チャンネル数・波形バンク数・クロック
   * @param {(voices: import('./voice-allocator.js').Voice[]) => void} [opts.onVoices] 発音中の音が変わったとき
   * @param {boolean} [opts.drums] MIDI チャンネル10 を PSG のドラムとして sink へ書く（F-019）
   */
  constructor(sink, { config = SCC_COMPAT, onVoices = () => {}, drums = false } = {}) {
    this.sink = sink;
    this.clock = config.clock;
    this.channelCount = config.channelCount;
    this.waveBankCount = config.waveBankCount;
    this.channelBank = config.channelWaveBank;
    this.addr = Array.from({ length: this.channelCount }, (_, ch) => channelAddr(ch));
    this.onVoices = onVoices;
    this.drums = drums;
    this.voices = new VoiceAllocator(this.channelCount);
    this.keyMask = 0;
    /** @type {Part[]} */
    this.parts = Array.from({ length: PART_COUNT }, () => ({ waveName: PRESET_NAMES[0], cc7: 127, bend: 0 }));
    this.drumCc7 = 127;
    /** @type {Int8Array | null} 波形エディターで作った波形（F-007）。波形の名前が 'custom' のパートが使う */
    this.customWave = null;
    this.customVersion = 0;
    /** @type {(string | null)[]} 各バンクにいま入っている波形（null は不明） */
    this.bankKey = new Array(this.waveBankCount).fill(null);
  }

  /** パート1の波形の名前（画面の波形ボタン・鍵盤はパート1） */
  get waveName() { return this.parts[0].waveName; }
  set waveName(name) { this.parts[0].waveName = name; }

  /** 開始直後に呼ぶ：波形を書き、全チャンネルを無音にする */
  init() {
    this.bankKey.fill(null);
    this.voices.allOff();
    this.#refreshBanks();
    this.keyMask = 0;
    this.sink.write(COMPAT_KEY_ADDR, 0);
    for (let ch = 0; ch < this.channelCount; ch++) {
      this.sink.write(this.addr[ch].volume, 0);
      if (this.addr[ch].key !== null) this.sink.write(this.addr[ch].key, 0);
    }
    this.onVoices([]);
  }

  /** @param {import('../midi/midi-parse.js').MidiEvent} ev */
  handle(ev) {
    const channel = ev.channel ?? 0;
    if (channel === DRUM_CHANNEL) { this.#handleDrum(ev); return; }
    if (channel >= PART_COUNT) return;
    switch (ev.type) {
      case 'noteOn': this.noteOn(ev.note, ev.velocity, channel); break;
      case 'noteOff': this.noteOff(ev.note, channel); break;
      case 'pitchBend': this.setPitchBend(ev.value, channel); break;
      case 'cc':
        if (ev.controller === 7) this.setChannelVolume(ev.value, channel);
        else if (ev.controller === 123 || ev.controller === 120) this.allNotesOff(channel);
        break;
      default: break; // プログラムチェンジは使わない（音色は画面で選ぶ）
    }
  }

  /** @param {number} note @param {number} velocity @param {number} [part] */
  noteOn(note, velocity, part = 0) {
    if (velocity <= 0) { this.noteOff(note, part); return; }
    const p = this.parts[part];
    if (noteToPeriod(note + p.bend, this.clock) <= 8) return; // 止まる高さは鳴らさない
    const key = this.#waveKey(part);
    const r = this.voices.noteOn(note, velocity, { part, canUse: (ch) => this.#canUse(ch, key) });
    if (!r) return;
    const { voice, stolen } = r;
    if (stolen && stolen.ch === voice.ch) this.sink.write(this.addr[voice.ch].volume, 0);
    this.#ensureBank(this.channelBank[voice.ch], part);
    this.#writeFrequency(voice.ch, note, p.bend);
    this.sink.write(this.addr[voice.ch].volume, velocityToVolume(velocity, p.cc7));
    this.#setKey(voice.ch, true);
    this.onVoices(this.voices.active());
  }

  /** @param {number} note @param {number} [part] */
  noteOff(note, part = 0) {
    const v = this.voices.noteOff(note, part);
    if (!v) return;
    this.#silence(v.ch);
    this.onVoices(this.voices.active());
  }

  /** @param {number} [part] 省略なら全パートとドラム */
  allNotesOff(part) {
    for (const v of this.voices.allOff(part)) this.#silence(v.ch);
    if (part === undefined && this.drums) this.sink.write(DRUM_STOP_ADDR, 0);
    this.onVoices(this.voices.active());
  }

  /** 全パートの CC7・ピッチベンドを初めの値に戻す（曲の再生の始め） */
  resetControllers() {
    for (let part = 0; part < PART_COUNT; part++) {
      this.setPitchBend(0, part);
      this.setChannelVolume(127, part);
    }
    this.drumCc7 = 127;
  }

  /** @param {number} value -8192〜8191 @param {number} [part] */
  setPitchBend(value, part = 0) {
    const p = this.parts[part];
    p.bend = (value / 8192) * PITCH_BEND_RANGE;
    for (const v of this.voices.active()) if (v.part === part) this.#writeFrequency(v.ch, v.note, p.bend);
  }

  /** @param {number} value 0〜127 @param {number} [part] */
  setChannelVolume(value, part = 0) {
    this.parts[part].cc7 = value;
    for (const v of this.voices.active()) {
      if (v.part === part) this.sink.write(this.addr[v.ch].volume, velocityToVolume(v.velocity, value));
    }
  }

  /**
   * パートの波形を選ぶ（プリセットの名前か CUSTOM）
   * @param {string} name
   * @param {number} [part]
   */
  setWave(name, part = 0) {
    if (name !== CUSTOM) getPreset(name); // 不明な名前はここで断る
    this.parts[part].waveName = name;
    this.#refreshBanks();
  }

  /**
   * 波形エディターで作った波形にする（F-007）。CUSTOM を選んでいる全パートに効く
   * @param {ArrayLike<number>} wave 32個、-128〜127
   * @param {number} [part] このパートを CUSTOM にする
   */
  setWaveData(wave, part = 0) {
    this.customWave = Int8Array.from(wave);
    this.customVersion++;
    this.setWave(CUSTOM, part);
  }

  /** @returns {string[]} パートごとの波形の名前 */
  partWaves() {
    return this.parts.map((p) => p.waveName);
  }

  /** パートの波形を表す文字（同じなら、バンクを書き直さなくてよい） */
  #waveKey(part) {
    const name = this.parts[part].waveName;
    return name === CUSTOM ? `${CUSTOM}#${this.customVersion}` : name;
  }

  #waveData(part) {
    const name = this.parts[part].waveName;
    if (name === CUSTOM) return this.customWave ?? getPreset(PRESET_NAMES[0]);
    return getPreset(name);
  }

  /** バンクにパートの波形が入っていなければ書く */
  #ensureBank(bank, part) {
    const key = this.#waveKey(part);
    if (this.bankKey[bank] === key) return;
    const wave = this.#waveData(part);
    for (let i = 0; i < wave.length; i++) this.sink.write(waveAddr(bank, i), wave[i] & 0xff);
    this.bankKey[bank] = key;
  }

  /**
   * 波形が変わったとき：鳴っているバンクは、そこで鳴っている一番新しい音のパートの波形に、
   * 空いているバンクはパート1の波形にする（鍵盤をすぐ弾けるように）
   */
  #refreshBanks() {
    const owner = new Array(this.waveBankCount).fill(-1);
    const newest = new Array(this.waveBankCount).fill(-1);
    for (const v of this.voices.active()) {
      const b = this.channelBank[v.ch];
      if (v.startedAt > newest[b]) { newest[b] = v.startedAt; owner[b] = v.part; }
    }
    for (let b = 0; b < this.waveBankCount; b++) this.#ensureBank(b, owner[b] === -1 ? 0 : owner[b]);
  }

  /** チャンネル ch で、波形 key の音を鳴らしてよいか（バンクを共有する別チャンネルが、違う波形で鳴っていなければよい） */
  #canUse(ch, key) {
    const bank = this.channelBank[ch];
    for (let c = 0; c < this.channelCount; c++) {
      if (c === ch || this.channelBank[c] !== bank) continue;
      const v = this.voices.slots[c];
      if (v !== null && this.#waveKey(v.part) !== key) return false;
    }
    return true;
  }

  #handleDrum(ev) {
    if (!this.drums) return;
    if (ev.type === 'noteOn') {
      const v = Math.round((ev.velocity * this.drumCc7) / 127);
      if (v > 0) this.sink.write(DRUM_ADDR + (ev.note & 0x7f), v);
    } else if (ev.type === 'cc') {
      if (ev.controller === 7) this.drumCc7 = ev.value;
      else if (ev.controller === 123 || ev.controller === 120) this.sink.write(DRUM_STOP_ADDR, 0);
    }
    // ノートオフは使わない（ドラムは鳴らしたら自然に消える）
  }

  #writeFrequency(ch, note, bend) {
    const tp = noteToPeriod(note + bend, this.clock);
    this.sink.write(this.addr[ch].freqLo, tp & 0xff);
    this.sink.write(this.addr[ch].freqHi, tp >> 8);
  }

  #silence(ch) {
    this.sink.write(this.addr[ch].volume, 0);
    this.#setKey(ch, false);
  }

  #setKey(ch, on) {
    if (ch >= COMPAT_CHANNELS) { this.sink.write(this.addr[ch].key, on ? 1 : 0); return; }
    this.keyMask = on ? this.keyMask | (1 << ch) : this.keyMask & ~(1 << ch);
    this.sink.write(COMPAT_KEY_ADDR, this.keyMask);
  }
}

// MIDIの出来事 → SCCのレジスタ書き込み（docs/api-design.md 4章）
// 書き込み先は write(addr, value) を持つもの（AudioEngine か、テストでは SccRegisters）
import { SCC_COMPAT } from '../core/config.js';
import { PRESET_NAMES, getPreset } from '../core/presets.js';
import { VoiceAllocator } from './voice-allocator.js';

/** アドレス層が扱うチャンネル数（SCC互換） */
const REG_CHANNELS = 5;
const WAVE_REGION_COUNT = 4; // 0x00〜0x7F の 32バイト×4
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

export class Synth {
  /**
   * @param {{ write(addr: number, value: number): unknown }} sink
   * @param {object} [opts]
   * @param {number} [opts.clock]
   * @param {(voices: import('./voice-allocator.js').Voice[]) => void} [opts.onVoices] 発音中の音が変わったとき
   */
  constructor(sink, { clock = SCC_COMPAT.clock, onVoices = () => {} } = {}) {
    this.sink = sink;
    this.clock = clock;
    this.onVoices = onVoices;
    this.voices = new VoiceAllocator(REG_CHANNELS);
    this.keyMask = 0;
    this.bend = 0;      // 半音単位
    this.cc7 = 127;
    this.waveName = PRESET_NAMES[0];
  }

  /** 開始直後に呼ぶ：波形を書き、全チャンネルを無音にする */
  init() {
    this.setWave(this.waveName);
    this.keyMask = 0;
    this.sink.write(0x8f, 0);
    for (let ch = 0; ch < REG_CHANNELS; ch++) this.sink.write(0x8a + ch, 0);
    this.voices.allOff();
    this.onVoices([]);
  }

  /** @param {import('../midi/midi-parse.js').MidiEvent} ev */
  handle(ev) {
    switch (ev.type) {
      case 'noteOn': this.noteOn(ev.note, ev.velocity); break;
      case 'noteOff': this.noteOff(ev.note); break;
      case 'pitchBend': this.setPitchBend(ev.value); break;
      case 'program': this.setWave(PRESET_NAMES[ev.program % PRESET_NAMES.length]); break;
      case 'cc':
        if (ev.controller === 7) this.setChannelVolume(ev.value);
        else if (ev.controller === 123 || ev.controller === 120) this.allNotesOff();
        break;
      default: break;
    }
  }

  /** @param {number} note @param {number} velocity */
  noteOn(note, velocity) {
    if (velocity <= 0) { this.noteOff(note); return; }
    if (noteToPeriod(note + this.bend, this.clock) <= 8) return; // 止まる高さは鳴らさない
    const { voice } = this.voices.noteOn(note, velocity);
    this.#writeFrequency(voice.ch, note);
    this.sink.write(0x8a + voice.ch, velocityToVolume(velocity, this.cc7));
    this.#setKey(voice.ch, true);
    this.onVoices(this.voices.active());
  }

  /** @param {number} note */
  noteOff(note) {
    const v = this.voices.noteOff(note);
    if (!v) return;
    this.#silence(v.ch);
    this.onVoices(this.voices.active());
  }

  allNotesOff() {
    for (const v of this.voices.allOff()) this.#silence(v.ch);
    this.onVoices([]);
  }

  /** @param {number} value -8192〜8191 */
  setPitchBend(value) {
    this.bend = (value / 8192) * PITCH_BEND_RANGE;
    for (const v of this.voices.active()) this.#writeFrequency(v.ch, v.note);
  }

  /** @param {number} value 0〜127 */
  setChannelVolume(value) {
    this.cc7 = value;
    for (const v of this.voices.active()) this.sink.write(0x8a + v.ch, velocityToVolume(v.velocity, value));
  }

  /** プリセット波形を全バンクへ書く（MVPでは全チャンネル同じ音色） @param {string} name */
  setWave(name) {
    const wave = getPreset(name);
    this.waveName = name;
    for (let region = 0; region < WAVE_REGION_COUNT; region++) {
      for (let i = 0; i < wave.length; i++) this.sink.write(region * 32 + i, wave[i] & 0xff);
    }
  }

  #writeFrequency(ch, note) {
    const tp = noteToPeriod(note + this.bend, this.clock);
    this.sink.write(0x80 + ch * 2, tp & 0xff);
    this.sink.write(0x81 + ch * 2, tp >> 8);
  }

  #silence(ch) {
    this.sink.write(0x8a + ch, 0);
    this.#setKey(ch, false);
  }

  #setKey(ch, on) {
    this.keyMask = on ? this.keyMask | (1 << ch) : this.keyMask & ~(1 << ch);
    this.sink.write(0x8f, this.keyMask);
  }
}

// Web MIDI 入力（F-005）。機器の抜き差しは statechange を受けて再列挙する
import { parseMidi } from './midi-parse.js';

/** @typedef {'unsupported'|'denied'|'noDevice'|'ready'} MidiState */

export class MidiInput {
  /**
   * @param {object} opts
   * @param {(ev: import('./midi-parse.js').MidiEvent) => void} opts.onEvent
   * @param {(state: MidiState, deviceNames: string[]) => void} opts.onState
   * @param {() => void} [opts.onDisconnect] 機器が抜かれたとき（鳴っている音を止めるため）
   * @param {Navigator} [opts.nav] テスト用
   */
  constructor({ onEvent, onState, onDisconnect = () => {}, nav = globalThis.navigator }) {
    this.onEvent = onEvent;
    this.onState = onState;
    this.onDisconnect = onDisconnect;
    this.nav = nav;
    /** @type {MIDIAccess | null} */
    this.access = null;
    /** @type {MidiState | null} */
    this.state = null;
    /** @type {Set<string>} */
    this.connectedIds = new Set();
  }

  /** 許可を求めて入力を開く。何度呼んでもよい（拒否の後の再試行にも使う） */
  async start() {
    if (this.access) { this.#refresh(); return this.state; }
    if (typeof this.nav?.requestMIDIAccess !== 'function') return this.#set('unsupported');
    try {
      this.access = await this.nav.requestMIDIAccess({ sysex: false });
    } catch {
      return this.#set('denied');
    }
    this.access.onstatechange = () => this.#refresh();
    this.#refresh();
    return this.state;
  }

  #refresh() {
    const names = [];
    const ids = new Set();
    for (const input of this.access.inputs.values()) {
      if (input.state === 'disconnected') continue;
      ids.add(input.id);
      names.push(input.name || input.id);
      input.onmidimessage = (e) => {
        const ev = parseMidi(e.data);
        if (ev) this.onEvent(ev);
      };
    }
    const lost = [...this.connectedIds].some((id) => !ids.has(id));
    this.connectedIds = ids;
    if (lost) this.onDisconnect();
    this.#set(names.length > 0 ? 'ready' : 'noDevice', names);
  }

  /** @param {MidiState} state @param {string[]} [names] */
  #set(state, names = []) {
    this.state = state;
    this.onState(state, names);
    return state;
  }
}

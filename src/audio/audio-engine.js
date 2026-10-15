// 音声エンジン（メイン側）。AudioContext の開始・停止と、Worklet へのメッセージ
// 「音を出す」ボタンの操作の後にだけ開始する（CLAUDE.md 変更禁止事項6）
import { SCC_COMPAT, SccError } from '../core/config.js';

const WORKLET_URL = new URL('./scc-worklet.js', import.meta.url);

export class AudioEngine {
  /**
   * @param {object} [opts]
   * @param {import('../core/config.js').SccConfig} [opts.config]
   * @param {(msg: any) => void} [opts.onState] Worklet からの状態
   * @param {(code: string, message?: string) => void} [opts.onError]
   * @param {(state: 'playing' | 'stopped') => void} [opts.onSong] 曲の再生の状態（F-016）
   */
  constructor({ config = SCC_COMPAT, onState = () => {}, onError = () => {}, onSong = () => {} } = {}) {
    this.config = config;
    this.onState = onState;
    this.onError = onError;
    this.onSong = onSong;
    /** @type {AudioContext | null} */
    this.ctx = null;
    /** @type {AudioWorkletNode | null} */
    this.node = null;
    /** @type {Promise<void> | null} */
    this.starting = null;
    /** @type {{addr: number, value: number}[]} */
    this.pending = [];
    this.flushScheduled = false;
    this.master = undefined;
    /** @type {number | null} 書き込みに付ける「鳴らす時刻」（F-017） */
    this.scheduleTime = null;
  }

  get running() {
    return this.node !== null;
  }

  /** 開始する。二度押しでは同じ処理を待つだけ */
  start() {
    if (this.running) return Promise.resolve();
    if (!this.starting) {
      this.starting = this.#start().finally(() => { this.starting = null; });
    }
    return this.starting;
  }

  async #start() {
    // AudioWorklet は https か localhost でしか使えない（ブラウザの決まり）
    if (globalThis.isSecureContext === false) {
      throw new SccError('E_INSECURE_CONTEXT', '安全な接続（https か localhost）で開いてください');
    }
    const AC = globalThis.AudioContext ?? globalThis.webkitAudioContext;
    if (!AC) throw new SccError('E_NO_WORKLET', 'Web Audio が使えません');
    const ctx = new AC({ latencyHint: 'interactive' });
    try {
      if (!ctx.audioWorklet) throw new SccError('E_NO_WORKLET', 'AudioWorklet が使えません');
      await ctx.audioWorklet.addModule(WORKLET_URL);
      const node = new AudioWorkletNode(ctx, 'scc-processor', {
        numberOfInputs: 0,
        numberOfOutputs: 1,
        outputChannelCount: [2],
        processorOptions: { config: this.config },
      });
      node.port.onmessage = (e) => this.#onMessage(e.data);
      node.connect(ctx.destination);
      if (this.master !== undefined) node.port.postMessage({ type: 'master', gain: this.master });
      if (ctx.state !== 'running') await ctx.resume();
      this.ctx = ctx;
      this.node = node;
    } catch (e) {
      await ctx.close().catch(() => {});
      if (e instanceof SccError) throw e;
      throw new SccError('E_NO_WORKLET', String(e?.message ?? e));
    }
  }

  /** 止める。開始前の状態に戻る */
  async stop() {
    if (this.starting) await this.starting.catch(() => {});
    const ctx = this.ctx;
    this.node?.disconnect();
    this.node = null;
    this.ctx = null;
    this.pending.length = 0;
    if (ctx) await ctx.close().catch(() => {});
  }

  /**
   * レジスタへの書き込み。同じ処理の中の書き込みは1つのメッセージにまとめ、順序を保つ
   * 開始前は捨てる（戻り値 false）
   * @param {number} addr
   * @param {number} value
   */
  write(addr, value) {
    if (!this.node) return false;
    // SMF の再生中は「鳴らす時刻」を付けて先渡しする（F-017）。Worklet がその時刻の区切りで当てる
    this.pending.push(this.scheduleTime === null ? { addr, value } : { addr, value, at: this.scheduleTime });
    if (!this.flushScheduled) {
      this.flushScheduled = true;
      queueMicrotask(() => this.flush());
    }
    return true;
  }

  flush() {
    this.flushScheduled = false;
    if (!this.node || this.pending.length === 0) return;
    this.node.port.postMessage({ type: 'reg', writes: this.pending });
    this.pending = [];
  }

  /** @param {number} gain 0〜1 */
  setMaster(gain) {
    this.master = gain;
    this.node?.port.postMessage({ type: 'master', gain });
  }

  /**
   * 曲を再生する（本物の MGSDRV を Worklet の中の Z80 で動かす。F-016）
   * @param {Uint8Array} driver MGSDRV.COM
   * @param {Uint8Array} mgs 曲（MGS 形式）
   */
  playSong(driver, mgs) {
    if (!this.node) return false;
    this.node.port.postMessage({ type: 'song', driver, mgs });
    return true;
  }

  stopSong() {
    this.node?.port.postMessage({ type: 'songStop' });
  }

  /**
   * 以後の write() に付ける「鳴らす時刻」（AudioContext の時刻、秒）。null で、すぐ鳴らす
   * @param {number | null} t
   */
  setScheduleTime(t) {
    this.scheduleTime = t;
  }

  /** 音声の時計（AudioContext の時刻、秒）。止まっているときは 0 */
  now() {
    return this.ctx ? this.ctx.currentTime : 0;
  }

  /** 先渡しした、まだ鳴らしていない書き込みを捨てる */
  clearScheduled() {
    this.flush();
    this.node?.port.postMessage({ type: 'clearTimed' });
  }

  /** 画面表示用の状態を頼む（返事は onState） */
  poll() {
    this.node?.port.postMessage({ type: 'poll' });
  }

  #onMessage(msg) {
    if (msg?.type === 'state') this.onState(msg);
    else if (msg?.type === 'song') this.onSong(msg.state);
    else if (msg?.type === 'error') this.onError(msg.code, msg.message);
  }
}

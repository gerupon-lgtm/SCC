// AudioWorklet 側（F-004）。レジスタ層 → 高速版 → 変換 → 後処理 → 音
// メッセージは docs/api-design.md 3章。process() の中ではオブジェクトを作らない（CLAUDE.md 変更禁止事項5）
import { SCC_COMPAT, validateConfig } from '../core/config.js';
import { SccFast } from '../core/scc-fast.js';
import { SccRef } from '../core/scc-ref.js';
import { SccExtRegisters } from '../core/scc-ext-registers.js';
import { WindowConverter } from '../core/window-converter.js';
import { PostStage } from '../core/post-stage.js';
import { MgsdrvHost } from '../mgs/mgsdrv-host.js';
import { PsgStage } from '../core/psg-stage.js';

/** MGSDRV を呼ぶ回数（1秒あたり）。MSXplay（libkss）と同じ60【想定】 */
const DRIVER_HZ = 60;

/** 処理の重さがこれを超えたら、音切れの疑いとして知らせる【設計】 */
const LOAD_WARN = 0.9;

class SccProcessor extends AudioWorkletProcessor {
  constructor(options) {
    super();
    const opts = options?.processorOptions ?? {};
    this.useRef = opts.useRef === true; // 高速版が間に合わないときだけ基準版【想定】
    this.rate = Math.round(sampleRate);
    try {
      this.#build(opts.config ?? SCC_COMPAT);
    } catch (e) {
      this.#build(SCC_COMPAT);
      this.port.postMessage({ type: 'error', code: e.code ?? 'E_CONFIG', message: String(e.message) });
    }
    // 処理の重さの測定（Date.now はミリ秒単位なので、多数のブロックの平均で見る）
    this.busyMs = 0;
    this.frames = 0;
    // 曲の再生（F-016）：本物の MGSDRV を Z80 の上で動かす
    /** @type {MgsdrvHost | null} */
    this.song = null;
    this.psg = new PsgStage(); // PSG（F-018）。曲の再生中だけ鳴らす
    this.songFrame = 0;     // 何回目の 1/60 秒か
    this.toNextFrame = 0;   // 次に MGSDRV を呼ぶまでのサンプル数
    this.onScc = (addr, value) => this.regs.write(addr, value);
    this.port.onmessage = (e) => this.#onMessage(e.data);
  }

  #startSong(driver, mgs) {
    try {
      this.psg.reset();
      const host = new MgsdrvHost({ driver, onScc: this.onScc, psg: this.psg.psg });
      host.load(mgs);
      this.song = host;
      this.songFrame = 0;
      this.toNextFrame = 0;
      this.port.postMessage({ type: 'song', state: 'playing' });
    } catch (e) {
      this.song = null;
      this.port.postMessage({ type: 'error', code: 'E_SONG', message: String(e.message) });
    }
  }

  #stopSong() {
    this.song = null;
    this.psg.reset();
    for (let ch = 0; ch < 5; ch++) this.regs.write(0x8a + ch, 0);
    this.regs.write(0x8f, 0);
    this.port.postMessage({ type: 'song', state: 'stopped' });
  }

  #build(config) {
    const cfg = validateConfig(config);
    this.chip = this.useRef ? new SccRef(cfg) : new SccFast(cfg);
    this.regs = new SccExtRegisters(this.chip); // ch1〜5 は SCC互換、ch6 以降は追加チャンネルのアドレス
    this.conv = new WindowConverter(cfg.clock, this.rate);
    const master = this.post?.target;
    this.post = new PostStage(this.rate, cfg.channelCount);
    if (master !== undefined) this.post.setMaster(master);
    this.post.clear();
  }

  #onMessage(msg) {
    switch (msg?.type) {
      case 'reg':
        if (Array.isArray(msg.writes)) for (const w of msg.writes) this.regs.write(w.addr, w.value);
        else this.regs.write(msg.addr, msg.value);
        break;
      case 'master':
        this.post.setMaster(msg.gain);
        break;
      case 'config':
        try {
          this.#build(msg.config);
        } catch (e) {
          this.port.postMessage({ type: 'error', code: e.code ?? 'E_CONFIG', message: String(e.message) });
        }
        break;
      case 'song':
        this.#startSong(msg.driver, msg.mgs);
        break;
      case 'songStop':
        this.#stopSong();
        break;
      case 'poll': // 画面表示用の状態（メイン側が約30回/秒で頼む）
        this.#sendState();
        break;
      default:
        break;
    }
  }

  #sendState() {
    const s = this.chip.snapshot();
    const banks = this.chip.config.channelWaveBank;
    const load = this.frames > 0 ? (this.busyMs / 1000) / (this.frames / this.rate) : 0;
    this.port.postMessage({
      type: 'state',
      channels: s.channels.map((c, i) => ({ frequency: c.frequency, volume: c.volume, key: c.key, waveBank: banks[i] })),
      peak: this.post.takePeak(),
      load,
      song: this.song ? { playing: this.song.playing, loop: this.song.loopCount, seconds: this.songFrame / DRIVER_HZ } : null,
    });
    if (load > LOAD_WARN) this.port.postMessage({ type: 'error', code: 'E_AUDIO_UNDERRUN' });
    this.busyMs = 0;
    this.frames = 0;
  }

  /** 曲の再生中：1/60 秒の区切りの位置で MGSDRV を呼び、その間を音にする（オブジェクトを作らない） */
  #renderSong(buf) {
    let i = 0;
    while (i < buf.length) {
      if (this.toNextFrame <= 0) {
        if (!this.song.frame()) {
          this.song = null;
          this.port.postMessage({ type: 'error', code: 'E_SONG', message: 'MGSDRV が止まりませんでした' });
          this.conv.render(this.chip, buf, i, buf.length, this.psg);
          return;
        }
        this.songFrame++;
        // 1/60 秒のサンプル数を、ずれが積み重ならないよう整数で配る（48,000Hzなら毎回800）
        this.toNextFrame += Math.floor((this.songFrame * this.rate) / DRIVER_HZ) - Math.floor(((this.songFrame - 1) * this.rate) / DRIVER_HZ);
      }
      const n = Math.min(buf.length - i, this.toNextFrame);
      this.conv.render(this.chip, buf, i, i + n, this.psg);
      i += n;
      this.toNextFrame -= n;
    }
  }

  process(_inputs, outputs) {
    const t0 = Date.now();
    const out = outputs[0];
    const left = out[0];
    if (left) {
      if (this.song) this.#renderSong(left);
      else this.conv.render(this.chip, left);
      this.post.process(left);
      for (let c = 1; c < out.length; c++) out[c].set(left);
      this.frames += left.length;
    }
    this.busyMs += Date.now() - t0;
    return true;
  }
}

registerProcessor('scc-processor', SccProcessor);

// AudioWorklet 側（F-004）。レジスタ層 → 高速版 → 変換 → 後処理 → 音
// メッセージは docs/api-design.md 3章。process() の中ではオブジェクトを作らない（CLAUDE.md 変更禁止事項5）
import { SCC_COMPAT, validateConfig } from '../core/config.js';
import { SccFast } from '../core/scc-fast.js';
import { SccRef } from '../core/scc-ref.js';
import { SccRegisters } from '../core/scc-registers.js';
import { WindowConverter } from '../core/window-converter.js';
import { PostStage } from '../core/post-stage.js';

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
    this.port.onmessage = (e) => this.#onMessage(e.data);
  }

  #build(config) {
    const cfg = validateConfig(config);
    this.chip = this.useRef ? new SccRef(cfg) : new SccFast(cfg);
    this.regs = new SccRegisters(this.chip);
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
    });
    if (load > LOAD_WARN) this.port.postMessage({ type: 'error', code: 'E_AUDIO_UNDERRUN' });
    this.busyMs = 0;
    this.frames = 0;
  }

  process(_inputs, outputs) {
    const t0 = Date.now();
    const out = outputs[0];
    const left = out[0];
    if (left) {
      this.conv.render(this.chip, left);
      this.post.process(left);
      for (let c = 1; c < out.length; c++) out[c].set(left);
      this.frames += left.length;
    }
    this.busyMs += Date.now() - t0;
    return true;
  }
}

registerProcessor('scc-processor', SccProcessor);

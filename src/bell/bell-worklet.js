// 鐘の試作用の AudioWorklet。レジスタ層 → 高速版 → 変換 → 後処理、に鐘の音量の時間変化を足したもの
// process() の中ではオブジェクトを作らない
import { SCC_COMPAT } from '../core/config.js';
import { SccFast } from '../core/scc-fast.js';
import { SccRegisters } from '../core/scc-registers.js';
import { WindowConverter } from '../core/window-converter.js';
import { PostStage } from '../core/post-stage.js';
import { BellVoice, BELL_PRESETS } from './bell-voice.js';

class BellProcessor extends AudioWorkletProcessor {
  constructor() {
    super();
    const rate = Math.round(sampleRate);
    this.chip = new SccFast(SCC_COMPAT);
    this.regs = new SccRegisters(this.chip);
    this.conv = new WindowConverter(SCC_COMPAT.clock, rate);
    this.post = new PostStage(rate, SCC_COMPAT.channelCount);
    this.bell = new BellVoice(this.regs, SCC_COMPAT.clock);
    this.bell.setParams(BELL_PRESETS.small.params);
    this.bell.stop();
    this.port.onmessage = (e) => this.#onMessage(e.data);
  }

  #onMessage(msg) {
    switch (msg?.type) {
      case 'params': this.bell.setParams(msg.params); break;
      case 'strike': this.bell.strike(msg.note, msg.velocity ?? 1); break;
      case 'stop': this.bell.stop(); break;
      case 'master': this.post.setMaster(msg.gain); break;
      case 'poll': {
        const s = this.chip.snapshot();
        this.port.postMessage({
          type: 'state',
          channels: s.channels.map((c) => ({ frequency: c.frequency, volume: c.volume, key: c.key })),
          peak: this.post.takePeak(),
        });
        break;
      }
      default: break;
    }
  }

  process(_inputs, outputs) {
    const out = outputs[0];
    const left = out[0];
    if (left) {
      this.bell.advance(left.length / sampleRate);
      this.conv.render(this.chip, left);
      this.post.process(left);
      for (let c = 1; c < out.length; c++) out[c].set(left);
    }
    return true;
  }
}

registerProcessor('bell-processor', BellProcessor);

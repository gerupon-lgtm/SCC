// PSG を音声のサンプルへ直す（F-018、T-110）
// SCC と同じ「1サンプルに入るクロック数 L」を使い、PSG の tick（SCC の16クロックごと）をその中で数えて平均する
// 無音（全チャンネル音量0）のときに0になるよう、表の無音の値を引く
import { PsgRef, PSG_TABLE, SCC_CLOCKS_PER_PSG_TICK } from './psg-ref.js';

/** 3チャンネル全部が音量0のときの値（無音の基準） */
const SILENT = PSG_TABLE[0];

/**
 * SCC との音量の釣り合い【想定：MSXplay（libkss）と同じ】
 * libkss では、音量最大の矩形波の振れ幅が PSG 1チャンネルで 4080、SCC 1チャンネルで約3810。
 * このアプリの SCC 1チャンネルの振れ幅は (127×15>>4)×2÷1024 ≒ 0.2324。PSG の1チャンネルの振れ幅（表の段階15と0の差）を、
 * その 4080÷3810 倍にそろえる。実機の釣り合いは機種によって違う（未確認）
 */
const SCC_SQUARE_PP = (((127 * 15) >> 4) * 2) / 1024;
const PSG_SQUARE_PP = PSG_TABLE[15] - PSG_TABLE[0];
export const PSG_GAIN = (SCC_SQUARE_PP * (4080 / 3810)) / PSG_SQUARE_PP;

export class PsgStage {
  constructor() {
    this.psg = new PsgRef();
    this.phase = 0; // SCC のクロックのうち、まだ PSG の tick にならない分（0〜15）
    this.last = 0;
  }

  /**
   * 1音声サンプルぶん PSG を進め、出力（SCC と足せる大きさ）を返す。オブジェクトを作らない
   * @param {number} L このサンプルに入る SCC のクロック数
   */
  sample(L) {
    this.phase += L;
    const n = Math.floor(this.phase / SCC_CLOCKS_PER_PSG_TICK);
    this.phase -= n * SCC_CLOCKS_PER_PSG_TICK;
    if (n > 0) this.last = (this.psg.sumTicks(n) / n - SILENT) * PSG_GAIN;
    return this.last;
  }

  reset() {
    this.psg.reset();
    this.phase = 0;
    this.last = 0;
  }
}

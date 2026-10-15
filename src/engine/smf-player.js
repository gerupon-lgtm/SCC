// SMF の再生（F-017、T-109）。読み取った出来事を、F-009 と同じ割り当て（Synth）で鳴らす
// タイミング：画面側のタイマーで少し先（lookahead）までの出来事を処理し、その書き込みに「鳴らす時刻」を付けて
// AudioWorklet へ先渡しする（AudioEngine.setScheduleTime）。Worklet は 128 サンプル（約2.7ミリ秒）の区切りで当てる
//
// マルチティンバー（F-015）が無いので、全パートが同じ音色で鳴る。次は鳴らさない【設計】
//   - 10チャンネル目（打楽器。音程のある音として鳴ってしまうため）
//   - プログラムチェンジ（全体の音色が曲の途中で次々に変わってしまうため）
//   - ピッチベンド（全体にかかってしまうため）
// CC7（音量）は、パートごとに覚えてベロシティに掛ける

const DRUM_CHANNEL = 9;

export class SmfPlayer {
  /**
   * @param {object} deps
   * @param {import('./synth.js').Synth} deps.synth
   * @param {{ setScheduleTime(t: number | null): void, now(): number }} deps.clock 音声の時計（AudioContext の時刻）と、書き込みの時刻の付け方
   * @param {() => void} [deps.onEnd] 最後まで鳴り終わったとき
   * @param {number} [deps.lookahead] 何秒先まで先渡しするか
   * @param {number} [deps.interval] 何ミリ秒ごとに見るか
   */
  constructor({ synth, clock, onEnd = () => {}, lookahead = 0.15, interval = 25 }) {
    this.synth = synth;
    this.clock = clock;
    this.onEnd = onEnd;
    this.lookahead = lookahead;
    this.interval = interval;
    /** @type {import('../midi/smf.js').TimedEvent[]} */
    this.events = [];
    this.duration = 0;
    this.index = 0;
    this.startTime = 0;
    this.timer = 0;
    this.cc7 = new Uint8Array(16).fill(127);
    this.playing = false;
  }

  /** @param {{ events: import('../midi/smf.js').TimedEvent[], duration: number }} song */
  load(song) {
    this.stop();
    this.events = song.events;
    this.duration = song.duration;
  }

  play() {
    this.stop();
    this.index = 0;
    this.cc7.fill(127);
    this.startTime = this.clock.now() + 0.1;
    this.playing = true;
    this.timer = setInterval(() => this.pump(), this.interval);
    this.pump();
  }

  /** 今から lookahead 秒先までの出来事を、時刻を付けて処理する */
  pump() {
    if (!this.playing) return;
    const t = this.clock.now() - this.startTime;
    while (this.index < this.events.length && this.events[this.index].time <= t + this.lookahead) {
      const ev = this.events[this.index++];
      this.clock.setScheduleTime(this.startTime + ev.time);
      this.#handle(ev);
    }
    this.clock.setScheduleTime(null);
    if (this.index >= this.events.length && t > this.duration + 0.3) {
      this.stop();
      this.onEnd();
    }
  }

  /** 再生している位置（秒） */
  get position() {
    return this.playing ? Math.max(0, Math.min(this.duration, this.clock.now() - this.startTime)) : 0;
  }

  stop() {
    clearInterval(this.timer);
    this.timer = 0;
    if (this.playing) this.synth.allNotesOff();
    this.playing = false;
  }

  #handle(ev) {
    if (ev.channel === DRUM_CHANNEL) return;
    switch (ev.type) {
      case 'noteOn': {
        const v = Math.round((ev.velocity * this.cc7[ev.channel]) / 127);
        if (v > 0) this.synth.noteOn(ev.note, v); else this.synth.noteOff(ev.note);
        break;
      }
      case 'noteOff': this.synth.noteOff(ev.note); break;
      case 'cc':
        if (ev.controller === 7) this.cc7[ev.channel] = ev.value;
        else if (ev.controller === 120 || ev.controller === 123) this.synth.allNotesOff();
        break;
      default: break;
    }
  }
}

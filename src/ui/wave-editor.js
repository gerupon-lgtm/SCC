// 画面：波形エディター（F-007、T-101）。32点を指・マウスでなぞって描く
// 描いている間も、変わるたびに onChange で知らせる（約16ミリ秒ごとに間引く）
import { WAVE_LENGTH } from '../core/config.js';
import { clampSample, formatWaveHex, parseWaveHex } from '../core/wave-text.js';

const SVG_NS = 'http://www.w3.org/2000/svg';
const W = 320, H = 256, BAR = W / WAVE_LENGTH;

export class WaveEditor {
  /**
   * @param {object} els
   * @param {HTMLElement} els.canvas 描く場所（中に SVG を作る）
   * @param {HTMLTextAreaElement} els.text 16進の文字
   * @param {HTMLElement} els.message 読み込みの結果などの表示
   * @param {(wave: Int8Array) => void} onChange
   */
  constructor({ canvas, text, message }, onChange) {
    this.wave = new Int8Array(WAVE_LENGTH);
    this.text = text;
    this.message = message;
    this.onChange = onChange;
    this.pending = false;
    this.lastIndex = -1;
    this.lastValue = 0;

    const svg = document.createElementNS(SVG_NS, 'svg');
    svg.setAttribute('viewBox', `0 0 ${W} ${H}`);
    svg.setAttribute('preserveAspectRatio', 'none'); // 枠の形に合わせて伸ばす（なぞる位置の計算も枠の大きさで行う）
    svg.setAttribute('class', 'wave-editor-svg');
    svg.setAttribute('role', 'img');
    svg.setAttribute('aria-label', '波形（32点）。なぞって描く');
    const mid = document.createElementNS(SVG_NS, 'line');
    mid.setAttribute('x1', '0'); mid.setAttribute('x2', String(W));
    mid.setAttribute('y1', String(H / 2)); mid.setAttribute('y2', String(H / 2));
    mid.setAttribute('class', 'wave-editor-axis');
    svg.append(mid);
    this.bars = [];
    for (let i = 0; i < WAVE_LENGTH; i++) {
      const r = document.createElementNS(SVG_NS, 'rect');
      r.setAttribute('x', String(i * BAR + 1));
      r.setAttribute('width', String(BAR - 2));
      r.setAttribute('class', 'wave-editor-bar');
      svg.append(r);
      this.bars.push(r);
    }
    canvas.replaceChildren(svg);
    this.svg = svg;

    // なぞって描く（指でもマウスでも）。速く動かしても点が抜けないよう、前の点との間を埋める
    svg.addEventListener('pointerdown', (e) => {
      e.preventDefault();
      try { svg.setPointerCapture(e.pointerId); } catch { /* 捕まえられなくても描ける */ }
      this.lastIndex = -1;
      this.#paint(e);
    });
    svg.addEventListener('pointermove', (e) => { if (e.buttons || e.pointerType === 'touch') this.#paint(e); });
    svg.addEventListener('pointerup', () => { this.lastIndex = -1; this.#syncText(); });
    svg.addEventListener('pointercancel', () => { this.lastIndex = -1; });
    svg.addEventListener('contextmenu', (e) => e.preventDefault());
    svg.addEventListener('touchstart', (e) => e.preventDefault(), { passive: false });
    this.render();
  }

  /**
   * @param {ArrayLike<number>} wave
   * @param {boolean} [notify] false なら onChange で知らせない（最初の表示用）
   */
  set(wave, notify = true) {
    for (let i = 0; i < WAVE_LENGTH; i++) this.wave[i] = clampSample(wave[i]);
    this.render();
    this.#syncText();
    if (notify) this.#changed();
  }

  /** 16進の文字を読み込む。できなければ理由を表示する */
  loadText() {
    try {
      this.set(parseWaveHex(this.text.value));
      this.message.textContent = '読み込みました';
    } catch (err) {
      this.message.textContent = `読み込めません：${err.message}`;
    }
  }

  invert() { this.set(Array.from(this.wave, (v) => -v - 1)); }

  /** 隣の点と平均して、なめらかにする（波形は一周でつながっているので端も回り込む） */
  smooth() {
    const w = this.wave;
    this.set(Array.from(w, (v, i) => (w[(i + WAVE_LENGTH - 1) % WAVE_LENGTH] + 2 * v + w[(i + 1) % WAVE_LENGTH]) / 4));
  }

  render() {
    for (let i = 0; i < WAVE_LENGTH; i++) {
      const v = this.wave[i];
      const y = H / 2 - (v / 128) * (H / 2);
      const top = Math.min(y, H / 2), h = Math.max(1, Math.abs(y - H / 2));
      this.bars[i].setAttribute('y', String(top));
      this.bars[i].setAttribute('height', String(h));
    }
  }

  #paint(e) {
    const box = this.svg.getBoundingClientRect();
    const x = ((e.clientX - box.left) / box.width) * W;
    const y = ((e.clientY - box.top) / box.height) * H;
    const i = Math.max(0, Math.min(WAVE_LENGTH - 1, Math.floor(x / BAR)));
    const v = clampSample(((H / 2 - y) / (H / 2)) * 128);
    if (this.lastIndex >= 0 && this.lastIndex !== i) {
      const step = i > this.lastIndex ? 1 : -1;
      for (let k = this.lastIndex + step; k !== i; k += step) {
        const t = (k - this.lastIndex) / (i - this.lastIndex);
        this.wave[k] = clampSample(this.lastValue + (v - this.lastValue) * t);
      }
    }
    this.wave[i] = v;
    this.lastIndex = i;
    this.lastValue = v;
    this.render();
    this.#changed();
  }

  #syncText() {
    this.text.value = formatWaveHex(this.wave);
  }

  /** 描いている間は、約16ミリ秒（60回/秒）に1回だけ知らせる。画面が描かれていなくても動くよう、タイマーを使う */
  #changed() {
    if (this.pending) return;
    this.pending = true;
    setTimeout(() => {
      this.pending = false;
      this.onChange(Int8Array.from(this.wave));
    }, 16);
  }
}

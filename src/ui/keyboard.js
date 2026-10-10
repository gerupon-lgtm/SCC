// 画面の鍵盤：2オクターブ、タッチ（複数指）・マウス・パソコンのキーボードで弾ける
const BLACK = new Set([1, 3, 6, 8, 10]);
const NAMES = ['C', 'C#', 'D', 'D#', 'E', 'F', 'F#', 'G', 'G#', 'A', 'A#', 'B'];
const OCTAVES = 2;
/** パソコンのキー → 鍵盤の位置（0 = 左端のC） */
const PC_KEYS = 'awsedftgyhujkolp;'.split('');

export function noteName(note) {
  return `${NAMES[note % 12]}${Math.floor(note / 12) - 1}`;
}

export class Keyboard {
  /**
   * @param {HTMLElement} root
   * @param {object} opts
   * @param {(note: number) => void} opts.onDown
   * @param {(note: number) => void} opts.onUp
   * @param {number} [opts.base] 左端のノート番号
   */
  constructor(root, { onDown, onUp, base = 60 }) {
    this.root = root;
    this.onDown = onDown;
    this.onUp = onUp;
    this.base = base;
    this.enabled = false;
    /** @type {Map<number, number>} pointerId → note */
    this.pointers = new Map();
    /** @type {Map<string, number>} 押しているPCのキー → note */
    this.pcKeys = new Map();
    /** @type {Map<number, number>} note → 押している数 */
    this.held = new Map();
    this.#build();
    // 長押しでブラウザが独自の動作（文字の選択・検索・メニュー）を始めないようにする。
    // 始まるとタッチが取り消され（pointercancel）、押している音が止まってしまう
    root.addEventListener('contextmenu', (e) => e.preventDefault());
    root.addEventListener('selectstart', (e) => e.preventDefault());
    root.addEventListener('touchstart', (e) => { if (this.enabled) e.preventDefault(); }, { passive: false });
    root.addEventListener('pointerdown', (e) => this.#pointerDown(e));
    root.addEventListener('pointermove', (e) => this.#pointerMove(e));
    for (const t of ['pointerup', 'pointercancel', 'lostpointercapture']) root.addEventListener(t, (e) => this.#pointerUp(e));
    window.addEventListener('keydown', (e) => this.#keyDown(e));
    window.addEventListener('keyup', (e) => this.#keyUp(e));
    window.addEventListener('blur', () => this.releaseAll());
  }

  #build() {
    this.root.replaceChildren();
    this.keys = [];
    const count = OCTAVES * 12 + 1;
    const whites = [...Array(count).keys()].filter((i) => !BLACK.has(i % 12)).length;
    const w = 100 / whites;
    let wi = 0;
    for (let i = 0; i < count; i++) {
      const black = BLACK.has(i % 12);
      const el = document.createElement('div');
      el.className = `key ${black ? 'black' : 'white'}`;
      el.dataset.index = String(i);
      if (black) {
        el.style.left = `${(wi - 0.32) * w}%`;
        el.style.width = `${w * 0.64}%`;
      } else {
        el.style.left = `${wi * w}%`;
        el.style.width = `${w}%`;
        wi++;
      }
      if (i % 12 === 0) {
        const label = document.createElement('span');
        label.className = 'label';
        el.append(label);
      }
      this.root.append(el);
      this.keys.push(el);
    }
    this.#relabel();
  }

  #relabel() {
    this.keys.forEach((el, i) => {
      const label = el.querySelector('.label');
      if (label) label.textContent = noteName(this.base + i);
    });
  }

  /** @param {boolean} on */
  setEnabled(on) {
    this.enabled = on;
    this.root.setAttribute('aria-disabled', on ? 'false' : 'true');
    if (!on) this.releaseAll();
  }

  /** @param {number} delta オクターブ */
  shift(delta) {
    const next = this.base + delta * 12;
    if (next < 12 || next + OCTAVES * 12 > 120) return false;
    this.releaseAll();
    this.base = next;
    this.#relabel();
    return true;
  }

  get rangeLabel() {
    return `${noteName(this.base)}〜${noteName(this.base + OCTAVES * 12)}`;
  }

  releaseAll() {
    for (const note of [...this.held.keys()]) {
      this.held.set(note, 1);
      this.#release(note);
    }
    this.pointers.clear();
    this.pcKeys.clear();
  }

  #noteAt(x, y) {
    const el = document.elementFromPoint(x, y);
    if (!el || !this.root.contains(el) || !el.classList.contains('key')) return null;
    return this.base + Number(el.dataset.index);
  }

  #press(note) {
    const n = (this.held.get(note) ?? 0) + 1;
    this.held.set(note, n);
    if (n === 1) {
      this.keys[note - this.base]?.classList.add('down');
      this.onDown(note);
    }
  }

  #release(note) {
    const n = (this.held.get(note) ?? 0) - 1;
    if (n > 0) { this.held.set(note, n); return; }
    this.held.delete(note);
    this.keys[note - this.base]?.classList.remove('down');
    this.onUp(note);
  }

  #pointerDown(e) {
    if (!this.enabled) return;
    const note = this.#noteAt(e.clientX, e.clientY);
    if (note === null) return;
    e.preventDefault();
    // 鍵盤の外で指を離しても pointerup を受け取れるよう、鍵盤全体で捕まえる（押す鍵は座標で決める）
    try { this.root.setPointerCapture(e.pointerId); } catch { /* 捕まえられなくても鳴らす */ }
    this.pointers.set(e.pointerId, note);
    this.#press(note);
  }

  #pointerMove(e) {
    if (!this.pointers.has(e.pointerId)) return;
    const note = this.#noteAt(e.clientX, e.clientY);
    const prev = this.pointers.get(e.pointerId);
    if (note === prev) return;
    this.#release(prev);
    if (note === null) { this.pointers.delete(e.pointerId); return; }
    this.pointers.set(e.pointerId, note);
    this.#press(note);
  }

  #pointerUp(e) {
    const note = this.pointers.get(e.pointerId);
    if (note === undefined) return;
    this.pointers.delete(e.pointerId);
    this.#release(note);
  }

  #keyDown(e) {
    if (!this.enabled || e.repeat || e.ctrlKey || e.metaKey || e.altKey) return;
    if (e.target instanceof HTMLInputElement || e.target instanceof HTMLSelectElement) return;
    const k = e.key.toLowerCase();
    if (k === 'z' || k === 'x') { this.shift(k === 'z' ? -1 : 1); this.root.dispatchEvent(new Event('octavechange')); return; }
    const idx = PC_KEYS.indexOf(k);
    if (idx === -1 || this.pcKeys.has(k)) return;
    const note = this.base + idx;
    this.pcKeys.set(k, note);
    this.#press(note);
  }

  #keyUp(e) {
    const k = e.key.toLowerCase();
    const note = this.pcKeys.get(k);
    if (note === undefined) return;
    this.pcKeys.delete(k);
    this.#release(note);
  }
}

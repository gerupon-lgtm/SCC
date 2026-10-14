// 画面：曲を鳴らす（F-016、MGSDRV 形式）
// MGSDRV.COM・MGSC.COM・曲のファイルは、この端末の中だけで使う（どこにも送らない。C-3）
// MGSDRV.COM と MGSC.COM は、選び直さずに済むよう、このブラウザに保存する
import { compileMml, MgscError } from '../mgs/mgsc.js';
import { looksLikeMgsdrv, looksLikeMgsc } from '../mgs/mgsdrv-host.js';

const $ = (id) => /** @type {HTMLElement} */ (document.getElementById(id));

function toBase64(bytes) {
  let s = '';
  for (let i = 0; i < bytes.length; i++) s += String.fromCharCode(bytes[i]);
  return btoa(s);
}
function fromBase64(text) {
  const s = atob(text);
  return Uint8Array.from(s, (c) => c.charCodeAt(0));
}
function loadStored(key) {
  try { const v = localStorage.getItem(key); return v ? fromBase64(v) : null; } catch { return null; }
}
function store(key, bytes) {
  try { localStorage.setItem(key, toBase64(bytes)); } catch { /* 保存できなくても、今回は使える */ }
}

/** 文字コードを判断して読む（UTF-8 でなければ Shift_JIS） */
function decodeText(bytes) {
  try { return new TextDecoder('utf-8', { fatal: true }).decode(bytes); } catch { return new TextDecoder('shift_jis').decode(bytes); }
}

/** MGS の見出しから曲名を取り出す（8バイト目から改行まで） */
function mgsTitle(mgs) {
  let end = 8;
  while (end < mgs.length && end < 8 + 256 && mgs[end] !== 0x0d) end++;
  return new TextDecoder('shift_jis').decode(mgs.subarray(8, end)).replace(/\t/g, ' ').replace(/\s{2,}/g, ' ').trim();
}

/**
 * @param {object} deps
 * @param {import('../audio/audio-engine.js').AudioEngine} deps.engine
 * @param {() => Promise<boolean>} deps.ensureRunning 音が止まっていれば出す（「曲を再生」から呼ぶ）。出せたら true
 */
export function initSongPanel({ engine, ensureRunning }) {
  let driver = loadStored('mgsdrv.com');
  let mgsc = loadStored('mgsc.com');
  /** @type {Uint8Array | null} */
  let mgs = null;
  let running = false;
  let playing = false;
  let songName = '';

  const playBtn = /** @type {HTMLButtonElement} */ ($('song-play'));
  const stopBtn = /** @type {HTMLButtonElement} */ ($('song-stop'));
  const log = $('song-log');

  function showLog(text) {
    log.hidden = !text;
    log.textContent = text;
  }
  function setStatus(id, ok, text) {
    const el = $(id);
    el.textContent = text;
    el.classList.toggle('ok', ok);
  }
  function update() {
    setStatus('mgsdrv-status', !!driver, driver ? `✓ 読み込み済み（${driver.length} バイト）` : 'まだ選んでいません');
    setStatus('mgsc-status', !!mgsc, mgsc ? `✓ 読み込み済み（${mgsc.length} バイト）` : 'まだ選んでいません');
    setStatus('song-file-status', !!mgs, mgs ? `✓ ${songName}` : 'まだ選んでいません');
    // 3つそろえば押せる。音が止まっていれば、押したときに音を出してから再生する
    playBtn.disabled = !(driver && mgs) || playing;
    stopBtn.disabled = !playing;
    if (!playing) {
      const missing = [!driver && '1', !mgs && '3'].filter(Boolean);
      $('song-status').textContent = missing.length ? `${missing.join('と')}を選ぶと再生できます` : '';
    }
  }

  async function readFile(input) {
    const f = input.files?.[0];
    if (!f) return null;
    return { name: f.name, bytes: new Uint8Array(await f.arrayBuffer()) };
  }

  $('file-mgsdrv').addEventListener('change', async (e) => {
    const r = await readFile(e.target);
    if (!r) return;
    if (!looksLikeMgsdrv(r.bytes)) { showLog(`${r.name} は MGSDRV.COM ではないようです（大きさ ${r.bytes.length} バイト）`); return; }
    driver = r.bytes;
    store('mgsdrv.com', driver);
    showLog('');
    update();
  });

  $('file-mgsc').addEventListener('change', async (e) => {
    const r = await readFile(e.target);
    if (!r) return;
    if (!looksLikeMgsc(r.bytes)) { showLog(`${r.name} は MGSC.COM ではないようです`); return; }
    mgsc = r.bytes;
    store('mgsc.com', mgsc);
    showLog('');
    update();
  });

  $('file-song').addEventListener('change', async (e) => {
    const r = await readFile(e.target);
    if (!r) return;
    mgs = null;
    songName = r.name;
    $('song-title').textContent = '';
    try {
      if (/\.mgs$/i.test(r.name)) {
        mgs = r.bytes;
        showLog('');
      } else {
        if (!mgsc) { showLog('MML を変換するには MGSC.COM を選んでください'); update(); return; }
        const t0 = performance.now();
        const out = compileMml(mgsc, decodeText(r.bytes));
        mgs = out.mgs;
        showLog(`${out.log.trim()}\n（変換 ${Math.round(performance.now() - t0)} ミリ秒、${mgs.length} バイト）`);
      }
      $('song-title').textContent = `曲名：${mgsTitle(mgs) || r.name}`;
    } catch (err) {
      showLog(err instanceof MgscError ? `${err.message}\n${err.log}` : String(err.message ?? err));
    }
    update();
  });

  playBtn.addEventListener('click', async () => {
    if (!driver || !mgs) return;
    playBtn.disabled = true;
    if (!running && !(await ensureRunning())) { update(); return; }
    if (engine.playSong(driver, mgs)) showLog('');
  });
  stopBtn.addEventListener('click', () => engine.stopSong());

  update();
  return {
    /** @param {boolean} on 音が出せる状態か */
    setRunning(on) { running = on; if (!on) playing = false; update(); },
    /** @param {'playing' | 'stopped'} state */
    onSong(state) { playing = state === 'playing'; update(); },
    /** @param {{ playing: boolean, loop: number, seconds: number } | null} s */
    onState(s) {
      if (!s) return;
      const t = Math.floor(s.seconds);
      $('song-status').textContent = `${Math.floor(t / 60)}:${String(t % 60).padStart(2, '0')}・くり返し ${s.loop} 回${s.playing ? '' : '（終わり）'}`;
    },
    /** @param {string} message */
    onError(message) { playing = false; showLog(`再生できませんでした：${message}`); update(); },
  };
}

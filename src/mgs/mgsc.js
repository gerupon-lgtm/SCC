// MML → MGS の変換。本物の MGSC.COM を、最小限の CP/M の上で動かす（-e：CP/M の機能だけを使う）
import { CpmMachine } from './cpm.js';
import { encodeSjisForCpm } from './sjis.js';

export class MgscError extends Error {
  /** @param {string} message @param {string} [log] MGSC の出力 */
  constructor(message, log = '') { super(message); this.name = 'MgscError'; this.log = log; }
}

/**
 * @param {Uint8Array} mgscCom MGSC.COM の中身
 * @param {string} mmlText MML の文字列（UTF-8 で読んだもの）
 * @returns {{ mgs: Uint8Array, log: string }}
 */
export function compileMml(mgscCom, mmlText) {
  const { bytes } = encodeSjisForCpm(mmlText);
  const cpm = new CpmMachine({ 'SONG.MUS': bytes });
  const r = cpm.run(mgscCom, 'SONG.MUS SONG.MGS -E', 2_000_000_000);
  const log = r.output.replace(/\r/g, '');
  if (!r.exited) throw new MgscError('MGSC の変換が終わりませんでした', log);
  const mgs = cpm.files.get('SONG.MGS');
  if (!mgs || mgs.length < 8 || String.fromCharCode(mgs[0], mgs[1], mgs[2]) !== 'MGS') {
    throw new MgscError('MGS ができませんでした（MML の誤りの可能性があります）', log);
  }
  return { mgs, log };
}

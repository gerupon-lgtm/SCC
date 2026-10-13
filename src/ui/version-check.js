// 画面（HTML）と部品（JavaScript）の版が違うときと、予期しないエラーを、画面に出す
// GitHub Pages はファイルを10分間ブラウザに保存させる（max-age=600）。公開の直後は、
// HTMLだけ新しく JavaScript は古い、という食い違いが起き、黙って動かなくなることがある
// 読み込むだけで働く。各ページの最初の import にする
import { VERSION } from '../version.js';

function banner(text) {
  let el = document.getElementById('app-banner');
  if (!el) {
    el = document.createElement('div');
    el.id = 'app-banner';
    el.className = 'app-banner';
    el.setAttribute('role', 'alert');
    document.body.prepend(el);
  }
  const p = document.createElement('p');
  p.textContent = text;
  const b = document.createElement('button');
  b.type = 'button';
  b.textContent = '再読み込み';
  b.addEventListener('click', () => location.reload());
  el.replaceChildren(p, b);
}

const pageVersion = document.querySelector('meta[name="app-version"]')?.getAttribute('content');
if (pageVersion && pageVersion !== VERSION) {
  banner(`画面と部品の版が違います（画面 ${pageVersion}・部品 ${VERSION}）。公開の直後は、ブラウザに古い部品が最大10分残ります。少し待ってから再読み込みしてください。`);
}

window.addEventListener('error', (e) => banner(`エラーが起きました：${e.message}`));
window.addEventListener('unhandledrejection', (e) => banner(`エラーが起きました：${e.reason?.message ?? e.reason}`));

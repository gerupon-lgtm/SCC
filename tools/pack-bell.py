# 鐘の音の一式を zip にまとめる（共有用）
# 使い方：python tools/pack-bell.py
# 出力：exports/scc-bell-<版>.zip（フォルダ構成はリポジトリと同じ。展開すればそのまま動く）
import os
import re
import zipfile

ROOT = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))

FILES = [
    # 画面（試作ページ）
    "bell.html",
    "notice.html",
    "NOTICE",
    "src/version.js",
    "src/ui/style.css",
    "src/ui/keyboard.js",
    "src/ui/version-check.js",
    # 鐘の部品
    "src/bell/bell-voice.js",
    "src/bell/bell-worklet.js",
    "src/bell/bell-page.js",
    "src/bell/bell.css",
    # SCC の計算（MAME の k051649.cpp の動きにそろえたもの）
    "src/core/config.js",
    "src/core/presets.js",
    "src/core/scc-fast.js",
    "src/core/scc-ref.js",
    "src/core/scc-registers.js",
    "src/core/window-converter.js",
    "src/core/post-stage.js",
    # WAV と、その書き出し
    "exports/bell/small-C4.wav",
    "exports/bell/church-C4.wav",
    "exports/bell/README.md",
    "tools/render-bell.js",
    "tools/serve.py",
    # テストと文書
    "tests/bell-voice.test.js",
    "tests/render-bell.test.js",
    "docs/bell.md",
    "package.json",
]

LINK_FIXES = {
    "bell.html": [('<a href="index.html">本体へ</a>', '<a href="https://gerupon-lgtm.github.io/SCC/">本体（公開版）へ</a>')],
    "notice.html": [('<a href="index.html">← 戻る</a>', '<a href="bell.html">← 戻る</a>')],
}

README = """# SCC の鐘の音（版 {version}）

Konami SCC（K051649）の計算で作った鐘の音（単音）と、そのソースコード一式です。
SCCシミュレーター（https://github.com/gerupon-lgtm/SCC ）から切り出しました。

## すぐ使う：WAV

`exports/bell/` にあります（48,000Hz・16ビット・モノラル・3.0秒）。

- `small-C4.wav`：小さな鐘（C4、約2.5秒で鳴り終わる）
- `church-C4.wav`：教会の鐘（C4、約2.9秒で鳴り終わる）

## その場で鳴らす：ブラウザ

1. このフォルダで `python tools/serve.py` を実行する
2. ブラウザで http://localhost:8000/bell.html を開き、「音を出す」を押して鍵盤を押す

https か localhost で開く必要があります（ブラウザの決まりで、それ以外では音を出せません）。
公開版：https://gerupon-lgtm.github.io/SCC/bell.html

## 別の高さの WAV を作る

`tools/render-bell.js` の `NOTE`（60 = C4）を変えて、`node tools/render-bell.js` を実行します（Node.js 20以上）。

## 自分のアプリに組み込む

- 鐘の計算は `src/bell/bell-voice.js` の `BellVoice` です。画面や Web Audio に依存しません
- 使う操作は、SCC のレジスタへの書き込み（周波数・音量・キー・波形）だけです。
  `src/core/scc-registers.js` の `SccRegisters`（または同じ `write(addr, value)` を持つもの）に書き込みます
- 鳴らす：`bell.setParams(BELL_PRESETS.small.params)` → `bell.strike(60)` → 約2.7ミリ秒ごとに `bell.advance(秒)`
- 音にする：`src/bell/bell-worklet.js`（ブラウザ）か `tools/render-bell.js`（ファイル）が例です
- 仕組み・設定の意味・限界は `docs/bell.md` にあります

## テスト

`node --test`（Node.js 20以上）

## ライセンス

計算部分は MAME の k051649.cpp（BSD-3-Clause、copyright-holders: Bryan McPhail）の動きにそろえています。
共有・再配布するときは、`NOTICE` を必ず一緒に渡してください。
"""


def main():
    with open(os.path.join(ROOT, "src", "version.js"), encoding="utf-8") as f:
        version = re.search(r"VERSION = '([^']+)'", f.read()).group(1)
    out = os.path.join(ROOT, "exports", f"scc-bell-{version}.zip")
    top = f"scc-bell-{version}"
    with zipfile.ZipFile(out, "w", zipfile.ZIP_DEFLATED) as z:
        for rel in FILES:
            if rel in LINK_FIXES:
                # 一式に本体（index.html）は入れないので、本体へのリンクを付け替える
                with open(os.path.join(ROOT, rel), encoding="utf-8") as f:
                    text = f.read()
                for a, b in LINK_FIXES[rel]:
                    assert a in text, f"{rel} に {a} がありません"
                    text = text.replace(a, b)
                z.writestr(f"{top}/{rel}", text)
            else:
                z.write(os.path.join(ROOT, rel), f"{top}/{rel}")
        z.writestr(f"{top}/README.md", README.format(version=version))
    print(out)


if __name__ == "__main__":
    main()

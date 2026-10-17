# SCCシミュレーター— AI実装指示書

Konami SCC（K051649）を、ブラウザのWeb Audio APIで再現する個人開発アプリです。外部のMIDI機器（Web MIDI API）から演奏します。
要件の正典は、要件定義書 版0.10（https://claude.ai/code/artifact/220db0c5-39f7-4822-ab03-ca7375eaf6af）です。詳細は `docs/` を読んでください。

## 前提（仮置き）— 実装中に変わり得ます

- 【想定】素のJavaScript（ES Modules）。ビルド手順なし。型はJSDocコメントのみ
- 【想定】テストはNode.js標準（`node --test`）。Node 20以上
- 公開：GitHub Pages（https://gerupon-lgtm.github.io/SCC/ 、リポジトリ gerupon-lgtm/SCC、公開）。2026-10-11 決定。https で配信するので、スマホでも音とMIDIが使える。`main` に push すると更新される。正式名称は「SCCシミュレーター」（2026-10-17 決定）。ライセンスは未定
- 【想定】MIDIから音への割り当ての既定値は、`docs/api-design.md` の表のとおり
- 【想定】フォントはOS標準のみ。アイコンライブラリは使わない
- 【想定】プリセット波形は5種（`docs/data-model.md`）
- 【要確認】IKASCCとの照合、DAWプラグイン化、公開名義（実装は止めない）

## 実行とテスト

- 起動：`python tools/serve.py` → http://localhost:8000（ブラウザに古いファイルを使わせない開発用サーバー。`python -m http.server` だと変更が反映されないことがある）
- テスト：`node --test`（Node 24では `node --test tests/` のようにフォルダを渡すと動かないため、引数なしで実行します）
- Android実機：https://gerupon-lgtm.github.io/SCC/ を開く（push 後、反映まで1分ほど）。LANのIP（http://192.168.x.x:8000）では、安全な接続でないため音もMIDIも使えません（2026-10-10 確認）
- 実装の開始点は `docs/tasks.md` のT-001です。タスクは上から順に進めます

## 構成

```
index.html
NOTICE                       MAMEなどのライセンス表示
src/version.js               バージョンの正典
src/core/                    チップの計算。DOM・Web APIを使わない（C-2）
  config.js                  チャンネル数・波形の対応表・クロック
  scc-ref.js                 基準版（1クロックずつ）
  scc-fast.js                高速版（音が変わる瞬間だけ計算）
  scc-registers.js           SCC互換のアドレス層
  window-converter.js        チップのクロック→音声の変換（整数）
  post-stage.js              後処理（直流除去・音量）
  presets.js                 プリセット波形
  psg-ref.js                 PSG（AY-3-8910）の基準版。MAME と照合（T-110）
  psg-stage.js               PSG を音声のサンプルへ直す
src/engine/                  発音の割り当て、MIDIの対応づけ
src/audio/                   AudioWorklet、音声エンジン
src/midi/                    Web MIDI入力
src/ui/                      画面
src/mgs/                     MML 再生（F-016）：Z80 の再現・最小限の CP/M・本物の MGSDRV を動かす枠。DOM を使わない
local/                       手元だけのファイル（MGSDRV.COM・MGSC.COM・ZEXDOC など）。Git に入れない
tests/
  fixtures/mame/             MAMEの出力の記録（T-006）
tools/
  mame-check/                MAMEのk051649.cppを動かす照合の枠（README.md）
  bench.js                   性能測定（T-013）
notice.html                  NOTICE と同じ内容を画面で見るページ
bell.html                    鐘の音の試作ページ（本体とは別。docs/bell.md）
src/bell/                    鐘の試作。bell-voice.js は DOM・Web Audio を使わない（切り出し用）
docs/
```

## 変更の扱い（A・B・C）

この文書は、実装を止めるための禁止事項集ではありません。発案者の指示があれば、次の区分で変更してください。

- **A：即変更してよい。** 画面配置、UIの文言、色・余白、鍵盤やボタンの見た目、状態表示の並び順。文書の更新は任意です
- **B：変更してよいが記録する。** 機能の追加・削除・優先度、MVPの範囲、既定値（初期音量、MIDIの割り当て方）、対応ブラウザの範囲。要件定義書の該当行を更新し、改訂履歴に1行追記します
- **C：改訂の合意後に変更する。** 次の3つです
  - C-1：4章の確認済み仕様と、検証範囲（基準版と高速版の完全一致など）を縮めない。難しい場合は、理由と代案を添えて進言する。外すかどうかは発案者が決める
  - C-2：チップの計算部分（`src/core/`）を、画面・MIDI・DAW連携から独立させる
  - C-3：演奏データや操作内容を、外部のサーバーへ送らない

技術的に難しい点は、遠慮なく進言してください。進言した内容を、勝手に検証範囲から外すことはしません。

## 変更禁止事項（根拠つき）

1. **基準版（`scc-ref.js`）の動きを変えない。** 根拠：要件定義書4章の確認済み仕様と、MAMEのk051649.cppの動きです。変えると、高速版との一致確認の意味がなくなります（C-1）
2. **出力は整数の和で扱い、割り算は最後の1回だけにする。** 根拠：基準版と高速版を「完全一致」で比べるためです。浮動小数点で足し込むと、誤差が出ます
3. **`src/core/` で、DOM・Web Audio・Web MIDI・fetchなどを使わない。** 根拠：C-2です。Node.jsでテストでき、将来の移植もしやすくなります。`tests/architecture.test.js` が検査します
4. **外部通信をしない。** 根拠：C-3です。`index.html` のCSPで `connect-src 'none'` にします
5. **`process()` の中で、オブジェクト生成や `console.log` をしない。** 根拠：ガベージコレクションや出力が、音切れの原因になりうるためです（一般的な注意。このアプリでは未測定）
6. **「音を出す」ボタンの操作の後にだけ、AudioContextを開始する。音量のスライダーは 0〜100%、100% が倍率2（0.8.4 までの最大の2倍）、初期位置は80%（倍率1.6）。** 根拠：ブラウザの自動再生の制限と、聴覚への配慮（6章）です。2026-10-17 に発案者の指示で「初期音量0.5以下」から変更（B区分）

## ドキュメント

- `docs/scc-core-spec.md`：チップの計算の定義。基準版の根拠
- `docs/data-model.md`：データの形、プリセット波形
- `docs/api-design.md`：モジュールの接続、MIDIの割り当て、メッセージ、エラーコード
- `docs/screens.md`：画面とデザイントークン
- `docs/tasks.md`：実装順のタスクと、トレーサビリティ表

他のAIツールで使う場合は、このファイルを `AGENTS.md`（Codex・ChatGPT）や `GEMINI.md`（Gemini）としてコピーしてください。

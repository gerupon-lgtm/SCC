# モジュール・メッセージ設計

外部APIはありません。ここでは、モジュールの接続・MIDIの割り当て・メッセージ・エラーコードを定めます。

## 1. 全体の流れ

```
MIDI機器 → src/midi → src/engine（割り当て） → レジスタ書き込み（アドレス, 値）
   → postMessage → AudioWorklet（scc-registers → scc-fast → window-converter → post-stage）→ 音
```

- チップの計算はすべてAudioWorkletの中で動きます。メイン側は、レジスタへの書き込み命令を送るだけです
- 画面表示用の状態は、Worklet側から約30回/秒で送ります（`state` メッセージ）
- 基準版（`scc-ref.js`）は、音を出す経路には使いません。テストと照合の専用です（F-002）。高速版（F-003）が間に合わない場合に限り、設定で基準版へ切り替えられるようにします【想定】

## 2. 主なインターフェース

```js
// src/core/scc-registers.js
class SccRegisters {
  constructor(chip)            // chip は scc-ref か scc-fast（同じ形）
  write(addr, value)           // addr: 0x00..0xFF、value: 0..255
  read(addr)                   // 読み出し
}
// chip（基準版・高速版 共通）
chip.setFrequency(ch, f12); chip.setVolume(ch, v4); chip.setKey(mask, width?);  // width：先頭から何チャンネル分を変えるか
chip.getFrequency(ch); chip.readWave(bank, index);
chip.writeWave(bank, index, int8);
chip.sumTicks(n)               // nクロック進めて、各クロックの出力の和（整数）を返す
chip.snapshot()                // 状態の取り出し（テスト・表示用）
```

アドレスの対応は `docs/scc-core-spec.md` 3章。`0x90〜0x9F` は `0x80〜0x8F` の鏡、`0xE0〜0xFF` はテストレジスタで、MVPは値を保存するだけです。

実装で決めたこと【設計】（2026-10-10）：
- `0xA0〜0xDF` は何もしない（MAMEの `scc_map` と同じ）
- 読み出し：波形は保存した値、テストレジスタは保存した値、それ以外（書き込み専用・何もない）は `0xFF`
- キーの書き込み（`0x8F`）は ch0〜4 だけを変え、追加チャンネル（F-011）には触れない
- 設定に無いチャンネル・バンクへの書き込みは無視する（エラーにしない）

## 3. メッセージ

| 方向 | type | 内容 |
| --- | --- | --- |
| メイン→Worklet | `reg` | `{ addr, value }`、または `{ writes: [{ addr, value }, ...] }`（同じ処理の中の書き込みをまとめる） |
| メイン→Worklet | `master` | `{ gain }` |
| メイン→Worklet | `config` | `{ channelCount, channelWaveBank, clock }`（音を止めてから反映） |
| メイン→Worklet | `poll` | なし。状態を頼む（約30回/秒）。`process()` の中で状態の物を作らないため【設計】 |
| Worklet→メイン | `state` | `{ channels: [...], peak, load }`（load：処理の重さ。0.9を超えたら `E_AUDIO_UNDERRUN`） |
| Worklet→メイン | `error` | `{ code }` |

メッセージは受け取った順に処理します。同じ音声ブロックの中でレジスタの書き込みが重なっても、順序は保たれます。

## 4. MIDIの割り当て（F-009）【想定】

- 割り当て方式：**発音数ベース**。ノートオンを、空いているSCCチャンネルに割り当てる
- 空きがなければ、**一番古い音を止めて**、そのチャンネルを使う（確定）
- 音程：`TP = round(clock / (32 * f)) - 1`、`f = 440 * 2^((note-69)/12)`。範囲は 0〜4095 に丸める。`TP <= 8` となる高い音は、止まるため発音しない
- 音量：`round(velocity / 127 * 15)`、最小1
- ノートオフ：その音のチャンネルの音量を0にし、キーを切る
- ピッチベンド：±2半音【想定】。コントロールチェンジ7（音量）と123（全音停止）に対応
- プログラムチェンジ：プリセット波形の選択
- MIDIチャンネルは、MVPでは全部同じ扱い（OMNI）。パートごとの扱いはF-015
- 実装で決めたこと【設計】（2026-10-10）：同じ音が鳴っているときのノートオンは、そのチャンネルで鳴らし直す（同音の連打で全チャンネルを使い切らないため）。CC120（全音消去）もCC123と同じ扱い。CC7は `round(velocity/127 × CC7/127 × 15)`（最小1、CC7=0なら0）。プログラムチェンジは5種で折り返す。MIDI機器が抜かれたら全音停止

## 5. エラーコード

| コード | 意味 | 画面の動き |
| --- | --- | --- |
| `E_CONFIG` | 設定の不整合 | 起動を止め、原因を表示 |
| `E_NO_WORKLET` | AudioWorkletが使えない | 「このブラウザでは音を出せません」を表示 |
| `E_INSECURE_CONTEXT` | 安全でない接続（httpで、localhostでもない） | 開いた時点で、localhostで開く手順を表示（2026-10-10 追加。Pixel 6aでLANのIPを開いて発生） |
| `E_MIDI_UNSUPPORTED` | Web MIDI非対応 | 画面の鍵盤だけ使えると案内 |
| `E_MIDI_DENIED` | 許可されなかった | 許可の手順を表示。画面の鍵盤は使える |
| `E_MIDI_NO_DEVICE` | 接続機器なし | 「機器をつなぐと自動で認識します」を表示 |
| `E_AUDIO_UNDERRUN` | 音切れの疑い | 状態欄に表示（原因は記録しない） |

MIDI機器が抜き差しされたときは、`statechange` を受けて再列挙します。

## 6. バージョン

正典は `src/version.js` の `VERSION`（形式：`0.MINOR.PATCH`）。画面の下部に表示し、`NOTICE` とテストで同値を検査します。

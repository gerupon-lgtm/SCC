# データモデル

このアプリにはサーバーもデータベースもありません。データは、メモリ上の状態と、チップの計算に渡す配列だけです。保存機能（音色の保存・共有）はMVPの対象外です（要件3章）。

## 1. 設定（config）— F-010

チャンネル数と波形の共有は、値として外に出します。コードの中に5を直接書きません。

```js
// src/core/config.js
export const SCC_COMPAT = {
  channelCount: 5,
  waveBankCount: 4,
  // channelWaveBank[i] = チャンネルiが使う波形バンク番号（0始まり）
  channelWaveBank: [0, 1, 2, 3, 3],   // ch4とch5が共有【確認】
  clock: 3579545,                     // MSXの値。アーケードは未確認
};
```

- 検査：`channelWaveBank.length === channelCount`、各値が `0 <= v < waveBankCount`。外れたら `E_CONFIG` を投げる
- 拡張チャンネル（F-011）は、`channelCount` を増やし、新しいバンクを追加します。追加分は共有しません（要件4章）
- 設定を変えても、`scc-ref.js` と `scc-fast.js` のコードは変えません

## 2. チップの状態

```js
// 1チャンネル（scc-ref.js / scc-fast.js 共通の意味）
{ frequency: 0..4095, volume: 0..15, key: boolean,
  counter: 0..31, clock: -1..4095, sample: integer }

// 波形メモリ
waves: Int8Array(waveBankCount * 32)
```

意味と初期値は `docs/scc-core-spec.md` の1章です。

## 3. プリセット波形（F-006）【想定】

各32個、-128〜127の整数。`presets.js` が `Int8Array` を返します。

| 名前 | 作り方 |
| --- | --- |
| square | 前半16個が127、後半16個が-128 |
| saw | `round(-128 + 255 * i / 31)` |
| triangle | iが0〜15で上昇、16〜31で下降（-128〜127） |
| sine | `round(127 * sin(2πi/32))` |
| pulse25 | 前半8個が127、残り24個が-128 |

- 値を決める計算は、`presets.js` の中だけに置きます。同じ値かどうかは `tests/presets.test.js` で、数値の一覧と比べて確認します
- 実際のSCC用ゲームの音色は含めません（著作権の扱いが未確認）

## 4. 画面側の状態（保存しない）

```js
{ masterVolume: 0.0..2.0,              // 初期0.8（2026-10-17 発案者。以前は0.3）、1.0 が 0.8.4 までの最大
  audioState: 'stopped'|'running',
  midiState: 'unsupported'|'denied'|'noDevice'|'ready',
  voices: [{ ch, note, velocity, startedAt }],   // 発音中
  channelView: [{ frequency, volume, key, waveBank }] }
```

## 5. メッセージ（メイン側 ⇔ AudioWorklet）

`docs/api-design.md` の3章を参照。

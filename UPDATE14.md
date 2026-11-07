# UPDATE14: 縦画面で「元に戻す」ボタンの位置が動かないように固定

対象は既存の Pixel Mosaic Tool（Vanilla HTML / CSS / JS の PWA、ビルド不要）。
このファイルの仕様だけを実装すること。仕様にない機能追加やリファクタリングはしないこと。

## 問題

縦画面（`@media (max-width: 860px)`）では、キャンバス上部ツールバー `.canvas-toolbar` が `flex-wrap: wrap` で複数行に折り返される。操作中に次の要素の幅が変わると折り返し位置が変わり、「↩ 元に戻す」(`#undoToolbarBtn`) の行・位置が動いてしまう。

幅が変わる要素:

- `#statusToolBadge`（ツール／モードで文言が変わる）
- `#statusCoords`（座標の桁数で幅が変わる）
- `#compareActiveBadge`（原画比較中だけ表示される）
- `#zoomLevelText`（回転時に「125% · 90°」のように長くなる）

## 修正方針（縦画面のメディアクエリ内のみ変更する）

ツールバーの行構成を操作状態によらず一定にする。

1. **行を固定する**: ツールバー内の `#undoToolbarBtn` の直前に、改行専用要素 `<div class="toolbar-break" aria-hidden="true"></div>` を追加する。
   - デスクトップ（861px以上）では `display: none`。
   - 縦画面では `display: block; flex-basis: 100%; height: 0;` として、1行目 = `.status-left` + `.zoom-controls`、2行目 = `#undoToolbarBtn` 以降の操作ボタン群、という構成を常に固定する。
2. **1行目の幅変動を吸収する**（縦画面）:
   - `.status-left` は `flex: 1 1 0; min-width: 0; overflow: hidden;` とし、内部の文言・バッジの変化がツールバー全体のレイアウトに影響しないようにする（はみ出しは従来通り内側で切り捨てる）。
   - `#zoomLevelText` に固定幅を持たせる（回転角表示を含む最長形でも幅が変わらない `min-width` を設定し、`text-align: center`）。これにより `.zoom-controls` の幅も一定になる。
3. **操作ボタンのサイズを固定する**（縦画面）: `#undoToolbarBtn` / `#redoToolbarBtn` / `#saveAsBtn` / `#shortcutHelpBtn` / `#closeEditorBtn` は `flex-shrink: 0` とし、縮んだり押し出されたりしないようにする。
4. 結果として、縦画面ではツールバーの行数・高さと「元に戻す」ボタンの位置が、ツール切替・座標変化・比較表示・回転のいずれでも変わらないこと。

## 変更しないもの

- デスクトップ（861px以上）のツールバーの見た目・レイアウトは変更しない
- 各ボタンの機能・ラベル・ID、app.js のロジックは変更しない（原則として CSS と改行要素の追加のみ。app.js は原則無変更）
- `README.md` は変更しない

## Service Worker

- `sw.js` のキャッシュ名を `pixel-mosaic-tool-v16` に上げる

## 完了条件

- `app.js` / `sw.js` が構文チェック（`node --check`）を通過する（app.js を変更した場合）
- index.html の ID が重複していない
- app.js の `getElementById` 参照がすべて index.html に存在する
- 縦画面用メディアクエリ内に、行固定・幅固定のルールが入っていることがコード上で確認できる

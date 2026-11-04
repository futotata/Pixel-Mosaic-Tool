# UPDATE10 仕様書 — モザイクサイズの推奨値ロック（デフォルトON）

対象: Pixel Mosaic Tool（Vanilla HTML/CSS/JS の PWA、ビルド不要）
作業ディレクトリ内の `index.html` / `style.css` / `app.js` / `sw.js` のみ変更すること。README.md は変更しない。install.html / manifest.webmanifest / icons は変更しない。

目的: デフォルトではモザイクサイズを推奨モザイクサイズにロックし、誤って変更してしまうことを防ぐ。変更したいときだけ、明示的にロックを解除してから調整する。

現状の前提（確認済み）:
- 画像読み込み時（initializeWorkspaceWithImage 内）には既に setMosaicSize(recommended) で推奨値が自動適用されている。
- state.mosaicSize（初期値 16）、state.recommendedMosaicSize が存在する。スライダー #mosaicSizeSlider と数値入力 #mosaicSizeInput のイベントが setMosaicSize を呼ぶ。

## 1. ロック状態と切替ボタン

- 状態 `state.mosaicSizeLocked` を追加し、初期値は `true`（ロックON）。
- セクション2「モザイクサイズ」の推奨行（.recommended-row）内に、#applyRecommendedBtn の後ろへロック切替ボタン `<button type="button" id="mosaicLockBtn" aria-pressed="true">🔒 ロック中</button>` を追加する。行が狭い画面では折り返してよい（flex-wrap 可）。
  - ロックONのとき: 表示は「🔒 ロック中」、aria-pressed="true"、ON状態と分かる見た目（既存のモード切替ボタンのアクティブ表現に合わせる）。
  - ロックOFFのとき: 表示は「🔓 解除中」、aria-pressed="false"。

## 2. ロックの振る舞い

- ロックONのとき:
  - #mosaicSizeSlider と #mosaicSizeInput を `disabled` にする（見た目も無効と分かるようにする。既存の disabled スタイルが無ければ追加する）。
  - #applyRecommendedBtn も `disabled` にする（ロック中は常に推奨値のため不要）。
  - スライダー／数値入力のイベントハンドラ側でも、ロック中は setMosaicSize による変更を受け付けない（disabled 属性に加えた二重の保護）。
- ロックをOFF→ONに戻した瞬間： モザイクサイズを即座に推奨値へ戻す（setMosaicSize(state.recommendedMosaicSize) を呼ぶ）。
- ロックをON→OFFにしたとき: コントロールを有効化する。値はその時点の推奨値のまま（ユーザーが動かすまで変わらない）。
- 画像読み込み時（initializeWorkspaceWithImage、サンプル画像の読み込み経路も含む）: 前の画像でロックを解除していた場合でも、必ずロックONに戻し、推奨値を適用する（現行の自動適用とあわせて、ロック状態も初期化する）。
- 画像を閉じたとき（UPDATE7 の closeCurrentImage）: ロックをONに戻し、コントロールを無効化した起動直後の状態にする。
- 起動直後（画像未読み込み）: ロックONでコントロールは無効。モザイクサイズの初期値は推奨値の初期値（4px）に合わせる（state.mosaicSize の初期値と、スライダー／数値入力の初期 value を 4 に変更する）。画像を読み込めば従来どおりその画像の推奨値に切り替わる。

## 3. その他

- ブラシサイズ（下部バー）にはロックを付けない。対象はモザイクサイズのみ。
- `sw.js` のキャッシュ名を `pixel-mosaic-tool-v12` に上げる。
- 既存機能を壊さないこと：レイヤー分離と消しゴム（UPDATE6）、閉じる／ショートカット説明画面（UPDATE7）、2本指ピンチ／ツイスト回転（UPDATE8）、縦画面レイアウトと一体化（UPDATE9）、矩形選択のプレビュー（サイズ変更時のリアルタイム反映はロックOFF時に従来どおり）、原画比較、保存、Undo/Redo。
- 変更後に `index.html` 内の全 `id` が重複していないこと、`app.js` が参照する全 ID が存在すること、`node --check` が通ることを確認すること。

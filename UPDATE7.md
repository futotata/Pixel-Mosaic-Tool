# UPDATE7 仕様書 — 「閉じる」ボタンとショートカット説明画面の追加

対象: Pixel Mosaic Tool（Vanilla HTML/CSS/JS の PWA、ビルド不要）
作業ディレクトリ内の `index.html` / `style.css` / `app.js` / `sw.js` のみ変更すること。README.md は変更しない。install.html / manifest.webmanifest / icons は変更しない。

## 1. 画像を閉じるボタン

キャンバス上部のツールバー（`.canvas-toolbar`）に、編集中の画像を閉じて開始画面に戻るボタンを追加する。

- 配置: `.canvas-toolbar` 内、`#saveAsBtn` の後（右端）に `<button type="button" id="closeEditorBtn" disabled>✕ 閉じる</button>` を置く。`aria-label` は「画像を閉じて開始画面に戻る」。
- 画像が読み込まれていない間は `disabled`。画像読み込み時（`initializeWorkspaceWithImage`）に、保存ボタンと同様のタイミングで有効化する。
- クリック時の処理（`closeCurrentImage()` 相当を新設）:
  - モザイク編集の履歴が残っている場合は `confirm('編集中の画像を閉じますか？保存していないモザイク編集は失われます。')` で確認し、キャンセルされたら何もしない。履歴が無ければ確認なしで閉じる。
  - 進行中の操作（ブラシ／消しゴムのストローク、矩形選択、ピンチ、原画比較の保持・固定）は安全に解除・破棄する。
  - 状態をアプリ起動直後（画像未読み込み）と同じに戻す: `state.hasImage = false`、ファイル情報（名前・形式等）をクリア、4つのオフスクリーンキャンバス（original / mosaic / work / preview）の内容をクリア、履歴スタックを空にして Undo/Redo ボタン（パネル側・ツールバー側とも）を無効化、矩形選択を解除、ズームと表示オフセットを初期値に戻す、ステータス表示（ツールバッジ・座標・比較バッジ）を初期表示に戻す、左パネルの画像情報カードと推奨モザイクサイズ表示を初期のプレースホルダに戻す、保存／名前を付けて保存／閉じるボタンを無効化する。
  - ファイル入力（`input[type=file]`）の値をリセットし、同じファイルを再び選択できるようにする。
  - `dom.emptyStateBox.hidden = false` にして開始画面（ドラッグ＆ドロップ案内）を再表示し、表示キャンバスも空の状態に描き直す。
  - 設定類（モザイクサイズ、ブラシサイズ、選択中ツール、ブラシ／消しゴムモード、ショートカット説明の表示設定、Wake Lock）はリセットせず維持する。

## 2. ショートカット説明画面（編集画面を覆う全画面オーバーレイ）

- ボタン: `.canvas-toolbar` 内、`#closeEditorBtn` の直前に `<button type="button" id="shortcutHelpBtn">⌨️ ショートカット</button>` を置く。画像の有無にかかわらず常に押せる。`aria-haspopup="dialog"` を付ける。
- オーバーレイ: `<div id="shortcutHelpOverlay" class="shortcut-help-overlay" hidden role="dialog" aria-modal="true" aria-label="ショートカットキー一覧">` を、アプリ全体を覆う固定配置（`position: fixed; inset: 0;`、既存のどの要素よりも前面の z-index、不透明な濃色背景）で追加する。これにより表示中は画像編集画面が完全に見えなくなる。
  - 内容: 見出し「ショートカットキー一覧」と、キーボードショートカット＋タッチ操作の一覧。項目は既存のフッター `.shortcut-bar` と開始画面 `.shortcut-grid` の内容と揃え、漏れなく載せる（B ブラシ / E 消しゴム / R 矩形選択 / Enter 矩形確定 / Esc キャンセル / Ctrl+Z 元に戻す / Ctrl+Y やり直す / H 原画比較 / Space+ドラッグ 画面移動 / 2本指ピンチ ズーム / ＋・－・0 ズーム / Ctrl+S 保存 / Ctrl+O 開く 等、実装済みのものすべて）。
  - 閉じるボタン: オーバーレイ内に `<button type="button" id="shortcutHelpCloseBtn">✕ 閉じる</button>` を分かりやすい位置（右上など）に置く。
- 開閉の振る舞い:
  - `#shortcutHelpBtn` クリックで `hidden` を外して表示する。
  - 閉じる条件: `#shortcutHelpCloseBtn` クリック、Esc キー、オーバーレイ背景自体のクリック。
  - 表示中は編集系ショートカットを誤作動させない: 既存の keydown ハンドラでは、オーバーレイ表示中は Escape（閉じる）だけを処理し、それ以外のキーは無視する。

## 3. その他

- `sw.js` のキャッシュ名を `pixel-mosaic-tool-v9` に上げる。
- 既存の `#toggleShortcutsBtn`（説明のインライン表示切替）の振る舞いは変更しない。
- 既存機能を壊さないこと：レイヤー分離と消しゴム（UPDATE6）、2本指ピンチ、矩形、原画比較、保存／名前を付けて保存、Undo/Redo、配置（UPDATE4）、アプリ名表示なし。
- 変更後に `index.html` 内の全 `id` が重複していないこと、`app.js` が参照する全 ID が存在すること、`node --check` が通ることを確認すること。

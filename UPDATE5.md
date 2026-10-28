# UPDATE5 仕様書 — 元に戻す / やり直すボタンを上部ツールバーへ追加

対象: Pixel Mosaic Tool（Vanilla HTML/CSS/JS の PWA、ビルド不要）
作業ディレクトリ内の `index.html` / `style.css` / `app.js` / `sw.js` のみ変更すること。README.md は変更しない。install.html / manifest.webmanifest / icons は変更しない。

## 変更内容

キャンバス上部のツールバー（`.canvas-toolbar`）にある「💾 名前を付けて保存」ボタン（`#saveAsBtn`）の横に、「元に戻す」「やり直す」ボタンを追加する。左パネル内の既存ボタン（`#undoBtn` / `#redoBtn`）は残したまま、同じ操作をツールバーからも行えるようにする複製コントロールである。

### index.html

- `.canvas-toolbar` 内、`#saveAsBtn` の直前（左隣）に、次の2ボタンをこの順で追加する:
  - `<button type="button" id="undoToolbarBtn" ... disabled>↩ 元に戻す</button>`
  - `<button type="button" id="redoToolbarBtn" ... disabled>↪ やり直す</button>`
- `aria-label` は既存ボタンに倣い「元に戻す (Ctrl+Z)」「やり直す (Ctrl+Y)」相当とする。
- 初期状態はどちらも `disabled`（履歴が無い状態と一致させる）。
- クラスは既存のボタンスタイルを再利用し、ツールバーの他の要素（ステータス表示・ズーム操作・保存ボタン）と並んでもレイアウトが崩れないこと。狭い画面では既存の `flex-wrap` で自然に折り返してよい。

### app.js

- 既存の処理をそのまま使うこと（新しい履歴ロジックは作らない）:
  - `dom` 参照に `undoToolbarBtn` / `redoToolbarBtn` を追加する。
  - 既存の `updateHistoryUI()` で、既存ボタンと同時に新ボタンの `disabled` も同じ条件（canUndo / canRedo）で切り替える。
  - 新ボタンの click に既存の `performUndo()` / `performRedo()` をそのまま割り当てる。
- キーボードショートカット（Ctrl+Z / Ctrl+Y 等）や履歴ステップ数など、他の振る舞いは変更しない。

### style.css

- 新ボタンが `.canvas-toolbar` 内で既存ボタン群と違和感なく並ぶよう、必要最小限のスタイルを足す（既存クラスで足りる場合は追加不要）。

### sw.js

- キャッシュ名を `pixel-mosaic-tool-v7` に上げる。

## 制約

- UPDATE4 までの配置（ブラシサイズバーは編集スペース下部、モザイクサイズはツール切替の上、アプリ名表示なし）を元に戻さないこと。
- 変更後に `index.html` 内の全 `id` が重複していないこと、`app.js` が参照する全 ID が存在することを確認すること。

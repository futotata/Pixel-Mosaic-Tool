# UPDATE4 仕様書 — サイズ調整バーの配置変更

対象: Pixel Mosaic Tool（Vanilla HTML/CSS/JS の PWA、ビルド不要）
作業ディレクトリ内の `index.html` / `style.css` / `app.js` / `sw.js` のみ変更すること。README.md は変更しない。install.html / manifest.webmanifest / icons は変更しない。

## 変更内容（2点とも「移動」であり、新規の重複コントロールを作らないこと）

### 1. ブラシサイズ調節バーを画像編集スペースの下部へ移動

- 現在、左ツールパネル内「3. サイズ調整」セクションにあるブラシサイズのコントロール一式（`#brushControlGroup`：ラベル＋数値入力 `#brushSizeInput` ＋スライダー `#brushSizeSlider`（4〜400px）＋目盛り `.range-ticks`）を、右側の画像編集スペース（`main.workspace-area`）の下部へ移動する。
- 配置場所: `main.workspace-area` 内で `#canvasViewport` の直後（下）に置く横長のバナー状バーとする。ワークスペースは flex column なので、キャンバス領域（flex:1）の下に常時表示される固定フッターバーになること。上部ツールバー（`.canvas-toolbar`）と対になる見た目（背景 `var(--bg-panel)`、上辺に 1px の境界線）で、新しいクラス（例: `.brush-size-bar`）を付けてスタイルする。
- バー内部の並び: ラベルと数値入力を上段、スライダーをその下に横幅いっぱいに広げ、目盛りはスライダーの下に小さく表示する（既存 `.control-group` の構造を保ったままバーに収める形でよい）。
- ID と属性は一切変更しない（`brushControlGroup` / `brushSizeSlider` / `brushSizeInput`、min/max/step/value、aria-label）。app.js は ID 参照のみなので、原則として app.js の変更は不要なはずである。必要になった場合も、振る舞い（スライダーと数値入力の相互同期、ブラシプレビューへの反映）を変えないこと。

### 2. モザイクサイズ調整バーを「適用ツール切替」の上へ移動

- 現在「3. サイズ調整」セクションにあるモザイクサイズのコントロール一式（ラベル＋数値入力 `#mosaicSizeInput` ＋スライダー `#mosaicSizeSlider`（1〜200px）＋目盛り）を、左ツールパネル内で「適用ツール切替」セクションの直上に移動する。
- 具体的には、モザイクサイズ専用の `panel-section` として、「1. 画像ファイル・推奨値」セクションと「適用ツール切替」セクションの間に配置する。見出しは既存の `id="sectionSizeHeading"` を再利用し、文言は「2. モザイクサイズ」とする。その下の「適用ツール切替」は「3. 適用ツール切替」に繰り下げ、以降のセクション見出し番号も連番になるよう直す（「4. 履歴・比較・保存」「5. 表示維持・ウィンドウ」は現状の番号のまま結果的に連番になる想定だが、最終形が 1〜5 の連番であることを確認すること）。各セクションの `aria-labelledby` と見出しの `id` の対応が崩れないようにすること。
- 空になる旧「3. サイズ調整」セクションは丸ごと削除する（ブラシ側もモザイク側も抜けて空になるため）。
- ID と属性は一切変更しない（`mosaicSizeSlider` / `mosaicSizeInput`、min/max/step/value、aria-label）。モザイクサイズ変更時の矩形プレビューのリアルタイム反映など、既存の振る舞いを変えないこと。

## 共通の制約

- 直前に行った変更（左パネル上部のアプリ名表示＝ブランド行の削除、`.panel-header:has(> #installPwaBtn[hidden])` ルール）を元に戻さないこと。
- ショートカット説明のデフォルト非表示（UPDATE2）、「名前を付けて保存」ボタン（UPDATE3）など、既存機能を壊さないこと。
- `sw.js` のキャッシュ名を `pixel-mosaic-tool-v6` に上げる。
- 変更後に `index.html` 内の全 `id` が重複していないこと、`app.js` が参照する全 ID が存在することを確認すること。

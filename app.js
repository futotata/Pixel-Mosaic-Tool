/**
 * Pixel Mosaic Tool - メインアプリケーションスクリプト (app.js)
 *
 * フレームワーク不使用 (Vanilla JS) で動作する本格ピクセルモザイク編集PWA。
 * 表示用キャンバスと作業用オフスクリーンキャンバスを分離した軽量設計を採用し、
 * グリッド分割・セル内平均色算出による不可逆ピクセルモザイク処理を提供します。
 */

(() => {
  'use strict';

  /* =========================================================================
   * 1. 定数定義
   * ========================================================================= */

  /** モザイクサイズの最小値・最大値 (px) */
  const MIN_MOSAIC_SIZE = 1;
  const MAX_MOSAIC_SIZE = 200;

  /** ブラシサイズの最小値・最大値 (px) */
  const MIN_BRUSH_SIZE = 4;
  const MAX_BRUSH_SIZE = 400;

  /** ズーム倍率の最小値・最大値 (0.1倍 〜 8.0倍) */
  const MIN_ZOOM = 0.1;
  const MAX_ZOOM = 8.0;

  /**
   * Undo/Redo 履歴の最大保持ステップ数
   * 仕様要件: 「最低20段階 (スタック上限30以上)」を満たすため35段階 (初期状態含め36要素) に設定
   */
  const MAX_HISTORY_STEPS = 35;

  /** JPEG保存時の品質パラメータ (仕様要件: 0.92) */
  const JPEG_EXPORT_QUALITY = 0.92;

  /** 対応している画像MIMEタイプと標準拡張子のマップ */
  const SUPPORTED_MIME_MAP = {
    'image/png': '.png',
    'image/jpeg': '.jpg',
    'image/webp': '.webp'
  };

  /* =========================================================================
   * 2. アプリケーション状態 (State)
   * ========================================================================= */
  const state = {
    // 画像が読み込まれているかどうか
    hasImage: false,
    // 元画像の幅・高さ (px)
    imageWidth: 0,
    imageHeight: 0,
    // 元画像のファイル名（拡張子除くベース名）と元の拡張子・MIMEタイプ
    baseFileName: 'image',
    originalExt: '.png',
    mimeType: 'image/png',
    // 推奨モザイクサイズ (長辺から算出、最小4px)
    recommendedMosaicSize: 4,

    // 現在のモザイクサイズ (1〜200px)
    mosaicSize: 16,
    // 現在のブラシ直径サイズ (4〜400px)
    brushSize: 64,

    // 現在選択中のツール ('brush' | 'rect' | 'pan')
    currentTool: 'brush',

    // ビューポート上のズーム倍率 (0.1〜8.0) とパンオフセット (画面px)
    zoom: 1.0,
    panX: 0,
    panY: 0,

    // スペースキー押下中フラグ (一時的なパン移動モード)
    isSpacePressed: false,
    // パン操作ドラッグ中フラグと開始座標
    isPanning: false,
    panStartClientX: 0,
    panStartClientY: 0,
    panOriginX: 0,
    panOriginY: 0,

    // マウスカーソルの状態 (ビューポート座標および画像内座標)
    cursorInCanvas: false,
    cursorViewportX: 0,
    cursorViewportY: 0,
    cursorImageX: 0,
    cursorImageY: 0,

    // ブラシストローク操作中の状態
    isBrushing: false,
    lastBrushImageX: 0,
    lastBrushImageY: 0,
    brushGridCols: 0,
    brushGridRows: 0,
    brushVisitedCells: null, // Uint8Array: 1ストローク内でモザイク適用済みのグリッドセル記録
    brushTouchedAny: false,

    // 矩形選択操作の状態
    // rectSelection: { x, y, w, h } (画像座標系での選択中矩形。nullなら未選択)
    rectSelection: null,
    // 矩形ドラッグモード: null | 'create' | 'move' | 'resize-nw' | 'resize-ne' | 'resize-sw' | 'resize-se' | 'resize-n' | 'resize-s' | 'resize-w' | 'resize-e'
    rectDragMode: null,
    rectDragStartImgX: 0,
    rectDragStartImgY: 0,
    rectInitialBox: null,

    // 原画比較表示 (Before / After) フラグ
    isCompareHold: false,   // Hキーまたは「押下中は原画」ボタン押下中
    isCompareToggle: false, // トグルボタンによる原画固定表示

    // ショートカットキー説明の表示フラグ (初期状態はデフォルト非表示: false)
    shortcutsVisible: false,

    // マルチタッチ・2本指ピンチズーム追跡用の状態
    // activePointers: Map<number, { clientX: number, clientY: number }> (キャンバスに触れているアクティブなポインタ)
    activePointers: new Map(),
    // 現在2本指ピンチ操作中かどうか
    isPinching: false,
    // ピンチ操作が発生した後、全ての指が離れるまで1本指の描画・選択・パン再開を抑止するフラグ
    ignoreSinglePointerUntilAllReleased: false,
    // ピンチ開始時の2本指間の距離 (px) と開始時ズーム倍率
    pinchStartDist: 0,
    pinchStartZoom: 1.0,
    // 直前フレームにおける2本指の中点座標 (ビューポートCSS座標系)
    pinchPrevMidVx: 0,
    pinchPrevMidVy: 0,

    // Undo / Redo 履歴スタック
    // 各要素は { type: 'imagedata' | 'dataurl', data: ImageData | string }
    historyStack: [],
    historyIndex: -1,

    // Screen Wake Lock API の Sentinel オブジェクト
    wakeLockSentinel: null,
    // PWA インストールプロンプト保持用
    deferredInstallPrompt: null
  };

  /* =========================================================================
   * 3. オフスクリーンキャンバスの生成 (軽量設計: 表示用と作業用を分離)
   * ========================================================================= */

  /** 原画保持用オフスクリーンキャンバス (比較表示 Before 用) */
  const originalCanvas = document.createElement('canvas');
  const originalCtx = originalCanvas.getContext('2d', { willReadFrequently: true });

  /** 作業確定済み画像保持用オフスクリーンキャンバス */
  const workCanvas = document.createElement('canvas');
  const workCtx = workCanvas.getContext('2d', { willReadFrequently: true });

  /** ブラシ塗装中・矩形選択中のリアルタイムプレビュー用オフスクリーンキャンバス */
  const previewCanvas = document.createElement('canvas');
  const previewCtx = previewCanvas.getContext('2d', { willReadFrequently: true });

  /* =========================================================================
   * 4. DOM要素の参照取得
   * ========================================================================= */
  const dom = {
    // PWAインストール
    installPwaBtn: document.getElementById('installPwaBtn'),

    // パネル内アラート領域
    panelAlertBox: document.getElementById('panelAlertBox'),
    panelAlertIcon: document.getElementById('panelAlertIcon'),
    panelAlertMessage: document.getElementById('panelAlertMessage'),
    panelAlertCloseBtn: document.getElementById('panelAlertCloseBtn'),

    // ファイル入出力・画像情報
    fileInput: document.getElementById('fileInput'),
    openFileBtn: document.getElementById('openFileBtn'),
    loadSampleBtn: document.getElementById('loadSampleBtn'),
    emptyOpenBtn: document.getElementById('emptyOpenBtn'),
    emptySampleBtn: document.getElementById('emptySampleBtn'),
    infoFileName: document.getElementById('infoFileName'),
    infoResolution: document.getElementById('infoResolution'),
    infoLongSide: document.getElementById('infoLongSide'),
    infoRecommendedSize: document.getElementById('infoRecommendedSize'),
    recommendedBtnValue: document.getElementById('recommendedBtnValue'),
    applyRecommendedBtn: document.getElementById('applyRecommendedBtn'),

    // ツール切替ボタン
    toolBrushBtn: document.getElementById('toolBrushBtn'),
    toolRectBtn: document.getElementById('toolRectBtn'),
    toolPanBtn: document.getElementById('toolPanBtn'),

    // 矩形選択操作UI
    rectActionBox: document.getElementById('rectActionBox'),
    rectSelectionInfo: document.getElementById('rectSelectionInfo'),
    confirmRectBtn: document.getElementById('confirmRectBtn'),
    cancelRectBtn: document.getElementById('cancelRectBtn'),
    floatingRectBar: document.getElementById('floatingRectBar'),
    floatingRectText: document.getElementById('floatingRectText'),
    floatingConfirmBtn: document.getElementById('floatingConfirmBtn'),
    floatingCancelBtn: document.getElementById('floatingCancelBtn'),

    // サイズ設定スライダー＆数値入力
    mosaicSizeSlider: document.getElementById('mosaicSizeSlider'),
    mosaicSizeInput: document.getElementById('mosaicSizeInput'),
    brushControlGroup: document.getElementById('brushControlGroup'),
    brushSizeSlider: document.getElementById('brushSizeSlider'),
    brushSizeInput: document.getElementById('brushSizeInput'),

    // 履歴・比較・保存
    undoBtn: document.getElementById('undoBtn'),
    redoBtn: document.getElementById('redoBtn'),
    historyStatusText: document.getElementById('historyStatusText'),
    compareHoldBtn: document.getElementById('compareHoldBtn'),
    compareToggleBtn: document.getElementById('compareToggleBtn'),
    saveBtn: document.getElementById('saveBtn'),
    saveAsBtn: document.getElementById('saveAsBtn'),

    // Wake Lock & 別ウィンドウ & ショートカット説明表示トグル
    wakeLockToggle: document.getElementById('wakeLockToggle'),
    wakeLockStatus: document.getElementById('wakeLockStatus'),
    openWindowBtn: document.getElementById('openWindowBtn'),
    toggleShortcutsBtn: document.getElementById('toggleShortcutsBtn'),
    toggleShortcutsBtnText: document.getElementById('toggleShortcutsBtnText'),

    // キャンバス・ステータスバー・ズーム
    statusToolBadge: document.getElementById('statusToolBadge'),
    statusCoords: document.getElementById('statusCoords'),
    compareActiveBadge: document.getElementById('compareActiveBadge'),
    zoomOutBtn: document.getElementById('zoomOutBtn'),
    zoomLevelText: document.getElementById('zoomLevelText'),
    zoomInBtn: document.getElementById('zoomInBtn'),
    zoomResetBtn: document.getElementById('zoomResetBtn'),
    zoomFitBtn: document.getElementById('zoomFitBtn'),

    // ビューポート・表示用キャンバス・オーバーレイ・ショートカット説明領域
    canvasViewport: document.getElementById('canvasViewport'),
    displayCanvas: document.getElementById('displayCanvas'),
    emptyStateBox: document.getElementById('emptyStateBox'),
    shortcutGrid: document.getElementById('shortcutGrid'),
    shortcutBar: document.getElementById('shortcutBar'),
    dropOverlay: document.getElementById('dropOverlay'),
    toastContainer: document.getElementById('toastContainer')
  };

  /** 表示用キャンバスの2Dコンテキスト */
  const displayCtx = dom.displayCanvas.getContext('2d');

  /* =========================================================================
   * 5. 通知・エラーハンドリングユーティリティ
   * ========================================================================= */

  /**
   * 画面右下にトースト通知を表示します。
   * @param {string} message 通知メッセージ
   * @param {'info'|'success'|'warning'|'error'} [type='info'] 通知種別
   * @param {number} [durationMs=4000] 表示時間(ミリ秒)
   */
  function showToast(message, type = 'info', durationMs = 4000) {
    try {
      const item = document.createElement('div');
      item.className = `toast-item toast-${type}`;
      item.setAttribute('role', type === 'error' ? 'alert' : 'status');

      const textSpan = document.createElement('span');
      textSpan.textContent = message;
      item.appendChild(textSpan);

      dom.toastContainer.appendChild(item);

      window.setTimeout(() => {
        item.style.opacity = '0';
        item.style.transition = 'opacity 0.2s ease';
        window.setTimeout(() => {
          if (item.parentNode) {
            item.parentNode.removeChild(item);
          }
        }, 220);
      }, durationMs);
    } catch (err) {
      console.error('トースト表示中にエラーが発生しました:', err);
    }
  }

  /**
   * 左パネル内のアラートボックスにメッセージを表示します。
   * エラー発生時はトーストと同時にパネル内にも常時確認できるアラートを出します。
   * @param {string} message 表示するメッセージ
   * @param {'error'|'info'} [level='error'] アラートレベル
   */
  function showPanelAlert(message, level = 'error') {
    dom.panelAlertMessage.textContent = message;
    dom.panelAlertBox.classList.toggle('alert-info', level === 'info');
    dom.panelAlertIcon.textContent = level === 'info' ? 'i' : '!';
    dom.panelAlertBox.hidden = false;
  }

  /**
   * 左パネル内のアラートボックスを閉じます。
   */
  function hidePanelAlert() {
    dom.panelAlertBox.hidden = true;
    dom.panelAlertMessage.textContent = '';
  }

  /**
   * エラーをコンソール・パネルアラート・トーストの3箇所に通知します。
   * @param {string} userMessage ユーザー向け日本語エラーメッセージ
   * @param {unknown} [errorObj] 補足例外オブジェクト
   */
  function reportError(userMessage, errorObj = null) {
    if (errorObj) {
      console.error(userMessage, errorObj);
    } else {
      console.error(userMessage);
    }
    showPanelAlert(userMessage, 'error');
    showToast(userMessage, 'error', 5500);
  }

  /* =========================================================================
   * 6. 推奨モザイクサイズ算出 & サイズ設定連動ロジック
   * ========================================================================= */

  /**
   * 画像の幅・高さから推奨モザイクサイズを算出します。
   * 仕様: 「長辺が400px以上なら 推奨 = ceil(長辺/100)、最小4px。例 1920→20, 1280→13, 400→4」
   * @param {number} width 画像幅 (px)
   * @param {number} height 画像高さ (px)
   * @returns {{ longSide: number, recommended: number }} 長辺と推奨モザイクサイズ
   */
  function calculateRecommendedMosaic(width, height) {
    const longSide = Math.max(width || 0, height || 0);
    if (longSide <= 0) {
      return { longSide: 0, recommended: 4 };
    }
    // 長辺が400px以上なら ceil(長辺 / 100)、400px未満でも最小4pxを保証
    const rawRecommended = longSide >= 400 ? Math.ceil(longSide / 100) : 4;
    const recommended = Math.max(4, Math.min(MAX_MOSAIC_SIZE, rawRecommended));
    return { longSide, recommended };
  }

  /**
   * モザイクサイズを設定し、スライダーと数値入力を双方向同期します。
   * 矩形選択中であればリアルタイムプレビューも即座に再計算します。
   * @param {number|string} newSize 新しいモザイクサイズ (1〜200)
   * @param {boolean} [updatePreview=true] 矩形プレビューを更新するかどうか
   */
  function setMosaicSize(newSize, updatePreview = true) {
    const parsed = Number(newSize);
    if (!Number.isFinite(parsed)) {
      return;
    }
    const clamped = Math.max(MIN_MOSAIC_SIZE, Math.min(MAX_MOSAIC_SIZE, Math.round(parsed)));
    state.mosaicSize = clamped;

    // スライダーと数値入力の表示値を同期
    dom.mosaicSizeSlider.value = String(clamped);
    dom.mosaicSizeInput.value = String(clamped);

    // 矩形選択中なら新しいモザイクサイズでリアルタイムプレビューを更新
    if (updatePreview && state.hasImage && state.rectSelection) {
      updateRectMosaicPreview();
      renderDisplayCanvas();
    } else if (state.hasImage) {
      renderDisplayCanvas();
    }
  }

  /**
   * ブラシサイズを設定し、スライダーと数値入力を双方向同期します。
   * @param {number|string} newSize 新しいブラシ直径サイズ (4〜400)
   */
  function setBrushSize(newSize) {
    const parsed = Number(newSize);
    if (!Number.isFinite(parsed)) {
      return;
    }
    const clamped = Math.max(MIN_BRUSH_SIZE, Math.min(MAX_BRUSH_SIZE, Math.round(parsed)));
    state.brushSize = clamped;

    dom.brushSizeSlider.value = String(clamped);
    dom.brushSizeInput.value = String(clamped);

    if (state.hasImage) {
      renderDisplayCanvas();
    }
  }

  /* =========================================================================
   * 7. 本格ピクセルモザイク処理エンジン (グリッド分割 + セル内平均色塗りつぶし)
   * ========================================================================= */

  /**
   * 指定された ImageData の特定矩形領域 (rx, ry, rw, rh) を
   * mosaicSize ごとのグリッドに分割し、各セル内の全ピクセルの平均色 (R, G, B, A) で塗りつぶします。
   *
   * @param {ImageData} imageData 対象キャンバスのImageData (直接書き換えられます)
   * @param {number} rx 対象領域の左上X座標 (整数, 0以上)
   * @param {number} ry 対象領域の左上Y座標 (整数, 0以上)
   * @param {number} rw 対象領域の幅 (整数, 1以上)
   * @param {number} rh 対象領域の高さ (整数, 1以上)
   * @param {number} mosaicSize モザイク1セルのサイズ (1〜200px)
   */
  function applyAverageMosaicToImageDataRegion(imageData, rx, ry, rw, rh, mosaicSize) {
    const imgW = imageData.width;
    const imgH = imageData.height;
    const data = imageData.data;

    // 画像境界内に安全にクランプ
    const x0 = Math.max(0, Math.min(imgW, Math.floor(rx)));
    const y0 = Math.max(0, Math.min(imgH, Math.floor(ry)));
    const x1 = Math.max(0, Math.min(imgW, Math.ceil(rx + rw)));
    const y1 = Math.max(0, Math.min(imgH, Math.ceil(ry + rh)));

    const step = Math.max(1, Math.round(mosaicSize));

    // モザイクサイズが1pxの場合は平均色が元のピクセルと同一のため処理不要
    if (step <= 1 || x1 <= x0 || y1 <= y0) {
      return;
    }

    // 対象領域を step × step のグリッドセルに分割して走査
    for (let cellY = y0; cellY < y1; cellY += step) {
      const cellEndY = Math.min(cellY + step, y1);

      for (let cellX = x0; cellX < x1; cellX += step) {
        const cellEndX = Math.min(cellX + step, x1);

        let sumR = 0;
        let sumG = 0;
        let sumB = 0;
        let sumA = 0;
        let pixelCount = 0;

        // 1. セル内の全ピクセルのRGBA値を合算
        for (let py = cellY; py < cellEndY; py++) {
          let rowOffset = (py * imgW + cellX) * 4;
          for (let px = cellX; px < cellEndX; px++) {
            sumR += data[rowOffset];
            sumG += data[rowOffset + 1];
            sumB += data[rowOffset + 2];
            sumA += data[rowOffset + 3];
            pixelCount++;
            rowOffset += 4;
          }
        }

        if (pixelCount === 0) {
          continue;
        }

        // 2. セル内の平均色を算出 (四捨五入)
        const avgR = Math.round(sumR / pixelCount);
        const avgG = Math.round(sumG / pixelCount);
        const avgB = Math.round(sumB / pixelCount);
        const avgA = Math.round(sumA / pixelCount);

        // 3. セル内の全ピクセルを算出した平均色で塗りつぶす (不可逆処理)
        for (let py = cellY; py < cellEndY; py++) {
          let rowOffset = (py * imgW + cellX) * 4;
          for (let px = cellX; px < cellEndX; px++) {
            data[rowOffset] = avgR;
            data[rowOffset + 1] = avgG;
            data[rowOffset + 2] = avgB;
            data[rowOffset + 3] = avgA;
            rowOffset += 4;
          }
        }
      }
    }
  }

  /**
   * オフスクリーンキャンバス上の単一グリッドセル (cellX, cellY, cellW, cellH) の
   * ピクセル平均色を計算して塗りつぶします（ブラシストローク時の高速セル単位処理用）。
   *
   * @param {CanvasRenderingContext2D} ctx 対象の2Dコンテキスト
   * @param {number} cellX セルの左上X座標
   * @param {number} cellY セルの左上Y座標
   * @param {number} cellW セルの幅
   * @param {number} cellH セルの高さ
   */
  function mosaicSingleCellOnContext(ctx, cellX, cellY, cellW, cellH) {
    if (cellW <= 0 || cellH <= 0) {
      return;
    }
    const cellImgData = ctx.getImageData(cellX, cellY, cellW, cellH);
    const data = cellImgData.data;
    const totalPixels = cellW * cellH;
    if (totalPixels <= 1) {
      return;
    }

    let sumR = 0;
    let sumG = 0;
    let sumB = 0;
    let sumA = 0;

    for (let i = 0; i < data.length; i += 4) {
      sumR += data[i];
      sumG += data[i + 1];
      sumB += data[i + 2];
      sumA += data[i + 3];
    }

    const avgR = Math.round(sumR / totalPixels);
    const avgG = Math.round(sumG / totalPixels);
    const avgB = Math.round(sumB / totalPixels);
    const avgA = Math.round(sumA / totalPixels);

    for (let i = 0; i < data.length; i += 4) {
      data[i] = avgR;
      data[i + 1] = avgG;
      data[i + 2] = avgB;
      data[i + 3] = avgA;
    }

    ctx.putImageData(cellImgData, cellX, cellY);
  }

  /**
   * ブラシの円形領域 (中心 cx, cy / 直径 brushSize) が重なるグリッドセルを判定し、
   * 未処理のセルに対して平均色ピクセルモザイクを適用します。
   *
   * @param {number} cx ブラシ中心X座標 (画像座標系)
   * @param {number} cy ブラシ中心Y座標 (画像座標系)
   */
  function applyBrushStampAtPoint(cx, cy) {
    if (!state.hasImage) {
      return;
    }
    const step = Math.max(1, state.mosaicSize);
    const radius = state.brushSize / 2;
    const radiusSq = radius * radius;
    const imgW = state.imageWidth;
    const imgH = state.imageHeight;

    // ブラシ円の外接矩形にかかるグリッド列・行の範囲を計算
    const minCol = Math.max(0, Math.floor((cx - radius) / step));
    const maxCol = Math.min(state.brushGridCols - 1, Math.floor((cx + radius) / step));
    const minRow = Math.max(0, Math.floor((cy - radius) / step));
    const maxRow = Math.min(state.brushGridRows - 1, Math.floor((cy + radius) / step));

    // カーソル直下のセルはブラシサイズがモザイクサイズより小さい場合でも確実に塗れるようにする
    const centerCol = Math.floor(cx / step);
    const centerRow = Math.floor(cy / step);

    for (let row = minRow; row <= maxRow; row++) {
      const cellY = row * step;
      const cellH = Math.min(step, imgH - cellY);

      // 円の中心 (cx, cy) からセル矩形への最近傍Y座標
      const nearestY = Math.max(cellY, Math.min(cy, cellY + cellH));
      const dy = cy - nearestY;

      for (let col = minCol; col <= maxCol; col++) {
        const cellIdx = row * state.brushGridCols + col;
        // 同一ストローク内で既にモザイク化済みのセルはスキップ
        if (state.brushVisitedCells[cellIdx] === 1) {
          continue;
        }

        const cellX = col * step;
        const cellW = Math.min(step, imgW - cellX);

        // 円の中心からセル矩形への最近傍X座標
        const nearestX = Math.max(cellX, Math.min(cx, cellX + cellW));
        const dx = cx - nearestX;

        const isCenterCell = (col === centerCol && row === centerRow);
        if (isCenterCell || (dx * dx + dy * dy <= radiusSq)) {
          state.brushVisitedCells[cellIdx] = 1;
          state.brushTouchedAny = true;
          mosaicSingleCellOnContext(previewCtx, cellX, cellY, cellW, cellH);
        }
      }
    }
  }

  /**
   * 前回のブラシ座標 (x0, y0) から今回の座標 (x1, y1) までを線形補間し、
   * 高速にマウスを動かしても途切れのない滑らかなモザイクストロークを適用します。
   *
   * @param {number} x0 始点X (画像座標系)
   * @param {number} y0 始点Y (画像座標系)
   * @param {number} x1 終点X (画像座標系)
   * @param {number} y1 終点Y (画像座標系)
   */
  function applyBrushStrokeSegment(x0, y0, x1, y1) {
    const dist = Math.hypot(x1 - x0, y1 - y0);
    // 補間ステップ間隔（ブラシ半径またはモザイクサイズの小さい方の1/3）
    const stepDist = Math.max(1, Math.min(state.brushSize / 4, state.mosaicSize / 2));
    const steps = Math.max(1, Math.ceil(dist / stepDist));

    for (let i = 0; i <= steps; i++) {
      const t = i / steps;
      const ix = x0 + (x1 - x0) * t;
      const iy = y0 + (y1 - y0) * t;
      applyBrushStampAtPoint(ix, iy);
    }
  }

  /* =========================================================================
   * 8. 矩形選択リアルタイムプレビュー & 確定/解除ロジック
   * ========================================================================= */

  /**
   * 矩形オブジェクト { x, y, w, h } を画像領域 [0, imageWidth] × [0, imageHeight] 内に正規化します。
   * @param {{ x: number, y: number, w: number, h: number }} box
   * @returns {{ x: number, y: number, w: number, h: number }}
   */
  function normalizeRectToImageBounds(box) {
    let x1 = box.x;
    let y1 = box.y;
    let x2 = box.x + box.w;
    let y2 = box.y + box.h;

    if (x1 > x2) {
      [x1, x2] = [x2, x1];
    }
    if (y1 > y2) {
      [y1, y2] = [y2, y1];
    }

    x1 = Math.max(0, Math.min(state.imageWidth, Math.round(x1)));
    y1 = Math.max(0, Math.min(state.imageHeight, Math.round(y1)));
    x2 = Math.max(0, Math.min(state.imageWidth, Math.round(x2)));
    y2 = Math.max(0, Math.min(state.imageHeight, Math.round(y2)));

    return {
      x: x1,
      y: y1,
      w: Math.max(0, x2 - x1),
      h: Math.max(0, y2 - y1)
    };
  }

  /**
   * 現在の矩形選択範囲 (`state.rectSelection`) に対して、
   * `workCanvas` をベースに `previewCanvas` 上へリアルタイムモザイクプレビューを生成します。
   */
  function updateRectMosaicPreview() {
    if (!state.hasImage) {
      return;
    }

    // まず確定済み作業キャンバスの内容をプレビューキャンバスへ転写
    previewCtx.clearRect(0, 0, state.imageWidth, state.imageHeight);
    previewCtx.drawImage(workCanvas, 0, 0);

    const sel = state.rectSelection;
    if (!sel || sel.w < 1 || sel.h < 1) {
      updateRectActionUI();
      return;
    }

    // 選択矩形部分のImageDataだけを切り出して平均色モザイクを適用（大画像でも超高速）
    const subImageData = previewCtx.getImageData(sel.x, sel.y, sel.w, sel.h);
    applyAverageMosaicToImageDataRegion(subImageData, 0, 0, sel.w, sel.h, state.mosaicSize);
    previewCtx.putImageData(subImageData, sel.x, sel.y);

    updateRectActionUI();
  }

  /**
   * 矩形選択関連のボタン活性状態・サイズ表示テキストを更新します。
   */
  function updateRectActionUI() {
    const sel = state.rectSelection;
    const hasValidSel = Boolean(state.hasImage && sel && sel.w >= 1 && sel.h >= 1);

    dom.confirmRectBtn.disabled = !hasValidSel;
    dom.cancelRectBtn.disabled = !hasValidSel;
    dom.rectActionBox.classList.toggle('has-selection', hasValidSel);
    dom.floatingRectBar.hidden = !hasValidSel;

    if (hasValidSel) {
      const infoText = `選択中: (${sel.x}, ${sel.y}) ${sel.w} × ${sel.h} px [モザイク ${state.mosaicSize}px]`;
      dom.rectSelectionInfo.textContent = infoText;
      dom.floatingRectText.textContent = `${sel.w}×${sel.h}px (サイズ:${state.mosaicSize}px)`;
    } else {
      dom.rectSelectionInfo.textContent = 'ドラッグで矩形範囲を選択してください';
    }
  }

  /**
   * 現在選択中の矩形モザイクプレビューを `workCanvas` に本確定し、履歴スタックに保存します。
   * 確定ボタン・ダブルクリック・Enterキーから呼ばれます。
   * @param {boolean} [silent=false] トースト通知を抑制するかどうか
   * @returns {boolean} 確定が行われたかどうか
   */
  function confirmRectSelection(silent = false) {
    if (!state.hasImage || !state.rectSelection) {
      return false;
    }
    const sel = state.rectSelection;
    if (sel.w < 1 || sel.h < 1) {
      cancelRectSelection();
      return false;
    }

    // 最新のモザイクサイズでプレビューを確実化してから workCanvas へ書き込む
    updateRectMosaicPreview();
    workCtx.clearRect(0, 0, state.imageWidth, state.imageHeight);
    workCtx.drawImage(previewCanvas, 0, 0);

    const appliedBox = { ...sel };
    state.rectSelection = null;
    state.rectDragMode = null;

    // 履歴スタックへ追加
    pushHistorySnapshot();
    updateRectActionUI();
    renderDisplayCanvas();

    if (!silent) {
      showToast(
        `矩形モザイクを適用しました (${appliedBox.w}×${appliedBox.h}px / モザイク ${state.mosaicSize}px)`,
        'success',
        2600
      );
    }
    return true;
  }

  /**
   * 現在の矩形選択を破棄（キャンセル）し、確定前の状態に戻します。
   */
  function cancelRectSelection() {
    if (!state.rectSelection) {
      return;
    }
    state.rectSelection = null;
    state.rectDragMode = null;
    if (state.hasImage) {
      previewCtx.clearRect(0, 0, state.imageWidth, state.imageHeight);
      previewCtx.drawImage(workCanvas, 0, 0);
    }
    updateRectActionUI();
    renderDisplayCanvas();
  }

  /* =========================================================================
   * 9. Undo / Redo 履歴管理 (最大35段階、ImageData / DataURL対応)
   * ========================================================================= */

  /**
   * 現在の `workCanvas` の状態を履歴スナップショットとして取得します。
   * 高速な ImageData クローンを基本とし、万が一メモリ制限等で失敗した場合は DataURL にフォールバックします。
   * @returns {{ type: 'imagedata'|'dataurl', data: ImageData|string }}
   */
  function createCanvasSnapshot() {
    try {
      const imgData = workCtx.getImageData(0, 0, state.imageWidth, state.imageHeight);
      return { type: 'imagedata', data: imgData };
    } catch (err) {
      console.warn('ImageData取得に失敗したためDataURL形式で履歴を保存します:', err);
      return { type: 'dataurl', data: workCanvas.toDataURL('image/png') };
    }
  }

  /**
   * スナップショットを `workCanvas` および `previewCanvas` に復元します。
   * @param {{ type: 'imagedata'|'dataurl', data: ImageData|string }} snapshot
   */
  function restoreCanvasSnapshot(snapshot) {
    if (!snapshot) {
      return;
    }
    // 進行中の矩形選択があれば解除
    state.rectSelection = null;
    state.rectDragMode = null;
    updateRectActionUI();

    if (snapshot.type === 'imagedata') {
      workCtx.putImageData(snapshot.data, 0, 0);
      previewCtx.clearRect(0, 0, state.imageWidth, state.imageHeight);
      previewCtx.drawImage(workCanvas, 0, 0);
      renderDisplayCanvas();
    } else if (snapshot.type === 'dataurl') {
      const img = new Image();
      img.onload = () => {
        workCtx.clearRect(0, 0, state.imageWidth, state.imageHeight);
        workCtx.drawImage(img, 0, 0);
        previewCtx.clearRect(0, 0, state.imageWidth, state.imageHeight);
        previewCtx.drawImage(workCanvas, 0, 0);
        renderDisplayCanvas();
      };
      img.src = snapshot.data;
    }
  }

  /**
   * 履歴スタックを初期化し、初期画像状態を先頭に登録します。
   */
  function initHistoryStack() {
    state.historyStack = [createCanvasSnapshot()];
    state.historyIndex = 0;
    updateHistoryUI();
  }

  /**
   * 新しい編集結果を履歴スタックに追加します。
   * 上限 (`MAX_HISTORY_STEPS` = 35段階、配列要素数 36) を超えた場合は最も古い履歴を破棄します。
   */
  function pushHistorySnapshot() {
    // 現在のインデックスより後ろ（Redo分）があれば切り捨てる
    if (state.historyIndex < state.historyStack.length - 1) {
      state.historyStack = state.historyStack.slice(0, state.historyIndex + 1);
    }

    state.historyStack.push(createCanvasSnapshot());

    // 最大ステップ数を超えたら先頭を削除
    if (state.historyStack.length > MAX_HISTORY_STEPS + 1) {
      state.historyStack.shift();
    }

    state.historyIndex = state.historyStack.length - 1;
    updateHistoryUI();
  }

  /**
   * 1段階前の状態に戻します (Undo: Ctrl/Cmd + Z)。
   */
  function performUndo() {
    if (!state.hasImage) {
      return;
    }
    // 未確定の矩形選択がある場合は、まずその選択を解除する
    if (state.rectSelection) {
      cancelRectSelection();
      showToast('未確定の矩形選択を解除しました', 'info', 2000);
      return;
    }
    if (state.historyIndex <= 0) {
      return;
    }
    state.historyIndex--;
    restoreCanvasSnapshot(state.historyStack[state.historyIndex]);
    updateHistoryUI();
    showToast(`元に戻しました (${state.historyIndex} / ${state.historyStack.length - 1})`, 'info', 1800);
  }

  /**
   * 1段階後の状態にやり直します (Redo: Ctrl+Y / Ctrl+Shift+Z)。
   */
  function performRedo() {
    if (!state.hasImage || state.historyIndex >= state.historyStack.length - 1) {
      return;
    }
    state.historyIndex++;
    restoreCanvasSnapshot(state.historyStack[state.historyIndex]);
    updateHistoryUI();
    showToast(`やり直しました (${state.historyIndex} / ${state.historyStack.length - 1})`, 'info', 1800);
  }

  /**
   * Undo/Redoボタンの活性状態および履歴ステップ表示を更新します。
   */
  function updateHistoryUI() {
    const canUndo = state.hasImage && (state.historyIndex > 0 || Boolean(state.rectSelection));
    const canRedo = state.hasImage && state.historyIndex < state.historyStack.length - 1;

    dom.undoBtn.disabled = !canUndo;
    dom.redoBtn.disabled = !canRedo;

    const currentStep = Math.max(0, state.historyIndex);
    const totalSteps = Math.max(0, state.historyStack.length - 1);
    dom.historyStatusText.textContent = `履歴: ${currentStep} / ${totalSteps} 段階 (最大${MAX_HISTORY_STEPS}段階保持)`;
  }

  /* =========================================================================
   * 10. 表示用キャンバスのレンダリング & 座標変換
   * ========================================================================= */

  /**
   * ビューポートのDOMサイズに合わせて表示用キャンバスの解像度を調整します。
   */
  function resizeDisplayCanvas() {
    const rect = dom.canvasViewport.getBoundingClientRect();
    const dpr = window.devicePixelRatio || 1;
    const targetW = Math.max(1, Math.floor(rect.width * dpr));
    const targetH = Math.max(1, Math.floor(rect.height * dpr));

    if (dom.displayCanvas.width !== targetW || dom.displayCanvas.height !== targetH) {
      dom.displayCanvas.width = targetW;
      dom.displayCanvas.height = targetH;
    }
    renderDisplayCanvas();
  }

  /**
   * ビューポート内のクライアント座標 (clientX, clientY) を
   * ビューポート左上基準のCSSピクセル座標と画像ピクセル座標に変換します。
   *
   * @param {number} clientX マウスイベントのclientX
   * @param {number} clientY マウスイベントのclientY
   * @returns {{ vx: number, vy: number, ix: number, iy: number }}
   */
  function clientToImageCoords(clientX, clientY) {
    const rect = dom.canvasViewport.getBoundingClientRect();
    const vx = clientX - rect.left;
    const vy = clientY - rect.top;
    const ix = (vx - state.panX) / state.zoom;
    const iy = (vy - state.panY) / state.zoom;
    return { vx, vy, ix, iy };
  }

  /**
   * 画像全体がビューポート中央に収まるようにズーム倍率とパン位置を初期化（フィット）します。
   */
  function fitImageToViewport() {
    if (!state.hasImage) {
      return;
    }
    const rect = dom.canvasViewport.getBoundingClientRect();
    const padding = 48;
    const availW = Math.max(100, rect.width - padding * 2);
    const availH = Math.max(100, rect.height - padding * 2);

    const scaleX = availW / state.imageWidth;
    const scaleY = availH / state.imageHeight;
    // 最大でも等倍(1.0)を初期上限としつつ、0.1〜8.0に収める
    const fitZoom = Math.max(MIN_ZOOM, Math.min(1.0, Math.min(scaleX, scaleY)));

    state.zoom = Number(fitZoom.toFixed(3));
    state.panX = Math.round((rect.width - state.imageWidth * state.zoom) / 2);
    state.panY = Math.round((rect.height - state.imageHeight * state.zoom) / 2);

    updateZoomUI();
    renderDisplayCanvas();
  }

  /**
   * 指定した倍率にズームします。基準点 (centerVx, centerVy) が指定された場合はその点を中心に拡大・縮小します。
   * @param {number} targetZoom 新しいズーム倍率 (0.1〜8.0)
   * @param {number} [centerVx] ズーム中心X (ビューポートCSS座標)
   * @param {number} [centerVy] ズーム中心Y (ビューポートCSS座標)
   */
  function setZoomLevel(targetZoom, centerVx, centerVy) {
    if (!state.hasImage) {
      return;
    }
    const clampedZoom = Math.max(MIN_ZOOM, Math.min(MAX_ZOOM, targetZoom));
    const rect = dom.canvasViewport.getBoundingClientRect();
    const cx = typeof centerVx === 'number' ? centerVx : rect.width / 2;
    const cy = typeof centerVy === 'number' ? centerVy : rect.height / 2;

    // ズーム中心が指している画像上の座標を維持するようパンオフセットを再計算
    const imgXBefore = (cx - state.panX) / state.zoom;
    const imgYBefore = (cy - state.panY) / state.zoom;

    state.zoom = Number(clampedZoom.toFixed(3));
    state.panX = cx - imgXBefore * state.zoom;
    state.panY = cy - imgYBefore * state.zoom;

    updateZoomUI();
    renderDisplayCanvas();
  }

  /**
   * ズーム倍率表示ラベルを更新します。
   */
  function updateZoomUI() {
    dom.zoomLevelText.textContent = `${Math.round(state.zoom * 100)}%`;
  }

  /**
   * 表示用キャンバス (`displayCanvas`) に現在の画像状態およびツールオーバーレイを描画します。
   */
  function renderDisplayCanvas() {
    const dpr = window.devicePixelRatio || 1;
    const canvasW = dom.displayCanvas.width;
    const canvasH = dom.displayCanvas.height;

    displayCtx.save();
    displayCtx.setTransform(1, 0, 0, 1, 0, 0);
    displayCtx.clearRect(0, 0, canvasW, canvasH);

    if (!state.hasImage) {
      displayCtx.restore();
      return;
    }

    // デバイスピクセル比を考慮した座標系にスケール
    displayCtx.scale(dpr, dpr);

    // 原画比較表示中かどうかを判定
    const isComparing = state.isCompareHold || state.isCompareToggle;
    dom.compareActiveBadge.hidden = !isComparing;

    // 描画元オフスクリーンキャンバスの選択:
    // - 比較表示中: originalCanvas (原画)
    // - ブラシ塗装中 または 矩形選択プレビュー中: previewCanvas
    // - 通常時: workCanvas
    let sourceCanvas = workCanvas;
    if (isComparing) {
      sourceCanvas = originalCanvas;
    } else if (state.isBrushing || state.rectSelection) {
      sourceCanvas = previewCanvas;
    }

    // 画像描画設定（拡大表示時はピクセルの境界がくっきり見えるようスムージングを無効化）
    displayCtx.save();
    displayCtx.translate(state.panX, state.panY);
    displayCtx.scale(state.zoom, state.zoom);
    displayCtx.imageSmoothingEnabled = state.zoom < 1.25;

    // 画像外周のドロップシャドウと境界線
    displayCtx.shadowColor = 'rgba(0, 0, 0, 0.55)';
    displayCtx.shadowBlur = 16 / state.zoom;
    displayCtx.drawImage(sourceCanvas, 0, 0);
    displayCtx.shadowColor = 'transparent';
    displayCtx.shadowBlur = 0;

    displayCtx.lineWidth = 1 / state.zoom;
    displayCtx.strokeStyle = 'rgba(255, 255, 255, 0.18)';
    displayCtx.strokeRect(0, 0, state.imageWidth, state.imageHeight);
    displayCtx.restore();

    // 原画比較中でない場合、アクティブツールのガイドオーバーレイを描画
    if (!isComparing) {
      if (state.rectSelection && state.rectSelection.w > 0 && state.rectSelection.h > 0) {
        drawRectSelectionOverlay(displayCtx);
      }
      if (
        state.currentTool === 'brush' &&
        !state.isSpacePressed &&
        !state.isPanning &&
        !state.isPinching &&
        state.cursorInCanvas
      ) {
        drawBrushCursorPreview(displayCtx);
      }
    }

    displayCtx.restore();
  }

  /**
   * ブラシツール選択時に、マウスカーソル位置に円形プレビューとモザイクセルガイドを描画します。
   * @param {CanvasRenderingContext2D} ctx
   */
  function drawBrushCursorPreview(ctx) {
    const screenRadius = (state.brushSize * state.zoom) / 2;
    const vx = state.cursorViewportX;
    const vy = state.cursorViewportY;

    ctx.save();

    // 外側の黒リング（明背景での視認性確保）
    ctx.beginPath();
    ctx.arc(vx, vy, Math.max(2, screenRadius + 1), 0, Math.PI * 2);
    ctx.strokeStyle = 'rgba(0, 0, 0, 0.75)';
    ctx.lineWidth = 1.5;
    ctx.stroke();

    // 内側のシアン破線リング（暗背景での視認性確保）
    ctx.beginPath();
    ctx.arc(vx, vy, Math.max(1.5, screenRadius), 0, Math.PI * 2);
    ctx.strokeStyle = '#00d4ff';
    ctx.lineWidth = 1.5;
    ctx.setLineDash([5, 4]);
    ctx.stroke();
    ctx.setLineDash([]);

    // 中心クロスヘア
    ctx.beginPath();
    ctx.moveTo(vx - 4, vy);
    ctx.lineTo(vx + 4, vy);
    ctx.moveTo(vx, vy - 4);
    ctx.lineTo(vx, vy + 4);
    ctx.strokeStyle = 'rgba(255, 255, 255, 0.85)';
    ctx.lineWidth = 1;
    ctx.stroke();

    ctx.restore();
  }

  /**
   * 矩形選択中の破線枠および8方向のリサイズハンドルを描画します。
   * @param {CanvasRenderingContext2D} ctx
   */
  function drawRectSelectionOverlay(ctx) {
    const sel = state.rectSelection;
    if (!sel) {
      return;
    }

    const sx = state.panX + sel.x * state.zoom;
    const sy = state.panY + sel.y * state.zoom;
    const sw = sel.w * state.zoom;
    const sh = sel.h * state.zoom;

    ctx.save();

    // 背景コントラスト用の黒枠
    ctx.strokeStyle = 'rgba(0, 0, 0, 0.8)';
    ctx.lineWidth = 2;
    ctx.strokeRect(sx, sy, sw, sh);

    // シアン色の破線枠
    ctx.strokeStyle = '#00d4ff';
    ctx.lineWidth = 2;
    ctx.setLineDash([6, 4]);
    ctx.strokeRect(sx, sy, sw, sh);
    ctx.setLineDash([]);

    // 四隅と上下左右の8つのリサイズハンドルを描画
    const handleSize = 8;
    const half = handleSize / 2;
    const handlePoints = [
      [sx, sy],
      [sx + sw / 2, sy],
      [sx + sw, sy],
      [sx + sw, sy + sh / 2],
      [sx + sw, sy + sh],
      [sx + sw / 2, sy + sh],
      [sx, sy + sh],
      [sx, sy + sh / 2]
    ];

    ctx.fillStyle = '#ffffff';
    ctx.strokeStyle = '#7b5cff';
    ctx.lineWidth = 2;
    for (const [hx, hy] of handlePoints) {
      ctx.fillRect(hx - half, hy - half, handleSize, handleSize);
      ctx.strokeRect(hx - half, hy - half, handleSize, handleSize);
    }

    ctx.restore();
  }

  /**
   * ビューポート座標 (vx, vy) が現在選択中の矩形のどのハンドルまたは内部にあるかを判定します。
   * @param {number} vx ビューポートX座標
   * @param {number} vy ビューポートY座標
   * @returns {string|null} ヒットした操作モード ('resize-nw' 等、内部なら 'move'、外部なら null)
   */
  function hitTestRectSelection(vx, vy) {
    const sel = state.rectSelection;
    if (!sel || sel.w < 1 || sel.h < 1) {
      return null;
    }

    const sx = state.panX + sel.x * state.zoom;
    const sy = state.panY + sel.y * state.zoom;
    const sw = sel.w * state.zoom;
    const sh = sel.h * state.zoom;
    const hitRadius = 8;

    const handles = [
      { mode: 'resize-nw', x: sx, y: sy },
      { mode: 'resize-ne', x: sx + sw, y: sy },
      { mode: 'resize-se', x: sx + sw, y: sy + sh },
      { mode: 'resize-sw', x: sx, y: sy + sh },
      { mode: 'resize-n', x: sx + sw / 2, y: sy },
      { mode: 'resize-e', x: sx + sw, y: sy + sh / 2 },
      { mode: 'resize-s', x: sx + sw / 2, y: sy + sh },
      { mode: 'resize-w', x: sx, y: sy + sh / 2 }
    ];

    for (const h of handles) {
      if (Math.abs(vx - h.x) <= hitRadius && Math.abs(vy - h.y) <= hitRadius) {
        return h.mode;
      }
    }

    if (vx >= sx && vx <= sx + sw && vy >= sy && vy <= sy + sh) {
      return 'move';
    }
    return null;
  }

  /**
   * 現在のツールおよびマウス位置に応じてキャンバスのCSSカーソル形状を更新します。
   */
  function updateCanvasCursorStyle() {
    if (!state.hasImage) {
      dom.displayCanvas.style.cursor = 'default';
      return;
    }
    if (state.isPanning) {
      dom.displayCanvas.style.cursor = 'grabbing';
      return;
    }
    if (state.isSpacePressed || state.currentTool === 'pan') {
      dom.displayCanvas.style.cursor = 'grab';
      return;
    }
    if (state.currentTool === 'brush') {
      dom.displayCanvas.style.cursor = 'crosshair';
      return;
    }
    if (state.currentTool === 'rect') {
      const hit = hitTestRectSelection(state.cursorViewportX, state.cursorViewportY);
      const cursorMap = {
        'resize-nw': 'nwse-resize',
        'resize-se': 'nwse-resize',
        'resize-ne': 'nesw-resize',
        'resize-sw': 'nesw-resize',
        'resize-n': 'ns-resize',
        'resize-s': 'ns-resize',
        'resize-e': 'ew-resize',
        'resize-w': 'ew-resize',
        'move': 'move'
      };
      dom.displayCanvas.style.cursor = cursorMap[hit] || 'crosshair';
    }
  }

  /* =========================================================================
   * 11. ツール切替ロジック
   * ========================================================================= */

  /**
   * 使用するツールを切り替えます ('brush' | 'rect' | 'pan')。
   * @param {'brush'|'rect'|'pan'} toolName
   */
  function selectTool(toolName) {
    if (!['brush', 'rect', 'pan'].includes(toolName)) {
      return;
    }

    // 矩形選択中に別ツールへ切り替える場合、未確定プレビューは安全のため解除する
    if (state.currentTool === 'rect' && toolName !== 'rect' && state.rectSelection) {
      cancelRectSelection();
    }

    state.currentTool = toolName;

    // ボタンのアクティブ表示と aria-pressed 更新
    const toolButtons = [
      { btn: dom.toolBrushBtn, key: 'brush' },
      { btn: dom.toolRectBtn, key: 'rect' },
      { btn: dom.toolPanBtn, key: 'pan' }
    ];
    for (const item of toolButtons) {
      const isActive = item.key === toolName;
      item.btn.classList.toggle('active', isActive);
      item.btn.setAttribute('aria-pressed', String(isActive));
    }

    // ステータスバーのツールバッジ更新
    const badgeLabels = {
      brush: '🖌️ ブラシモード (B)',
      rect: '⬚ 矩形選択モード (R)',
      pan: '✋ パン移動モード (Space)'
    };
    dom.statusToolBadge.textContent = badgeLabels[toolName];

    updateCanvasCursorStyle();
    renderDisplayCanvas();
  }

  /* =========================================================================
   * 12. 画像ファイルの読み込み & サンプル画像生成 & 保存処理
   * ========================================================================= */

  /**
   * ファイル名またはMIMEタイプから保存用の形式情報を判定します。
   * PNG / JPG / WebP 以外の非対応形式は null を返します。
   * @param {File} file
   * @returns {{ mimeType: string, ext: string, baseName: string } | null}
   */
  function parseSupportedImageFile(file) {
    if (!file) {
      return null;
    }
    const rawName = file.name || 'image.png';
    const dotIndex = rawName.lastIndexOf('.');
    const baseName = dotIndex > 0 ? rawName.slice(0, dotIndex) : rawName;
    const lowerExt = dotIndex > 0 ? rawName.slice(dotIndex).toLowerCase() : '';

    let mimeType = (file.type || '').toLowerCase();
    if (mimeType === 'image/jpg') {
      mimeType = 'image/jpeg';
    }

    // MIMEタイプが空でも拡張子から判定できるよう補完
    if (!SUPPORTED_MIME_MAP[mimeType]) {
      if (lowerExt === '.png') {
        mimeType = 'image/png';
      } else if (lowerExt === '.jpg' || lowerExt === '.jpeg') {
        mimeType = 'image/jpeg';
      } else if (lowerExt === '.webp') {
        mimeType = 'image/webp';
      } else {
        return null;
      }
    }

    // 元ファイルの拡張子表記を尊重（.jpeg なら .jpeg、.jpg なら .jpg）
    let finalExt = SUPPORTED_MIME_MAP[mimeType];
    if (mimeType === 'image/jpeg' && (lowerExt === '.jpeg' || lowerExt === '.jpg')) {
      finalExt = lowerExt;
    }

    return { mimeType, ext: finalExt, baseName };
  }

  /**
   * ユーザーが選択またはドロップした画像ファイルを読み込み、オフスクリーンキャンバスを初期化します。
   * @param {File} file
   */
  function loadImageFromFile(file) {
    try {
      hidePanelAlert();
      const fileMeta = parseSupportedImageFile(file);
      if (!fileMeta) {
        reportError(
          `非対応のファイル形式です (${file ? file.name : '不明'})。PNG / JPG / WebP 形式の画像を選択してください。`
        );
        return;
      }

      const objectUrl = URL.createObjectURL(file);
      const img = new Image();

      img.onload = () => {
        try {
          URL.revokeObjectURL(objectUrl);
          if (img.naturalWidth <= 0 || img.naturalHeight <= 0) {
            reportError('画像のサイズが不正です。別の画像ファイルをお試しください。');
            return;
          }
          initializeWorkspaceWithImage(img, fileMeta.baseName, fileMeta.ext, fileMeta.mimeType, file.name);
        } catch (initErr) {
          reportError('画像の初期化処理中にエラーが発生しました。', initErr);
        }
      };

      img.onerror = (err) => {
        URL.revokeObjectURL(objectUrl);
        reportError(
          `画像の読み込みに失敗しました (${file.name})。ファイルが破損しているか非対応の形式です。`,
          err
        );
      };

      img.src = objectUrl;
    } catch (err) {
      reportError('ファイル読み込み処理中に予期しないエラーが発生しました。', err);
    }
  }

  /**
   * 読み込まれた HTMLImageElement または Canvas から作業用キャンバス群・推奨モザイクサイズ・履歴を初期化します。
   * @param {HTMLImageElement|HTMLCanvasElement} imgSource
   * @param {string} baseName 拡張子を除いたファイル名
   * @param {string} ext 拡張子 ('.png' | '.jpg' | '.jpeg' | '.webp')
   * @param {string} mimeType MIMEタイプ ('image/png' | 'image/jpeg' | 'image/webp')
   * @param {string} displayFileName パネル表示用の完全ファイル名
   */
  function initializeWorkspaceWithImage(imgSource, baseName, ext, mimeType, displayFileName) {
    const width = imgSource.naturalWidth || imgSource.width;
    const height = imgSource.naturalHeight || imgSource.height;

    state.hasImage = true;
    state.imageWidth = width;
    state.imageHeight = height;
    state.baseFileName = baseName || 'image';
    state.originalExt = ext || '.png';
    state.mimeType = mimeType || 'image/png';
    state.rectSelection = null;
    state.rectDragMode = null;
    state.isCompareHold = false;
    state.isCompareToggle = false;
    state.activePointers.clear();
    state.isPinching = false;
    state.ignoreSinglePointerUntilAllReleased = false;
    updateCompareButtonUI();

    // オフスクリーンキャンバス群を画像実寸に設定して描画
    for (const c of [originalCanvas, workCanvas, previewCanvas]) {
      c.width = width;
      c.height = height;
    }

    originalCtx.clearRect(0, 0, width, height);
    originalCtx.drawImage(imgSource, 0, 0);

    workCtx.clearRect(0, 0, width, height);
    workCtx.drawImage(imgSource, 0, 0);

    previewCtx.clearRect(0, 0, width, height);
    previewCtx.drawImage(imgSource, 0, 0);

    // 推奨モザイクサイズの算出と常時表示の更新
    // 長辺が400px以上なら 推奨 = ceil(長辺/100)、最小4px
    const { longSide, recommended } = calculateRecommendedMosaic(width, height);
    state.recommendedMosaicSize = recommended;

    const formatLabel = mimeType.replace('image/', '').toUpperCase();
    dom.infoFileName.textContent = displayFileName;
    dom.infoFileName.title = displayFileName;
    dom.infoResolution.textContent = `${width} × ${height} px (${formatLabel})`;
    dom.infoLongSide.textContent = `${longSide} px`;
    dom.infoRecommendedSize.innerHTML = `${recommended} px <small>(推奨値)</small>`;
    dom.recommendedBtnValue.textContent = String(recommended);

    // 画像読み込み時に推奨モザイクサイズを初期セット
    setMosaicSize(recommended, false);

    // 初期画面を隠して操作ボタンを有効化
    dom.emptyStateBox.hidden = true;
    dom.saveBtn.disabled = false;
    dom.saveAsBtn.disabled = false;
    dom.compareHoldBtn.disabled = false;
    dom.compareToggleBtn.disabled = false;

    // 履歴スタック初期化 & 画面フィット表示
    initHistoryStack();
    updateRectActionUI();
    fitImageToViewport();

    showToast(
      `「${displayFileName}」(${width}×${height}px) を読み込みました。推奨モザイクサイズは ${recommended}px です。`,
      'success',
      4000
    );
  }

  /**
   * すぐに全機能をテストできるデモ用サンプル画像 (1280×800px, 長辺1280→推奨モザイク13px) を生成して読み込みます。
   */
  function loadGeneratedSampleImage() {
    try {
      hidePanelAlert();
      const sampleW = 1280;
      const sampleH = 800;
      const tempCanvas = document.createElement('canvas');
      tempCanvas.width = sampleW;
      tempCanvas.height = sampleH;
      const ctx = tempCanvas.getContext('2d');

      // 1. カラフルな背景グラデーション
      const bgGrad = ctx.createLinearGradient(0, 0, sampleW, sampleH);
      bgGrad.addColorStop(0, '#1e1b4b');
      bgGrad.addColorStop(0.5, '#0f172a');
      bgGrad.addColorStop(1, '#115e59');
      ctx.fillStyle = bgGrad;
      ctx.fillRect(0, 0, sampleW, sampleH);

      // 2. 背景の幾何学タイル模様
      for (let y = 0; y < sampleH; y += 80) {
        for (let x = 0; x < sampleW; x += 80) {
          ctx.fillStyle = ((x + y) / 80) % 2 === 0 ? 'rgba(255,255,255,0.03)' : 'rgba(0,0,0,0.08)';
          ctx.fillRect(x, y, 80, 80);
        }
      }

      // 3. 左側カード: 人物プロフィールカード風イラスト (モザイク練習対象1)
      ctx.fillStyle = '#ffffff';
      ctx.beginPath();
      ctx.roundRect(90, 110, 480, 560, 20);
      ctx.fill();

      // 人物アバター背景
      const avatarGrad = ctx.createLinearGradient(150, 150, 510, 430);
      avatarGrad.addColorStop(0, '#7b5cff');
      avatarGrad.addColorStop(1, '#00d4ff');
      ctx.fillStyle = avatarGrad;
      ctx.fillRect(130, 150, 400, 290);

      // 顔のイラスト
      ctx.fillStyle = '#fde68a';
      ctx.beginPath();
      ctx.arc(330, 275, 78, 0, Math.PI * 2);
      ctx.fill();
      ctx.fillStyle = '#1e293b';
      ctx.beginPath();
      ctx.arc(302, 260, 10, 0, Math.PI * 2);
      ctx.arc(358, 260, 10, 0, Math.PI * 2);
      ctx.fill();
      ctx.strokeStyle = '#ef4444';
      ctx.lineWidth = 6;
      ctx.beginPath();
      ctx.arc(330, 285, 34, 0.15 * Math.PI, 0.85 * Math.PI);
      ctx.stroke();

      // 氏名・ID風のダミーテキスト
      ctx.fillStyle = '#0f172a';
      ctx.font = 'bold 30px sans-serif';
      ctx.fillText('山田 太郎 / Taro Yamada', 135, 495);
      ctx.fillStyle = '#475569';
      ctx.font = '22px monospace';
      ctx.fillText('ID: 090-1234-5678 (秘密情報)', 135, 540);
      ctx.fillText('MAIL: secret-demo@example.jp', 135, 580);
      ctx.fillStyle = '#dc2626';
      ctx.font = 'bold 18px sans-serif';
      ctx.fillText('▲ ブラシや矩形選択でモザイクをかけてみましょう', 135, 630);

      // 4. 右側: ナンバープレート＆カラーチャート (モザイク練習対象2)
      ctx.fillStyle = '#f8fafc';
      ctx.strokeStyle = '#16a34a';
      ctx.lineWidth = 10;
      ctx.beginPath();
      ctx.roundRect(650, 120, 530, 250, 18);
      ctx.fill();
      ctx.stroke();

      ctx.fillStyle = '#15803d';
      ctx.font = 'bold 38px sans-serif';
      ctx.fillText('品川 300', 830, 190);
      ctx.font = 'bold 92px monospace';
      ctx.fillText('あ 12-34', 695, 315);

      // カラーグラデーションバー (平均色モザイクの確認用)
      const hues = ['#ef4444', '#f97316', '#eab308', '#22c55e', '#06b6d4', '#3b82f6', '#8b5cf6', '#ec4899'];
      const boxW = 530 / hues.length;
      for (let i = 0; i < hues.length; i++) {
        ctx.fillStyle = hues[i];
        ctx.fillRect(650 + i * boxW, 420, boxW, 130);
      }

      ctx.fillStyle = 'rgba(15, 23, 42, 0.85)';
      ctx.fillRect(650, 575, 530, 95);
      ctx.fillStyle = '#e2e8f0';
      ctx.font = 'bold 20px sans-serif';
      ctx.fillText('サンプル画像: 1280 × 800 px (長辺 1280px)', 675, 615);
      ctx.fillStyle = '#38bdf8';
      ctx.font = '18px sans-serif';
      ctx.fillText('推奨モザイクサイズ = ceil(1280 / 100) = 13 px', 675, 650);

      initializeWorkspaceWithImage(tempCanvas, 'sample_photo', '.png', 'image/png', 'sample_photo.png');
    } catch (err) {
      reportError('サンプル画像の生成に失敗しました。', err);
    }
  }

  /**
   * 既定の保存ファイル名（元ファイル名_mosaic.拡張子）を返します。
   * @returns {string}
   */
  function getDefaultSaveFileName() {
    const base = state.baseFileName || 'image';
    const ext = state.originalExt || '.png';
    return `${base}_mosaic${ext}`;
  }

  /**
   * ユーザー入力の保存ファイル名をサニタイズし、編集中画像の拡張子に揃えます。
   * - パス区切り文字 (/ や \) およびOS不正文字 (: * ? " < > | 制御文字) を除去
   * - 拡張子が無い場合は元の拡張子を補う
   * - 拡張子が元の形式と違う場合は元の拡張子に付け替える
   *
   * @param {string} rawName 入力されたファイル名
   * @returns {string} サニタイズ済みの安全なファイル名
   */
  function sanitizeSaveFileName(rawName) {
    const targetExt = state.originalExt || '.png';
    const defaultStem = `${state.baseFileName || 'image'}_mosaic`;

    // パス区切り文字およびファイル名不正文字・制御文字を除去
    let cleaned = String(rawName || '')
      .replace(/[\\/:*?"<>|\u0000-\u001f\u007f]/g, '')
      .trim();

    // 先頭の連続ドットを除去
    cleaned = cleaned.replace(/^\.+/, '').trim();

    if (!cleaned) {
      return `${defaultStem}${targetExt}`;
    }

    const lastDotIndex = cleaned.lastIndexOf('.');
    let stem = cleaned;

    if (lastDotIndex > 0) {
      const extPart = cleaned.slice(lastDotIndex);
      // 末尾がドットのみ、または拡張子形式 (.png, .jpg 等) の場合は元の拡張子に付け替えるためベース名のみ抽出
      if (extPart === '.' || /^\.(?:[a-zA-Z][a-zA-Z0-9]{0,9}|7z|3gp)$/i.test(extPart)) {
        stem = cleaned.slice(0, lastDotIndex).trim().replace(/\.+$/, '');
      }
    } else if (lastDotIndex === 0) {
      stem = '';
    }

    if (!stem) {
      stem = defaultStem;
    }

    return `${stem}${targetExt}`;
  }

  /**
   * File System Access API (showSaveFilePicker) 用のファイル種別フィルタ定義を
   * 現在編集中の画像形式に合わせて生成します。
   * @returns {Array<{ description: string, accept: Record<string, string[]> }>}
   */
  function getSaveFilePickerTypes() {
    const exportMime = state.mimeType || 'image/png';
    if (exportMime === 'image/jpeg') {
      return [
        {
          description: 'JPEG 画像',
          accept: { 'image/jpeg': ['.jpg', '.jpeg'] }
        }
      ];
    }
    if (exportMime === 'image/webp') {
      return [
        {
          description: 'WebP 画像',
          accept: { 'image/webp': ['.webp'] }
        }
      ];
    }
    return [
      {
        description: 'PNG 画像',
        accept: { 'image/png': ['.png'] }
      }
    ];
  }

  /**
   * 保存前の共通前処理を実行します。
   * パネルアラートを閉じ、未確定の矩形選択プレビューがある場合は保存漏れ防止のため自動確定します。
   */
  function prepareCanvasBeforeSave() {
    hidePanelAlert();
    if (state.rectSelection && state.rectSelection.w >= 1 && state.rectSelection.h >= 1) {
      confirmRectSelection(true);
    }
  }

  /**
   * 作業用オフスクリーンキャンバス (`workCanvas`) から元の画像形式を維持した Blob を生成します。
   * JPEG形式の場合は品質パラメータ 0.92 を適用します。
   * @returns {Promise<Blob | null>}
   */
  function createExportBlobFromWorkCanvas() {
    const exportMime = state.mimeType || 'image/png';
    const exportQuality = exportMime === 'image/jpeg' ? JPEG_EXPORT_QUALITY : undefined;
    return new Promise((resolve) => {
      workCanvas.toBlob((blob) => resolve(blob), exportMime, exportQuality);
    });
  }

  /**
   * 生成された画像 Blob を指定ファイル名でブラウザダウンロードとして保存します。
   * @param {Blob} blob 保存する画像データ
   * @param {string} outputFileName 保存ファイル名
   */
  function triggerBlobDownload(blob, outputFileName) {
    try {
      const downloadUrl = URL.createObjectURL(blob);
      const anchor = document.createElement('a');
      anchor.href = downloadUrl;
      anchor.download = outputFileName;
      document.body.appendChild(anchor);
      anchor.click();
      document.body.removeChild(anchor);

      window.setTimeout(() => URL.revokeObjectURL(downloadUrl), 3000);
      showToast(`「${outputFileName}」を保存しました`, 'success', 4000);
    } catch (dlErr) {
      reportError('ファイルのダウンロード処理に失敗しました。', dlErr);
    }
  }

  /**
   * 編集後の画像を元の形式維持（JPEGはquality 0.92）で保存します。
   * ファイル名が指定された場合はサニタイズしてその名前で保存し、
   * 省略時（既存の保存ボタンや Ctrl+S）は既定の「元ファイル名_mosaic.拡張子」で保存します。
   *
   * @param {string} [customFileName] 保存ファイル名（省略時は既定の _mosaic 名）
   */
  async function saveEditedImage(customFileName) {
    if (!state.hasImage) {
      return;
    }

    try {
      // 保存前の共通前処理（未確定の矩形選択の自動確定など）
      prepareCanvasBeforeSave();

      const outputFileName =
        typeof customFileName === 'string' && customFileName.trim() !== ''
          ? sanitizeSaveFileName(customFileName)
          : getDefaultSaveFileName();

      const blob = await createExportBlobFromWorkCanvas();
      if (!blob) {
        reportError('画像の保存データ生成に失敗しました。ブラウザのメモリ空き容量をご確認ください。');
        return;
      }

      triggerBlobDownload(blob, outputFileName);
    } catch (err) {
      reportError('画像の保存処理中にエラーが発生しました。', err);
    }
  }

  /**
   * 「名前を付けて保存」ボタンの処理。
   * - `window.showSaveFilePicker` が利用可能な環境ではファイル保存ダイアログを表示して保存します。
   * - 利用できない環境（Android Chrome等）では `prompt()` でファイル名を入力（キャンセル時は保存中止）し、
   *   サニタイズしたファイル名で共通保存処理 `saveEditedImage()` を呼び出します。
   */
  async function saveEditedImageAs() {
    if (!state.hasImage) {
      return;
    }

    try {
      // 保存前の共通前処理（未確定の矩形選択の自動確定など）
      prepareCanvasBeforeSave();

      const defaultFileName = getDefaultSaveFileName();

      // 1. File System Access API (window.showSaveFilePicker) が使える環境
      if (typeof window.showSaveFilePicker === 'function') {
        let fileHandle;
        try {
          fileHandle = await window.showSaveFilePicker({
            suggestedName: defaultFileName,
            types: getSaveFilePickerTypes()
          });
        } catch (pickerErr) {
          // ユーザーが保存ダイアログをキャンセルした場合はエラー表示せず終了
          if (pickerErr && pickerErr.name === 'AbortError') {
            return;
          }
          throw pickerErr;
        }

        const blob = await createExportBlobFromWorkCanvas();
        if (!blob) {
          reportError('画像の保存データ生成に失敗しました。ブラウザのメモリ空き容量をご確認ください。');
          return;
        }

        const writable = await fileHandle.createWritable();
        await writable.write(blob);
        await writable.close();

        const savedFileName = fileHandle.name || defaultFileName;
        showToast(`「${savedFileName}」を保存しました`, 'success', 4000);
        return;
      }

      // 2. showSaveFilePicker が使えない環境（Android Chrome等）では prompt() でファイル名を入力
      const rawInput = window.prompt('保存するファイル名を入力してください:', defaultFileName);
      if (rawInput === null) {
        // キャンセルされた場合は保存しない
        return;
      }

      const sanitizedFileName = sanitizeSaveFileName(rawInput);
      await saveEditedImage(sanitizedFileName);
    } catch (err) {
      reportError('画像の保存処理中にエラーが発生しました。', err);
    }
  }

  /* =========================================================================
   * 13. 原画比較 (Before / After) 制御
   * ========================================================================= */

  /**
   * 比較ボタンの見た目と `aria-pressed` 状態を更新します。
   */
  function updateCompareButtonUI() {
    const active = state.isCompareHold || state.isCompareToggle;
    dom.compareHoldBtn.classList.toggle('compare-active', state.isCompareHold);
    dom.compareToggleBtn.classList.toggle('compare-active', state.isCompareToggle);
    dom.compareToggleBtn.setAttribute('aria-pressed', String(state.isCompareToggle));
    dom.compareToggleBtn.textContent = state.isCompareToggle ? '原画固定: ON' : '原画固定: OFF';
    dom.compareActiveBadge.hidden = !active;
  }

  /**
   * 押している間の原画比較状態を設定します。
   * @param {boolean} holding
   */
  function setCompareHold(holding) {
    if (!state.hasImage) {
      return;
    }
    if (state.isCompareHold !== holding) {
      state.isCompareHold = holding;
      updateCompareButtonUI();
      renderDisplayCanvas();
    }
  }

  /**
   * 原画比較の固定トグルを切り替えます。
   */
  function toggleCompareFixed() {
    if (!state.hasImage) {
      return;
    }
    state.isCompareToggle = !state.isCompareToggle;
    updateCompareButtonUI();
    renderDisplayCanvas();
  }

  /* =========================================================================
   * 14. 画面を常に表示 (Wake Lock API) & 別ウィンドウ起動
   * ========================================================================= */

  /**
   * Screen Wake Lock API を用いて画面スリープ防止を切り替えます。
   * @param {boolean} enable
   */
  async function setScreenWakeLock(enable) {
    if (!('wakeLock' in navigator)) {
      dom.wakeLockToggle.checked = false;
      dom.wakeLockStatus.textContent = '非対応';
      dom.wakeLockStatus.classList.remove('active');
      showPanelAlert('お使いのブラウザ環境は Screen Wake Lock API に対応していません。', 'info');
      showToast('このブラウザは Wake Lock API に非対応です', 'warning');
      return;
    }

    try {
      if (enable) {
        if (!state.wakeLockSentinel) {
          state.wakeLockSentinel = await navigator.wakeLock.request('screen');
          state.wakeLockSentinel.addEventListener('release', () => {
            // タブ非表示等で解放された場合のイベント
            if (! dom.wakeLockToggle.checked) {
              dom.wakeLockStatus.textContent = 'OFF';
              dom.wakeLockStatus.classList.remove('active');
            }
          });
        }
        dom.wakeLockToggle.checked = true;
        dom.wakeLockStatus.textContent = 'ON';
        dom.wakeLockStatus.classList.add('active');
        showToast('画面を常に表示 (Wake Lock) を有効にしました', 'success', 2500);
      } else {
        if (state.wakeLockSentinel) {
          await state.wakeLockSentinel.release();
          state.wakeLockSentinel = null;
        }
        dom.wakeLockToggle.checked = false;
        dom.wakeLockStatus.textContent = 'OFF';
        dom.wakeLockStatus.classList.remove('active');
        showToast('画面を常に表示 (Wake Lock) を解除しました', 'info', 2200);
      }
    } catch (err) {
      dom.wakeLockToggle.checked = false;
      dom.wakeLockStatus.textContent = 'OFF';
      dom.wakeLockStatus.classList.remove('active');
      reportError('画面常時表示 (Wake Lock) の切り替えに失敗しました。', err);
    }
  }

  /**
   * アプリをコンパクトな独立した別ウィンドウ（ポップアップ）で開きます。
   */
  function openAppInSeparateWindow() {
    try {
      const popup = window.open(
        window.location.href,
        '_blank',
        'popup=yes,width=1160,height=800,menubar=no,toolbar=no,location=no,status=no'
      );
      if (!popup) {
        reportError('ポップアップがブロックされました。ブラウザの設定で別ウィンドウ表示を許可してください。');
      } else {
        showToast('別ウィンドウでアプリを開きました', 'info', 2500);
      }
    } catch (err) {
      reportError('別ウィンドウの起動に失敗しました。', err);
    }
  }

  /**
   * ショートカットキー説明 (.shortcut-bar / .shortcut-grid / .kbd-hint) の表示・非表示を一括制御します。
   * 仕様:
   * - 初期状態では body にクラスを付与せず (shortcuts-visible 無し)、3種類すべての説明を非表示にします。
   * - トグル時は body.shortcuts-visible クラスの付け替えと、トグルボタンの aria-expanded 属性更新を行います。
   * - 下部フッター (.shortcut-bar) の表示/非表示によりキャンバスビューポートの高さが変化するため、
   *   切り替え直後に resizeDisplayCanvas() を呼んでキャンバスサイズを即座に再調整します。
   *
   * @param {boolean} visible 表示する場合は true、非表示にする場合は false
   */
  function setShortcutsVisible(visible) {
    state.shortcutsVisible = Boolean(visible);
    document.body.classList.toggle('shortcuts-visible', state.shortcutsVisible);

    if (dom.toggleShortcutsBtn) {
      dom.toggleShortcutsBtn.setAttribute('aria-expanded', String(state.shortcutsVisible));
      dom.toggleShortcutsBtn.classList.toggle('shortcuts-toggle-active', state.shortcutsVisible);
    }
    if (dom.toggleShortcutsBtnText) {
      dom.toggleShortcutsBtnText.textContent = state.shortcutsVisible
        ? 'ショートカット説明: ON'
        : 'ショートカット説明: OFF';
    }

    // フッター (.shortcut-bar) の高さ増減に合わせて表示用キャンバスの解像度を再調整
    resizeDisplayCanvas();
  }

  /**
   * ショートカットキー説明の表示・非表示をトグル切り替えします。
   */
  function toggleShortcutsVisible() {
    setShortcutsVisible(!state.shortcutsVisible);
  }

  /* =========================================================================
   * 15. キャンバス上のマウス・ポインターイベント処理 & 2本指ピンチズーム
   * ========================================================================= */

  /**
   * 1本指での操作中に2本目の指が触れてピンチモードへ移行する際、
   * 進行中の1本指操作 (ブラシ描画・矩形選択ドラッグ・パン移動) を安全に中断します。
   *
   * 【履歴 (Undoスタック) や確定画像が壊れない理由】:
   * 1. ブラシ描画中 (`state.isBrushing`):
   *    本アプリではストローク中、確定用の `workCanvas` は一切書き換えず、`previewCanvas` 上でのみ
   *    モザイクセルを塗りつぶし、`pointerup` 時に初めて `workCanvas` へ転写して `pushHistorySnapshot()` を呼ぶ構造です。
   *    したがって、ピンチ移行時に `state.isBrushing = false` 等にリセットし、`previewCanvas` を
   *    ストローク開始前の `workCanvas` の内容で上書き復元するだけで、1本目の指が触れた瞬間に引かれた
   *    中途半端なモザイクを完全に破棄でき、`workCanvas` や `historyStack` は一切汚染されません。
   * 2. 矩形ドラッグ中 (`state.rectDragMode`):
   *    矩形選択も確定操作を行うまでは `previewCanvas` 上のプレビューのみであり、`workCanvas` や履歴は未変更です。
   *    - 新規作成ドラッグ中 (`rectDragMode === 'create'`) にピンチへ入った場合は、1本目の指で作りかけた
   *      中途半端な矩形を `cancelRectSelection()` で破棄し、`previewCanvas` を `workCanvas` に戻します。
   *    - 既存の選択矩形の移動・リサイズ中 (`state.rectInitialBox` がある場合) にピンチへ入った場合は、
   *      ドラッグ開始前の矩形 (`state.rectInitialBox`) に巻き戻してプレビューを再計算することで、
   *      既存の選択枠を失わずにドラッグ変形だけを安全に中断します。
   * 3. パン移動中 (`state.isPanning`):
   *    `state.isPanning = false` に戻すことで、そのまま2本指中点によるパン移動へシームレスに移行します。
   */
  function abortOngoingSinglePointerActionForPinch() {
    // 1. パン操作の中断
    if (state.isPanning) {
      state.isPanning = false;
    }

    // 2. ブラシストロークの中断 (previewCanvas を確定済み workCanvas で復元し、履歴には追加しない)
    if (state.isBrushing) {
      state.isBrushing = false;
      state.brushVisitedCells = null;
      state.brushTouchedAny = false;
      if (state.hasImage) {
        previewCtx.clearRect(0, 0, state.imageWidth, state.imageHeight);
        previewCtx.drawImage(workCanvas, 0, 0);
      }
    }

    // 3. 矩形選択ドラッグの中断
    if (state.rectDragMode) {
      const mode = state.rectDragMode;
      const initialBox = state.rectInitialBox;
      state.rectDragMode = null;
      state.rectInitialBox = null;

      if (mode === 'create') {
        // 1本目の指で新規にドラッグし始めたばかりの矩形はキャンセルして破棄
        cancelRectSelection();
      } else if (initialBox && state.hasImage) {
        // 既存矩形の移動やリサイズ中だった場合はドラッグ開始前の矩形に戻す
        state.rectSelection = { ...initialBox };
        updateRectMosaicPreview();
      }
    }
  }

  /**
   * `state.activePointers` の先頭2本のポインタ座標から、
   * 2本指の距離 (`dist`) とビューポート左上基準の中点 (`midVx`, `midVy`) を算出します。
   *
   * @returns {{ dist: number, midVx: number, midVy: number } | null}
   */
  function getTwoPointersGeometry() {
    if (state.activePointers.size < 2) {
      return null;
    }
    const iter = state.activePointers.values();
    const p1 = iter.next().value;
    const p2 = iter.next().value;

    const rect = dom.canvasViewport.getBoundingClientRect();
    const midClientX = (p1.clientX + p2.clientX) / 2;
    const midClientY = (p1.clientY + p2.clientY) / 2;

    const midVx = midClientX - rect.left;
    const midVy = midClientY - rect.top;
    const dist = Math.hypot(p2.clientX - p1.clientX, p2.clientY - p1.clientY);

    return { dist, midVx, midVy };
  }

  /**
   * アクティブなポインタが2本になった時点でピンチモードを開始します。
   * 進行中の1本指操作を安全に中断し、全ての指が離れるまで1本指描画を再開しないロックをかけます。
   */
  function startPinchGesture() {
    abortOngoingSinglePointerActionForPinch();

    state.isPinching = true;
    state.ignoreSinglePointerUntilAllReleased = true;

    const geom = getTwoPointersGeometry();
    if (geom) {
      // ゼロ除算防止のため最小距離を 1px 以上に保証
      state.pinchStartDist = Math.max(1, geom.dist);
      state.pinchStartZoom = state.zoom;
      state.pinchPrevMidVx = geom.midVx;
      state.pinchPrevMidVy = geom.midVy;
    }

    updateCanvasCursorStyle();
    renderDisplayCanvas();
  }

  /**
   * 2本指ピンチ中のポインタ移動に応じて、中点基準のズームおよび2本指ドラッグによるパンを同時実行します。
   * 既存の `setZoomLevel(倍率, 中心x, 中心y)` の仕組みを活かしてズーム範囲 (0.1〜8.0倍) でクランプします。
   */
  function updatePinchGesture() {
    if (!state.hasImage || !state.isPinching || state.activePointers.size < 2) {
      return;
    }

    const geom = getTwoPointersGeometry();
    if (!geom) {
      return;
    }

    // 1. 前回フレームの中点から今回の中点への移動量をパンオフセットに加算 (2本指ドラッグ移動)
    const deltaMidX = geom.midVx - state.pinchPrevMidVx;
    const deltaMidY = geom.midVy - state.pinchPrevMidVy;
    state.panX += deltaMidX;
    state.panY += deltaMidY;

    // 2. 2本指の距離の変化率から目標ズーム倍率を計算し、既存のズーム範囲 (MIN_ZOOM=0.1 〜 MAX_ZOOM=8.0) でクランプ
    const currentDist = Math.max(1, geom.dist);
    const scaleRatio = currentDist / Math.max(1, state.pinchStartDist);
    const rawTargetZoom = state.pinchStartZoom * scaleRatio;
    const clampedZoom = Math.max(MIN_ZOOM, Math.min(MAX_ZOOM, rawTargetZoom));

    // 2本指の中点 (geom.midVx, geom.midVy) を中心として setZoomLevel で拡大・縮小および再描画を実行
    setZoomLevel(clampedZoom, geom.midVx, geom.midVy);

    // ズーム倍率が上下限 (0.1倍 または 8.0倍) に達している場合は、逆方向へピンチした際に即座に反応できるよう基準を更新
    if (rawTargetZoom < MIN_ZOOM || rawTargetZoom > MAX_ZOOM) {
      state.pinchStartDist = currentDist;
      state.pinchStartZoom = state.zoom;
    }

    // 3. 次回フレーム用に現在の中点座標を保存
    state.pinchPrevMidVx = geom.midVx;
    state.pinchPrevMidVy = geom.midVy;
  }

  /**
   * キャンバス上でポインターが押下されたときの処理
   * @param {PointerEvent} e
   */
  function handleCanvasPointerDown(e) {
    // マウスの右クリック等の非対象ボタンは無視（タッチや左・中クリックのみ対象）
    if (e.pointerType === 'mouse' && e.button !== 0 && e.button !== 1) {
      return;
    }

    // キャンバスに触れているアクティブなポインタを Map (pointerId → 座標) に登録して追跡
    state.activePointers.set(e.pointerId, {
      clientX: e.clientX,
      clientY: e.clientY
    });
    try {
      dom.displayCanvas.setPointerCapture(e.pointerId);
    } catch (_) {
      // 合成イベント等で pointerId がキャプチャ不可な環境でもエラーにしない
    }

    // ポインタが2本以上になったらピンチモードに入る (進行中の1本指操作は安全に中断)
    if (state.activePointers.size >= 2) {
      e.preventDefault();
      if (state.hasImage) {
        startPinchGesture();
      } else {
        state.ignoreSinglePointerUntilAllReleased = true;
      }
      return;
    }

    // ピンチ後にまだ全ての指が離れていない場合は、残った指や再タッチで描画が再開されないよう無視する
    if (state.ignoreSinglePointerUntilAllReleased) {
      e.preventDefault();
      return;
    }

    if (!state.hasImage) {
      return;
    }

    dom.canvasViewport.focus({ preventScroll: true });
    const coords = clientToImageCoords(e.clientX, e.clientY);
    state.cursorViewportX = coords.vx;
    state.cursorViewportY = coords.vy;
    state.cursorImageX = coords.ix;
    state.cursorImageY = coords.iy;

    // 1. 中ボタンドラッグ (button === 1)、または Spaceキー押下中、またはパン移動ツール時はパン操作を開始
    if (e.button === 1 || (e.button === 0 && (state.isSpacePressed || state.currentTool === 'pan'))) {
      e.preventDefault();
      state.isPanning = true;
      state.panStartClientX = e.clientX;
      state.panStartClientY = e.clientY;
      state.panOriginX = state.panX;
      state.panOriginY = state.panY;
      updateCanvasCursorStyle();
      return;
    }

    // 左クリック（または1本指タッチ・ペン）以外は無視
    if (e.button !== 0) {
      return;
    }

    // 原画比較固定がONのときに編集しようとしたら自動的に解除して編集可能にする
    if (state.isCompareToggle) {
      state.isCompareToggle = false;
      updateCompareButtonUI();
    }

    // 2. ブラシツールでのストローク開始
    if (state.currentTool === 'brush') {
      e.preventDefault();
      state.isBrushing = true;
      state.lastBrushImageX = coords.ix;
      state.lastBrushImageY = coords.iy;
      state.brushTouchedAny = false;

      const step = Math.max(1, state.mosaicSize);
      state.brushGridCols = Math.ceil(state.imageWidth / step);
      state.brushGridRows = Math.ceil(state.imageHeight / step);
      state.brushVisitedCells = new Uint8Array(state.brushGridCols * state.brushGridRows);

      // ストローク開始時点の workCanvas を previewCanvas にコピー
      previewCtx.clearRect(0, 0, state.imageWidth, state.imageHeight);
      previewCtx.drawImage(workCanvas, 0, 0);

      applyBrushStampAtPoint(coords.ix, coords.iy);
      renderDisplayCanvas();
      return;
    }

    // 3. 矩形選択ツールでのドラッグ開始 (新規作成 / 既存矩形の移動 / リサイズ)
    if (state.currentTool === 'rect') {
      e.preventDefault();
      const hitMode = hitTestRectSelection(coords.vx, coords.vy);

      if (hitMode && state.rectSelection) {
        // 既存の選択矩形の移動またはハンドルリサイズ
        state.rectDragMode = hitMode;
        state.rectDragStartImgX = coords.ix;
        state.rectDragStartImgY = coords.iy;
        state.rectInitialBox = { ...state.rectSelection };
      } else {
        // 新しい矩形のドラッグ選択を開始
        state.rectDragMode = 'create';
        state.rectDragStartImgX = Math.max(0, Math.min(state.imageWidth, coords.ix));
        state.rectDragStartImgY = Math.max(0, Math.min(state.imageHeight, coords.iy));
        state.rectSelection = {
          x: Math.round(state.rectDragStartImgX),
          y: Math.round(state.rectDragStartImgY),
          w: 0,
          h: 0
        };
        updateRectMosaicPreview();
      }

      renderDisplayCanvas();
    }
  }

  /**
   * キャンバス上でポインターが移動したときの処理
   * @param {PointerEvent} e
   */
  function handleCanvasPointerMove(e) {
    // 追跡中のアクティブポインタであれば最新座標を Map に反映
    if (state.activePointers.has(e.pointerId)) {
      state.activePointers.set(e.pointerId, {
        clientX: e.clientX,
        clientY: e.clientY
      });
    }

    // 2本指ピンチモード中はピンチズーム＆2本指パンのみを行い、1本指の描画処理は行わない
    if (state.isPinching) {
      if (state.hasImage && state.activePointers.size >= 2) {
        e.preventDefault();
        updatePinchGesture();
      }
      return;
    }

    // ピンチ中に指が1本に戻った後、全ての指が離れるまでは残った指での描画再開を無視する
    if (state.ignoreSinglePointerUntilAllReleased) {
      return;
    }

    const coords = clientToImageCoords(e.clientX, e.clientY);
    state.cursorInCanvas = true;
    state.cursorViewportX = coords.vx;
    state.cursorViewportY = coords.vy;
    state.cursorImageX = coords.ix;
    state.cursorImageY = coords.iy;

    // ステータスバーの座標表示更新
    if (state.hasImage) {
      const dispX = Math.round(coords.ix);
      const dispY = Math.round(coords.iy);
      dom.statusCoords.textContent = `X: ${dispX} , Y: ${dispY}`;
    }

    // 1. パン移動中
    if (state.isPanning) {
      const dx = e.clientX - state.panStartClientX;
      const dy = e.clientY - state.panStartClientY;
      state.panX = state.panOriginX + dx;
      state.panY = state.panOriginY + dy;
      renderDisplayCanvas();
      return;
    }

    // 2. ブラシ塗装中
    if (state.isBrushing) {
      applyBrushStrokeSegment(state.lastBrushImageX, state.lastBrushImageY, coords.ix, coords.iy);
      state.lastBrushImageX = coords.ix;
      state.lastBrushImageY = coords.iy;
      renderDisplayCanvas();
      return;
    }

    // 3. 矩形選択ドラッグ中 (作成 / 移動 / リサイズ)
    if (state.currentTool === 'rect' && state.rectDragMode) {
      const dx = coords.ix - state.rectDragStartImgX;
      const dy = coords.iy - state.rectDragStartImgY;

      if (state.rectDragMode === 'create') {
        state.rectSelection = normalizeRectToImageBounds({
          x: state.rectDragStartImgX,
          y: state.rectDragStartImgY,
          w: dx,
          h: dy
        });
      } else if (state.rectDragMode === 'move' && state.rectInitialBox) {
        const init = state.rectInitialBox;
        const newX = Math.max(0, Math.min(state.imageWidth - init.w, Math.round(init.x + dx)));
        const newY = Math.max(0, Math.min(state.imageHeight - init.h, Math.round(init.y + dy)));
        state.rectSelection = { x: newX, y: newY, w: init.w, h: init.h };
      } else if (state.rectInitialBox) {
        const init = state.rectInitialBox;
        let x1 = init.x;
        let y1 = init.y;
        let x2 = init.x + init.w;
        let y2 = init.y + init.h;

        if (state.rectDragMode.includes('w')) x1 += dx;
        if (state.rectDragMode.includes('e')) x2 += dx;
        if (state.rectDragMode.includes('n')) y1 += dy;
        if (state.rectDragMode.includes('s')) y2 += dy;

        state.rectSelection = normalizeRectToImageBounds({
          x: x1,
          y: y1,
          w: x2 - x1,
          h: y2 - y1
        });
      }

      updateRectMosaicPreview();
      renderDisplayCanvas();
      return;
    }

    // 通常ホバー時（ブラシ円プレビュー追従やカーソル更新）
    updateCanvasCursorStyle();
    if (state.hasImage && state.currentTool === 'brush') {
      renderDisplayCanvas();
    }
  }

  /**
   * キャンバス上でポインターが離された、またはキャンセルされたときの処理 (`pointerup` / `pointercancel` 共通)
   * @param {PointerEvent} e
   */
  function handleCanvasPointerUp(e) {
    if (dom.displayCanvas.hasPointerCapture(e.pointerId)) {
      try {
        dom.displayCanvas.releasePointerCapture(e.pointerId);
      } catch (_) {
        // キャプチャ解放失敗時は無視
      }
    }

    // 離れた（またはキャンセルされた）ポインタを Map から確実に削除
    state.activePointers.delete(e.pointerId);

    // ピンチ操作中、またはピンチ後の全指リリース待ち状態だった場合の処理
    if (state.isPinching || state.ignoreSinglePointerUntilAllReleased) {
      if (state.activePointers.size >= 2 && state.hasImage) {
        // 3本指以上から1本離れて2本指が残っている場合は、残りの2本指でピンチ基準を再初期化して継続
        startPinchGesture();
      } else {
        // ポインタが2本未満になったらピンチ自体は終了
        state.isPinching = false;
        // 全ての指がキャンバスから離れた時点で初めて1本指描画ロックを解除する
        if (state.activePointers.size === 0) {
          state.ignoreSinglePointerUntilAllReleased = false;
        }
        updateCanvasCursorStyle();
        renderDisplayCanvas();
      }
      return;
    }

    // 1. パン終了
    if (state.isPanning) {
      state.isPanning = false;
      updateCanvasCursorStyle();
      renderDisplayCanvas();
      return;
    }

    // 2. ブラシストローク終了 → workCanvasへ確定し、履歴に追加
    if (state.isBrushing) {
      state.isBrushing = false;
      state.brushVisitedCells = null;

      if (state.brushTouchedAny) {
        workCtx.clearRect(0, 0, state.imageWidth, state.imageHeight);
        workCtx.drawImage(previewCanvas, 0, 0);
        pushHistorySnapshot();
      }
      renderDisplayCanvas();
      return;
    }

    // 3. 矩形選択ドラッグ終了 → 選択範囲が極小(2px未満)なら解除、それ以外は未確定プレビューとして維持
    if (state.rectDragMode) {
      state.rectDragMode = null;
      state.rectInitialBox = null;
      if (state.rectSelection && (state.rectSelection.w < 2 || state.rectSelection.h < 2)) {
        cancelRectSelection();
      } else {
        updateRectMosaicPreview();
        renderDisplayCanvas();
      }
      updateCanvasCursorStyle();
    }
  }

  /* =========================================================================
   * 16. イベントリスナーの登録 (マウス / キーボードショートカット / D&D / SW)
   * ========================================================================= */

  function bindAllEvents() {
    // パネルアラート閉じるボタン
    dom.panelAlertCloseBtn.addEventListener('click', hidePanelAlert);

    // 画像を開くボタン & ファイルinput変更
    const triggerFileSelect = () => {
      dom.fileInput.value = '';
      dom.fileInput.click();
    };
    dom.openFileBtn.addEventListener('click', triggerFileSelect);
    dom.emptyOpenBtn.addEventListener('click', triggerFileSelect);
    dom.fileInput.addEventListener('change', (e) => {
      const file = e.target.files && e.target.files[0];
      if (file) {
        loadImageFromFile(file);
      }
    });

    // サンプル画像読み込みボタン
    dom.loadSampleBtn.addEventListener('click', loadGeneratedSampleImage);
    dom.emptySampleBtn.addEventListener('click', loadGeneratedSampleImage);

    // 推奨値適用ボタン
    dom.applyRecommendedBtn.addEventListener('click', () => {
      setMosaicSize(state.recommendedMosaicSize, true);
      showToast(`推奨モザイクサイズ (${state.recommendedMosaicSize}px) を適用しました`, 'info', 2200);
    });

    // ツール切替ボタン
    dom.toolBrushBtn.addEventListener('click', () => selectTool('brush'));
    dom.toolRectBtn.addEventListener('click', () => selectTool('rect'));
    dom.toolPanBtn.addEventListener('click', () => selectTool('pan'));

    // 矩形選択の確定・解除ボタン (パネル内 & フローティングバー両方)
    dom.confirmRectBtn.addEventListener('click', () => confirmRectSelection(false));
    dom.floatingConfirmBtn.addEventListener('click', () => confirmRectSelection(false));
    dom.cancelRectBtn.addEventListener('click', cancelRectSelection);
    dom.floatingCancelBtn.addEventListener('click', cancelRectSelection);

    // モザイクサイズ連動 (スライダー & 数値入力)
    dom.mosaicSizeSlider.addEventListener('input', (e) => {
      setMosaicSize(e.target.value, true);
    });
    dom.mosaicSizeInput.addEventListener('input', (e) => {
      if (e.target.value !== '') {
        setMosaicSize(e.target.value, true);
      }
    });
    dom.mosaicSizeInput.addEventListener('change', (e) => {
      setMosaicSize(e.target.value || state.mosaicSize, true);
    });

    // ブラシサイズ連動 (スライダー & 数値入力)
    dom.brushSizeSlider.addEventListener('input', (e) => {
      setBrushSize(e.target.value);
    });
    dom.brushSizeInput.addEventListener('input', (e) => {
      if (e.target.value !== '') {
        setBrushSize(e.target.value);
      }
    });
    dom.brushSizeInput.addEventListener('change', (e) => {
      setBrushSize(e.target.value || state.brushSize);
    });

    // Undo / Redo ボタン
    dom.undoBtn.addEventListener('click', performUndo);
    dom.redoBtn.addEventListener('click', performRedo);

    // 原画比較ボタン (押している間 & トグル固定)
    dom.compareHoldBtn.addEventListener('pointerdown', (e) => {
      e.preventDefault();
      setCompareHold(true);
    });
    window.addEventListener('pointerup', () => {
      if (state.isCompareHold) {
        setCompareHold(false);
      }
    });
    dom.compareHoldBtn.addEventListener('pointerleave', () => {
      if (state.isCompareHold) {
        setCompareHold(false);
      }
    });
    dom.compareToggleBtn.addEventListener('click', toggleCompareFixed);

    // 保存ボタン & 名前を付けて保存ボタン
    dom.saveBtn.addEventListener('click', () => saveEditedImage());
    dom.saveAsBtn.addEventListener('click', saveEditedImageAs);

    // Wake Lock トグル & 別ウィンドウ起動
    dom.wakeLockToggle.addEventListener('change', (e) => {
      setScreenWakeLock(e.target.checked);
    });
    document.addEventListener('visibilitychange', () => {
      // タブが再度アクティブになった際、トグルがONならWake Lockを再取得
      if (document.visibilityState === 'visible' && dom.wakeLockToggle.checked) {
        setScreenWakeLock(true);
      }
    });
    dom.openWindowBtn.addEventListener('click', openAppInSeparateWindow);

    // ショートカットキー説明の表示/非表示トグルボタン
    dom.toggleShortcutsBtn.addEventListener('click', toggleShortcutsVisible);

    // ズームボタン群
    dom.zoomInBtn.addEventListener('click', () => setZoomLevel(state.zoom * 1.25));
    dom.zoomOutBtn.addEventListener('click', () => setZoomLevel(state.zoom / 1.25));
    dom.zoomResetBtn.addEventListener('click', () => setZoomLevel(1.0));
    dom.zoomFitBtn.addEventListener('click', fitImageToViewport);

    // キャンバスポインター操作
    dom.displayCanvas.addEventListener('pointerdown', handleCanvasPointerDown);
    dom.displayCanvas.addEventListener('pointermove', handleCanvasPointerMove);
    dom.displayCanvas.addEventListener('pointerup', handleCanvasPointerUp);
    dom.displayCanvas.addEventListener('pointercancel', handleCanvasPointerUp);
    dom.displayCanvas.addEventListener('pointerleave', () => {
      state.cursorInCanvas = false;
      dom.statusCoords.textContent = 'X: - , Y: -';
      if (state.hasImage && !state.isBrushing && !state.rectDragMode) {
        renderDisplayCanvas();
      }
    });

    // ダブルクリックで矩形選択モザイクを確定 (仕様: 「確定ボタン/ダブルクリック/Enterで適用」)
    dom.displayCanvas.addEventListener('dblclick', (e) => {
      if (state.hasImage && state.currentTool === 'rect' && state.rectSelection) {
        e.preventDefault();
        confirmRectSelection(false);
      }
    });

    // 中クリック時のブラウザ自動スクロールアイコン抑止
    dom.canvasViewport.addEventListener('mousedown', (e) => {
      if (e.button === 1) {
        e.preventDefault();
      }
    });

    // マウスホイールによるズーム操作 (0.1〜8.0倍、カーソル位置中心)
    dom.canvasViewport.addEventListener(
      'wheel',
      (e) => {
        e.preventDefault();
        if (!state.hasImage) {
          return;
        }
        const coords = clientToImageCoords(e.clientX, e.clientY);
        const zoomFactor = e.deltaY < 0 ? 1.12 : 1 / 1.12;
        setZoomLevel(state.zoom * zoomFactor, coords.vx, coords.vy);
      },
      { passive: false }
    );

    // ドラッグ＆ドロップによる画像読み込み
    let dragEnterCount = 0;
    window.addEventListener('dragenter', (e) => {
      if (e.dataTransfer && Array.from(e.dataTransfer.types).includes('Files')) {
        e.preventDefault();
        dragEnterCount++;
        dom.dropOverlay.hidden = false;
      }
    });
    window.addEventListener('dragover', (e) => {
      if (e.dataTransfer && Array.from(e.dataTransfer.types).includes('Files')) {
        e.preventDefault();
        e.dataTransfer.dropEffect = 'copy';
      }
    });
    window.addEventListener('dragleave', (e) => {
      if (e.dataTransfer && Array.from(e.dataTransfer.types).includes('Files')) {
        dragEnterCount = Math.max(0, dragEnterCount - 1);
        if (dragEnterCount === 0) {
          dom.dropOverlay.hidden = true;
        }
      }
    });
    window.addEventListener('drop', (e) => {
      e.preventDefault();
      dragEnterCount = 0;
      dom.dropOverlay.hidden = true;
      const files = e.dataTransfer && e.dataTransfer.files;
      if (files && files.length > 0) {
        loadImageFromFile(files[0]);
      }
    });

    // ウィンドウリサイズ対応
    window.addEventListener('resize', () => {
      resizeDisplayCanvas();
    });

    // キーボードショートカット (B, R, Ctrl+Z, Ctrl+Shift+Z/Ctrl+Y, Ctrl+S, Ctrl+O, H, +/-/0, Enter, Esc, Space)
    window.addEventListener('keydown', (e) => {
      const activeTag = document.activeElement ? document.activeElement.tagName.toLowerCase() : '';
      const isInputFocused = activeTag === 'input' || activeTag === 'textarea' || activeTag === 'select';
      const isCtrlOrMeta = e.ctrlKey || e.metaKey;
      const lowerKey = e.key.toLowerCase();

      // Ctrl/Cmd + S : 保存 (ブラウザ既定のページ保存を防止)
      if (isCtrlOrMeta && lowerKey === 's') {
        e.preventDefault();
        if (state.hasImage) {
          saveEditedImage();
        }
        return;
      }

      // Ctrl/Cmd + O : 画像を開く (ブラウザ既定を防止)
      if (isCtrlOrMeta && lowerKey === 'o') {
        e.preventDefault();
        triggerFileSelect();
        return;
      }

      // Ctrl/Cmd + Z / Ctrl+Shift+Z / Ctrl+Y : Undo / Redo
      if (isCtrlOrMeta && !isInputFocused) {
        if (lowerKey === 'z') {
          e.preventDefault();
          if (e.shiftKey) {
            performRedo();
          } else {
            performUndo();
          }
          return;
        }
        if (lowerKey === 'y') {
          e.preventDefault();
          performRedo();
          return;
        }
      }

      // 数値入力欄フォーカス中に Enter が押された場合はフォーカスを外し、矩形選択中なら確定も行う
      if (isInputFocused) {
        if (e.key === 'Enter') {
          document.activeElement.blur();
          if (state.rectSelection) {
            confirmRectSelection(false);
          }
        }
        return;
      }

      // 単一キーショートカット
      if (!isCtrlOrMeta && !e.altKey) {
        if (lowerKey === 'b') {
          e.preventDefault();
          selectTool('brush');
        } else if (lowerKey === 'r') {
          e.preventDefault();
          selectTool('rect');
        } else if (lowerKey === 'h') {
          e.preventDefault();
          setCompareHold(true);
        } else if (e.key === '+' || e.key === '=') {
          e.preventDefault();
          setZoomLevel(state.zoom * 1.25);
        } else if (e.key === '-' || e.key === '_') {
          e.preventDefault();
          setZoomLevel(state.zoom / 1.25);
        } else if (e.key === '0') {
          e.preventDefault();
          setZoomLevel(1.0);
        } else if (e.key === 'Enter') {
          if (state.rectSelection) {
            e.preventDefault();
            confirmRectSelection(false);
          }
        } else if (e.key === 'Escape') {
          if (state.rectSelection) {
            e.preventDefault();
            cancelRectSelection();
          }
        } else if (e.code === 'Space') {
          e.preventDefault();
          if (!state.isSpacePressed) {
            state.isSpacePressed = true;
            updateCanvasCursorStyle();
            renderDisplayCanvas();
          }
        }
      }
    });

    window.addEventListener('keyup', (e) => {
      const lowerKey = e.key.toLowerCase();
      if (lowerKey === 'h') {
        setCompareHold(false);
      } else if (e.code === 'Space') {
        state.isSpacePressed = false;
        updateCanvasCursorStyle();
        renderDisplayCanvas();
      }
    });

    // PWA インストールプロンプトの捕捉
    window.addEventListener('beforeinstallprompt', (e) => {
      e.preventDefault();
      state.deferredInstallPrompt = e;
      dom.installPwaBtn.hidden = false;
    });

    dom.installPwaBtn.addEventListener('click', async () => {
      if (!state.deferredInstallPrompt) {
        return;
      }
      try {
        state.deferredInstallPrompt.prompt();
        await state.deferredInstallPrompt.userChoice;
        state.deferredInstallPrompt = null;
        dom.installPwaBtn.hidden = true;
      } catch (err) {
        reportError('PWAのインストール処理に失敗しました。', err);
      }
    });
  }

  /* =========================================================================
   * 17. Service Worker 登録処理 (エラーハンドリング付き)
   * ========================================================================= */

  async function registerServiceWorker() {
    if (!('serviceWorker' in navigator)) {
      return;
    }
    // file:// プロトコルで直接開かれた場合はSWが動作しないため案内のみ行う
    if (window.location.protocol === 'file:') {
      showPanelAlert(
        'ローカルファイル(file://)として直接開かれているためService Workerは無効です。PWA機能・オフラインキャッシュを利用するには静的HTTPサーバー経由で開いてください。',
        'info'
      );
      return;
    }

    try {
      const registration = await navigator.serviceWorker.register('./sw.js', { scope: './' });
      console.info('[PWA] Service Worker 登録成功:', registration.scope);
    } catch (err) {
      reportError('Service Worker の登録に失敗しました。オフラインキャッシュ機能が無効化されています。', err);
    }
  }

  /* =========================================================================
   * 18. アプリケーション起動エントリポイント
   * ========================================================================= */

  function initApp() {
    bindAllEvents();
    // 初期状態ではショートカット説明を非表示 (body.shortcuts-visible クラス無し) に設定
    setShortcutsVisible(false);
    setMosaicSize(state.mosaicSize, false);
    setBrushSize(state.brushSize);
    resizeDisplayCanvas();
    registerServiceWorker();
  }

  initApp();
})();

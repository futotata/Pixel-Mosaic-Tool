/**
 * Pixel Mosaic Tool - Service Worker (sw.js)
 *
 * 同一オリジンの静的ファイルをキャッシュし、オフライン環境でも
 * PWAとして単一完結で動作できるようにするためのService Workerです。
 */

// キャッシュバージョン名（ファイル更新時はバージョン番号を上げることで古いキャッシュを破棄: v6 -> v7）
const CACHE_NAME = 'pixel-mosaic-tool-v7';

// インストール時に事前キャッシュする同一オリジン静的アセット一覧
const STATIC_ASSETS = [
  './',
  './index.html',
  './install.html',
  './style.css',
  './app.js',
  './manifest.webmanifest',
  './icons/icon-192.png',
  './icons/icon-512.png',
  './icons/icon.svg'
];

/**
 * インストールイベント
 * アプリに必要な静的ファイル一式をキャッシュストレージに保存します。
 */
self.addEventListener('install', (event) => {
  event.waitUntil(
    (async () => {
      try {
        const cache = await caches.open(CACHE_NAME);
        // 各アセットを確実にキャッシュ（万が一特定ファイルが欠けていても他のキャッシュを継続）
        await Promise.all(
          STATIC_ASSETS.map(async (assetUrl) => {
            try {
              const response = await fetch(assetUrl, { cache: 'no-cache' });
              if (response && response.ok) {
                await cache.put(assetUrl, response);
              }
            } catch (assetErr) {
              console.warn('[Service Worker] 個別アセットの事前キャッシュをスキップ:', assetUrl, assetErr);
            }
          })
        );
        // 新しいService Workerを待機させず即座にアクティブ化
        await self.skipWaiting();
      } catch (err) {
        console.error('[Service Worker] インストール時のキャッシュ処理に失敗しました:', err);
      }
    })()
  );
});

/**
 * アクティベートイベント
 * 古いバージョンのキャッシュが存在する場合は削除し、即座にページ制御を開始します。
 */
self.addEventListener('activate', (event) => {
  event.waitUntil(
    (async () => {
      try {
        const cacheKeys = await caches.keys();
        await Promise.all(
          cacheKeys.map((key) => {
            if (key !== CACHE_NAME) {
              console.info('[Service Worker] 古いキャッシュを削除します:', key);
              return caches.delete(key);
            }
            return Promise.resolve();
          })
        );
        // 開いているすべてのクライアント（タブ/ウィンドウ）を即座に制御下に置く
        await self.clients.claim();
      } catch (err) {
        console.error('[Service Worker] アクティベート処理中にエラーが発生しました:', err);
      }
    })()
  );
});

/**
 * フェッチイベント
 * 同一オリジンのGETリクエストに対して「キャッシュ優先 (Cache First) + ネットワークフォールバック」で応答します。
 */
self.addEventListener('fetch', (event) => {
  const { request } = event;

  // GETメソッド以外（POSTなど）はキャッシュ対象外
  if (request.method !== 'GET') {
    return;
  }

  const requestUrl = new URL(request.url);

  // 同一オリジンの静的ファイルリクエストのみをキャッシュ対象として処理
  if (requestUrl.origin === self.location.origin) {
    event.respondWith(
      (async () => {
        try {
          const cache = await caches.open(CACHE_NAME);

          // 1. まずキャッシュ内に一致するレスポンスがあるか確認
          const cachedResponse = await cache.match(request);
          if (cachedResponse) {
            return cachedResponse;
          }

          // 2. キャッシュになければネットワークから取得し、正常ならキャッシュに保存して返す
          const networkResponse = await fetch(request);
          if (networkResponse && networkResponse.status === 200 && networkResponse.type === 'basic') {
            cache.put(request, networkResponse.clone());
          }
          return networkResponse;
        } catch (err) {
          // 3. オフライン等でネットワーク取得に失敗した場合のフォールバック
          const cache = await caches.open(CACHE_NAME);
          if (request.mode === 'navigate') {
            const fallbackPage = await cache.match('./index.html') || await cache.match('./');
            if (fallbackPage) {
              return fallbackPage;
            }
          }
          console.warn('[Service Worker] オフラインのためリソースを取得できませんでした:', request.url, err);
          return new Response('オフラインのためリソースを読み込めませんでした。', {
            status: 503,
            statusText: 'Service Unavailable',
            headers: { 'Content-Type': 'text/plain; charset=utf-8' }
          });
        }
      })()
    );
  }
});

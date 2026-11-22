# GGE Tracker（Web + API 統合構成）

Web フロントエンド（Vue 3 + Vite）と API バックエンド（Cloudflare Workers + D1）およびテスト一式をまとめたプロジェクトです。

## ディレクトリ構成

- `src/` — Web フロントエンド（`stores/syncStore.js`, `utils/fortTiming.js`, `utils/constants.js` など）
- `public/` — 静的アセット・リダイレクト設定
- `gge-tracker-api/` — Cloudflare Workers API（`src/index.js`, `wrangler.jsonc`）
  - ※ `gge-tracker-api/src/index.js` は `../../src/utils/fortTiming.js` と `../../src/utils/constants.js` を参照しています。
- `tests/` — `node:test` + `node:sqlite` による API・フロントエンド結合テスト
  - `tests/fort-cooldown.test.js`
  - `tests/fort-partial-sync.test.js`
  - `tests/ruby-analytics.test.js`
  - `tests/sync.test.js`

## テスト実行（プロジェクトルートから）

```bash
npm install
node --test tests/*.test.js
```

## API デプロイ（Cloudflare Workers）

```bash
cd gge-tracker-api
npx wrangler deploy
```

## Web ビルド・デプロイ（Cloudflare Workers Assets）

```bash
npm run build
npx wrangler deploy
```

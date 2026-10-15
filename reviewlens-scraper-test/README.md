# ReviewLens Scraper Test

Internal-only Chrome extension for testing the production ReviewLens crawler on public Shopify product pages.

The package intentionally excludes Shopify authorization, ReviewLens login, payments, database synchronization, and AI analysis.

`content.js` is not maintained in this directory. The build script copies it directly from `reviewlens-extension/content.js` so the test package always uses the same crawler as the production extension.

## Build

Run:

```bash
./scripts/build-scraper-test-extension.sh
```

The generated archive is:

```text
reviewlens-scraper-test.zip
```

## Install

1. Extract the ZIP.
2. Open `chrome://extensions`.
3. Enable Developer mode.
4. Click **Load unpacked**.
5. Select the extracted folder containing `manifest.json`.
6. Open or refresh a public Shopify product page.
7. Open **ReviewLens Scraper Test** and click **Test Scrape**.

The extension keeps the latest test result in local Chrome extension storage. It does not send test results to the ReviewLens API.

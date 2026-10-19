#!/usr/bin/env node

import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { execFile } from "node:child_process";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { pathToFileURL } from "node:url";
import { promisify } from "node:util";

const execFileAsync = promisify(execFile);
const contentScript = await readFile(new URL("../reviewlens-extension/content.js", import.meta.url), "utf8");

function fixture(useShadowDom) {
  return `<!doctype html>
<html>
<head>
  <meta property="og:type" content="product">
  <title>Okendo fixture</title>
</head>
<body>
  <main class="okeReviews" data-review-count="36"><div id="mount"></div></main>
  <script>
    const runtimeListeners = [];
    window.chrome = window.chrome || {};
    window.chrome.runtime = {
      onMessage: {
        addListener(listener) {
          runtimeListeners.push(listener);
        }
      }
    };
    window.addEventListener("error", (event) => {
      document.title = "ERROR:" + event.message;
    });
    window.addEventListener("unhandledrejection", (event) => {
      document.title = "ERROR:" + String(event.reason);
    });
    let visible = 5;
    const mount = document.querySelector("#mount");
    const root = ${useShadowDom ? "mount.attachShadow({ mode: 'open' })" : "mount"};
    root.innerHTML = '<div class="okeReviews-reviewsAggregate">36 reviews</div><div id="reviews"></div><button class="oke-showMore-button">Show More</button>';
  </script>
  <script src="content.js"></script>
  <script>
    function render() {
      root.querySelector("#reviews").innerHTML = Array.from(
        { length: visible },
        (_, index) => {
          const number = index + 1;
          return \`
            <article class="oke-w-reviews-list-item" data-review-id="okendo-\${number}">
              <h3 class="oke-reviewContent-title">Review \${number}</h3>
              <span class="oke-w-reviewer-name">Customer \${number}</span>
              <p class="oke-reviewContent-body">Okendo review body number \${number} has enough content.</p>
              <time class="oke-w-reviewMinimal-date">2026-10-19</time>
              <span itemprop="ratingValue" content="\${(number % 5) + 1}"></span>
            </article>
          \`;
        }
      ).join("");
      root.querySelector(".oke-showMore-button").hidden = visible >= 36;
    }

    root.querySelector(".oke-showMore-button").addEventListener("click", () => {
      visible = Math.min(visible + 5, 36);
      render();
    });
    render();

    setTimeout(() => {
      document.title = "LISTENERS:" + runtimeListeners.length;
      for (const listener of runtimeListeners) {
        listener({ type: "REVIEWLENS_SCRAPE_PAGE" }, {}, (result) => {
          document.title = "RESULT:" + btoa(JSON.stringify(result));
        });
      }
    }, 50);
  </script>
</body>
</html>`;
}

async function runCase(name, html) {
  const directory = await mkdtemp(join(tmpdir(), `reviewlens-okendo-${name}-`));
  await writeFile(join(directory, "content.js"), contentScript);
  await writeFile(join(directory, "fixture.html"), html);

  try {
  const { stdout, stderr } = await execFileAsync("/usr/bin/google-chrome", [
    "--headless",
    "--no-sandbox",
    "--disable-dev-shm-usage",
    "--disable-gpu",
    "--allow-file-access-from-files",
    `--user-data-dir=${join(directory, "chrome")}`,
    "--virtual-time-budget=30000",
    "--dump-dom",
    pathToFileURL(join(directory, "fixture.html")).href,
  ], {
    timeout: 60_000,
    maxBuffer: 20 * 1024 * 1024,
  });

  const encoded = stdout.match(/<title>RESULT:([^<]+)<\/title>/)?.[1];
  if (!encoded) {
    const title = stdout.match(/<title>([^<]*)<\/title>/)?.[1] || "missing";
    throw new Error(`${name}: Okendo scraper result was not written to the document title (title: ${title}, stderr: ${stderr.slice(-500)})`);
  }
  const result = JSON.parse(Buffer.from(encoded, "base64").toString("utf8"));
  const diagnostics = result.debug?.loadMore || {};

  const checks = [
    ["count", result.count, 36],
    ["provider", diagnostics.provider, "okendo"],
    ["method", diagnostics.method, "provider_load_more"],
    ["pagesLoaded", diagnostics.pagesLoaded, 7],
    ["stoppedReason", diagnostics.stoppedReason, "expected_count_reached"],
  ];
  for (const [field, actual, expected] of checks) {
    if (actual !== expected) {
      throw new Error(`${name}: expected ${field}=${expected}, received ${actual}`);
    }
  }

  console.log(`${name}: ${result.count} reviews, ${diagnostics.pagesLoaded} loads, ${diagnostics.stoppedReason}`);
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
}

await runCase("regular", fixture(false));
await runCase("shadow", fixture(true));

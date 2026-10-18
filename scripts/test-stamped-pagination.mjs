#!/usr/bin/env node

import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { execFile } from "node:child_process";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { pathToFileURL } from "node:url";
import { promisify } from "node:util";

const execFileAsync = promisify(execFile);
const contentScript = await readFile(new URL("../reviewlens-extension/content.js", import.meta.url), "utf8");

function fixture({ total, perPage, initialPage, numericPagination }) {
  return `<!doctype html>
<html>
<head>
  <meta property="og:type" content="product">
  <title>Stamped fixture</title>
</head>
<body>
  <main id="stamped-main-widget" class="stamped-main-widget" data-count-reviews="${total}">
    <div class="stamped-summary-text">Based on ${total} reviews</div>
    <div id="reviews"></div>
    <ul class="stamped-pagination"></ul>
  </main>
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
    window.fixtureConfig = ${JSON.stringify({ total, perPage, initialPage, numericPagination })};
  </script>
  <script src="content.js"></script>
  <script>
    const config = window.fixtureConfig;
    let currentPage = config.initialPage;
    const pageCount = Math.ceil(config.total / config.perPage);

    function render() {
      const start = (currentPage - 1) * config.perPage + 1;
      const end = Math.min(start + config.perPage - 1, config.total);
      document.querySelector("#reviews").innerHTML = Array.from(
        { length: end - start + 1 },
        (_, index) => {
          const number = start + index;
          return \`
            <article class="stamped-review" data-review-id="review-\${number}">
              <h3 class="stamped-review-title">Review \${number}</h3>
              <span class="stamped-review-header-title">Customer \${number}</span>
              <p class="stamped-review-content-body">Stamped review body number \${number} has enough content.</p>
              <time class="stamped-review-date">2026-10-18</time>
              <span itemprop="ratingValue" content="\${(number % 5) + 1}"></span>
            </article>
          \`;
        }
      ).join("");

      const pagination = document.querySelector(".stamped-pagination");
      const previous = \`<li class="previous"><a aria-label="Previous" \${currentPage === 1 ? 'aria-disabled="true"' : ""}>Previous</a></li>\`;
      const next = \`<li class="next"><a aria-label="Next" \${currentPage === pageCount ? 'aria-disabled="true"' : ""}>Next</a></li>\`;
      const pages = config.numericPagination
        ? Array.from({ length: pageCount }, (_, index) => {
            const page = index + 1;
            return \`<li class="page \${page === currentPage ? "active" : ""}"><a data-page="\${page}">\${page}</a></li>\`;
          }).join("")
        : "";
      pagination.innerHTML = previous + pages + next;
    }

    document.querySelector(".stamped-pagination").addEventListener("click", (event) => {
      const action = event.target.closest("a");
      if (!action || action.getAttribute("aria-disabled") === "true") return;
      const requestedPage = Number(action.dataset.page);
      if (requestedPage) currentPage = requestedPage;
      else if (action.getAttribute("aria-label") === "Next") currentPage += 1;
      else if (action.getAttribute("aria-label") === "Previous") currentPage -= 1;
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

async function runCase(name, html, expected) {
  const directory = await mkdtemp(join(tmpdir(), `reviewlens-stamped-${name}-`));
  await writeFile(join(directory, "content.js"), contentScript);
  await writeFile(join(directory, "fixture.html"), html);

  let stdout;
  let stderr;
  try {
    ({ stdout, stderr } = await execFileAsync("/usr/bin/google-chrome", [
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
    }));
  } finally {
    await rm(directory, { recursive: true, force: true });
  }

  const encoded = stdout.match(/<title>RESULT:([^<]+)<\/title>/)?.[1];
  if (!encoded) {
    const title = stdout.match(/<title>([^<]*)<\/title>/)?.[1] || "missing";
    throw new Error(
      `${name}: scraper result was not written to the document title `
      + `(title: ${title}, stdout: ${stdout.length} bytes, stderr: ${stderr.slice(-300)})`
    );
  }
  const result = JSON.parse(Buffer.from(encoded, "base64").toString("utf8"));

  for (const [field, value] of Object.entries(expected)) {
    const actual = field.split(".").reduce((current, key) => current?.[key], result);
    if (actual !== value) {
      throw new Error(`${name}: expected ${field}=${value}, received ${actual}`);
    }
  }

  console.log(`${name}: ${result.count} reviews, ${result.debug.loadMore.pagesLoaded} pages loaded, ${result.debug.loadMore.stoppedReason}`);
}

await runCase(
  "numeric",
  fixture({ total: 125, perPage: 5, initialPage: 3, numericPagination: true }),
  {
    count: 100,
    "debug.loadMore.provider": "stamped",
    "debug.loadMore.method": "provider_pagination",
    "debug.loadMore.stoppedReason": "configured_limit_reached",
  }
);
await runCase(
  "arrow",
  fixture({ total: 36, perPage: 5, initialPage: 1, numericPagination: false }),
  {
    count: 36,
    "debug.loadMore.provider": "stamped",
    "debug.loadMore.method": "provider_pagination",
    "debug.loadMore.stoppedReason": "expected_count_reached",
  }
);

const STORAGE_KEY = "reviewlens_scraper_test_result";

const state = {
  result: null,
  filter: "all",
  tab: null,
};

const pageTitleEl = document.getElementById("page-title");
const pageUrlEl = document.getElementById("page-url");
const scrapeButton = document.getElementById("scrape");
const statusEl = document.getElementById("status");
const resultsEl = document.getElementById("results");
const totalEl = document.getElementById("total");
const negativeEl = document.getElementById("negative");
const positiveEl = document.getElementById("positive");
const providersEl = document.getElementById("providers");
const primaryProviderEl = document.getElementById("primary-provider");
const confidenceEl = document.getElementById("confidence");
const loadMethodEl = document.getElementById("load-method");
const expectedReviewsEl = document.getElementById("expected-reviews");
const loadedReviewsEl = document.getElementById("loaded-reviews");
const stoppedReasonEl = document.getElementById("stopped-reason");
const framesEl = document.getElementById("frames");
const frameExpansionsEl = document.getElementById("frame-expansions");
const diagnosisEl = document.getElementById("diagnosis");
const signalsEl = document.getElementById("signals");
const reviewListEl = document.getElementById("review-list");
const exportButton = document.getElementById("export");
const clearButton = document.getElementById("clear");
const filterButtons = Array.from(document.querySelectorAll("[data-filter]"));

bootstrap().catch((error) => setStatus(error.message || String(error), true));

scrapeButton.addEventListener("click", runScrape);
exportButton.addEventListener("click", exportResult);
clearButton.addEventListener("click", clearResult);

for (const button of filterButtons) {
  button.addEventListener("click", () => {
    state.filter = button.dataset.filter || "all";
    filterButtons.forEach((item) => item.classList.toggle("active", item === button));
    renderReviews();
  });
}

async function bootstrap() {
  const [tab] = await chrome.tabs.query({ active: true, currentWindow: true });
  state.tab = tab || null;
  pageTitleEl.textContent = tab?.title || "No active page";
  pageUrlEl.textContent = tab?.url || "";

  const stored = await chrome.storage.local.get(STORAGE_KEY);
  state.result = stored?.[STORAGE_KEY] || null;
  renderResult();
}

async function runScrape() {
  scrapeButton.disabled = true;
  scrapeButton.textContent = "Testing scraper...";
  setStatus("Running the production crawler. This may take several seconds.");

  try {
    const response = await chrome.runtime.sendMessage({
      type: "REVIEWLENS_TEST_SCRAPE_ACTIVE_TAB",
    });
    if (!response?.ok) throw new Error(response?.error || "Scrape failed.");

    state.result = response.result;
    await chrome.storage.local.set({ [STORAGE_KEY]: state.result });
    renderResult();
    setStatus(`Scrape completed. ${Number(state.result?.count || 0)} reviews found.`);
  } catch (error) {
    setStatus(error instanceof Error ? error.message : String(error), true);
  } finally {
    scrapeButton.disabled = false;
    scrapeButton.textContent = "Test Scrape";
  }
}

function renderResult() {
  const result = state.result;
  resultsEl.classList.toggle("is-hidden", !result);
  if (!result) return;

  totalEl.textContent = String(result.count || 0);
  negativeEl.textContent = String(result.negativeCount || 0);
  positiveEl.textContent = String(result.positiveCount || 0);

  const debug = result.debug || {};
  const providers = Array.isArray(debug.detectedProviders) ? debug.detectedProviders : [];
  providersEl.textContent = providers.length ? providers.join(", ") : "None detected";
  primaryProviderEl.textContent = debug.providerDetection?.primary || "Unknown";
  confidenceEl.textContent = debug.providerDetection?.confidence || "Unknown";
  loadMethodEl.textContent = debug.loadMore?.method || "None";
  expectedReviewsEl.textContent = formatDiagnosticValue(debug.loadMore?.expectedCount);
  loadedReviewsEl.textContent = formatDiagnosticValue(
    debug.loadMore?.extractedCount ?? debug.loadMore?.finalDomCount
  );
  stoppedReasonEl.textContent = debug.loadMore?.stoppedReason || "Not reported";
  framesEl.textContent = String(debug.iframeCount || 0);
  frameExpansionsEl.textContent = Array.isArray(debug.frameExpansions)
    ? debug.frameExpansions.map((item) => `${item.provider}: ${item.reviewCount}`).join(", ") || "None"
    : "None";
  diagnosisEl.textContent = debug.diagnosis || "No diagnosis returned";
  signalsEl.textContent = JSON.stringify(debug.visibleReviewCounts || {}, null, 2);
  renderReviews();
}

function renderReviews() {
  reviewListEl.innerHTML = "";
  if (!state.result) return;

  const reviews = reviewsForFilter();
  if (!reviews.length) {
    reviewListEl.innerHTML = '<div class="empty">No reviews found for this filter.</div>';
    return;
  }

  for (const review of reviews) {
    const card = document.createElement("article");
    card.className = "review-card";

    const rating = clampRating(review.rating);
    const stars = "★★★★★".slice(0, rating) + "☆☆☆☆☆".slice(0, 5 - rating);
    card.innerHTML = `
      <div class="review-head">
        <span class="review-author">${escapeHtml(review.author || "Anonymous")}</span>
        <span class="review-rating">${escapeHtml(stars)}</span>
      </div>
      ${review.title ? `<p class="review-title">${escapeHtml(review.title)}</p>` : ""}
      <p class="review-body">${escapeHtml(review.body || "")}</p>
      <div class="review-meta">${escapeHtml(review.source || "review")}${review.date ? ` · ${escapeHtml(review.date)}` : ""}</div>
    `;
    reviewListEl.appendChild(card);
  }
}

function reviewsForFilter() {
  if (state.filter === "negative") return state.result?.negativeReviews || [];
  if (state.filter === "positive") return state.result?.positiveReviews || [];
  return state.result?.reviews || [];
}

function exportResult() {
  if (!state.result) return;

  const blob = new Blob([JSON.stringify(state.result, null, 2)], {
    type: "application/json",
  });
  const url = URL.createObjectURL(blob);
  const link = document.createElement("a");
  const host = safeHost(state.result.url);
  link.href = url;
  link.download = `reviewlens-scrape-${host}-${Date.now()}.json`;
  link.click();
  setTimeout(() => URL.revokeObjectURL(url), 1000);
}

async function clearResult() {
  state.result = null;
  await chrome.storage.local.remove(STORAGE_KEY);
  renderResult();
  setStatus("Saved test result cleared.");
}

function setStatus(message, isError = false) {
  statusEl.textContent = message;
  statusEl.classList.toggle("error", isError);
}

function safeHost(value) {
  try {
    return new URL(String(value || "")).hostname.replace(/[^a-z0-9.-]/gi, "-");
  } catch {
    return "product";
  }
}

function clampRating(value) {
  const rating = Math.round(Number(value) || 0);
  return Math.min(5, Math.max(0, rating));
}

function formatDiagnosticValue(value) {
  return value === null || value === undefined || value === "" ? "Unknown" : String(value);
}

function escapeHtml(value) {
  return String(value)
    .replaceAll("&", "&amp;")
    .replaceAll("<", "&lt;")
    .replaceAll(">", "&gt;")
    .replaceAll('"', "&quot;")
    .replaceAll("'", "&#39;");
}

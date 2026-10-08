const APP_BASE_URL = "https://reviewlensvercelsitev3.vercel.app";

const state = {
  data: null,
  activeView: "analysis",
  activeTab: "negative",
  context: null,
  auth: null,
  user: null,
  billing: null,
  product: null,
  analysisResult: null,
  hasResults: false,
  targetUrl: "",
};
const STORAGE_KEY = "reviewlens_popup_state";
const TARGET_URL_KEY = "reviewlens_target_url";
const AUTH_KEY = "reviewlens_auth_state";
const USER_KEY = "reviewlens_user_session";
const PRODUCT_KEY = "reviewlens_product_state";

const urlInput = document.getElementById("url");
const connectButton = document.getElementById("connect");
const useCurrentButton = document.getElementById("use-current");
const scrapeButton = document.getElementById("scrape");
const statusEl = document.getElementById("status");
const totalEl = document.getElementById("total");
const negativeEl = document.getElementById("negative");
const positiveEl = document.getElementById("positive");
const listEl = document.getElementById("list");
const storeNameEl = document.getElementById("store-name");
const storeMetaEl = document.getElementById("store-meta");
const productTitleEl = document.getElementById("product-title");
const productDescriptionEl = document.getElementById("product-description");
const productMetaEl = document.getElementById("product-meta");
const resultsPanelEl = document.getElementById("results-panel");
const analysisViewEl = document.getElementById("analysis-view");
const reviewsViewEl = document.getElementById("reviews-view");
const analysisResultEl = document.getElementById("analysis-result");
const viewButtons = Array.from(document.querySelectorAll(".view-tab"));
const tabButtons = Array.from(document.querySelectorAll(".tab"));
const unlockButton = document.getElementById("unlock-analysis");

unlockButton.addEventListener("click", async () => {
  const shopDomain = state.context?.shopDomain || state.auth?.shopDomain || inferShopDomainFromUrl(state.targetUrl);
  if (!shopDomain) {
    setStatus("Open an authorized Shopify product page first.", true);
    return;
  }

  if (!hasUsableUserSession()) {
    const loginUrl = new URL(`${APP_BASE_URL}/login.html`);
    loginUrl.searchParams.set("extension_id", chrome.runtime.id);
    loginUrl.searchParams.set("shop", shopDomain);
    const handle = productHandleFromUrl(state.targetUrl);
    if (handle) loginUrl.searchParams.set("handle", handle);
    setStatus("Opening the ReviewLens sign-in page...");
    await chrome.tabs.create({ url: loginUrl.toString(), active: true });
    return;
  }

  unlockButton.disabled = true;
  try {
    if (!state.billing) await refreshAccessStatus();
    if (state.billing?.paid) {
      await runAnalysis(shopDomain);
    } else {
      await openCheckout(shopDomain);
    }
  } catch (error) {
    setStatus(error instanceof Error ? error.message : String(error), true);
  } finally {
    unlockButton.textContent = "Unlock Full Analysis";
    unlockButton.disabled = false;
  }
});

bootstrap().catch((error) => {
  setStatus(error instanceof Error ? error.message : String(error), true);
});

connectButton.addEventListener("click", async () => {
  const shopDomain = state.context?.shopDomain || inferShopDomainFromUrl(urlInput.value);
  if (!shopDomain) {
    setStatus("Open a Shopify storefront tab first.", true);
    return;
  }

  const targetUrl = state.context?.isProductPage && state.context?.productUrl
    ? state.context.productUrl
    : (isLikelyProductUrl(urlInput.value) ? normalizeUrl(urlInput.value) : state.targetUrl);

  if (targetUrl) {
    state.targetUrl = targetUrl;
    urlInput.value = targetUrl;
    await persistTargetUrl();
  }

  const installUrl = `${APP_BASE_URL}/api/shopify/install?shop=${encodeURIComponent(shopDomain)}`;
  setStatus("Opening Shopify authorization...");
  await chrome.tabs.create({ url: installUrl, active: true });
});

useCurrentButton.addEventListener("click", async () => {
  const tab = await getCurrentTab();
  if (!tab?.url) {
    setStatus("No active tab found.", true);
    return;
  }

  const response = await getTabContext(tab.id);
  if (response?.isProductPage && response?.productUrl) {
    state.targetUrl = response.productUrl;
    urlInput.value = response.productUrl;
    await persistTargetUrl();
    setStatus("Loaded current product page.");
    await refreshContext();
    return;
  }

  if (state.targetUrl) {
    urlInput.value = state.targetUrl;
    setStatus("Current tab is not a product page. Restored the last product URL.");
    return;
  }

  setStatus("Current tab is not a product page.", true);
});

scrapeButton.addEventListener("click", async () => {
  const url = normalizeUrl(state.targetUrl || urlInput.value);
  state.targetUrl = url;
  urlInput.value = url;
  await persistTargetUrl();
  setStatus("Scraping...");
  scrapeButton.disabled = true;

  try {
    const response = await chrome.runtime.sendMessage({
      type: "REVIEWLENS_SCRAPE_URL",
      url,
    });

    if (!response?.ok) throw new Error(response?.error || "Scrape failed.");

    state.data = response.result;
    state.analysisResult = null;
    renderResult();
    await persistState();
    const sync = await syncReviews(response.result);
    if (sync.ok) {
      await refreshAccessStatus();
      setStatus(`${sync.saved} reviews saved.`);
    } else {
      setStatus("Reviews displayed locally, but database sync failed.");
    }
  } catch (error) {
    setStatus(error instanceof Error ? error.message : String(error), true);
  } finally {
    scrapeButton.disabled = false;
  }
});

for (const button of tabButtons) {
  button.addEventListener("click", () => {
    state.activeTab = button.dataset.tab || "negative";
    tabButtons.forEach((item) => item.classList.toggle("active", item === button));
    renderList();
    persistState();
  });
}

for (const button of viewButtons) {
  button.addEventListener("click", () => {
    state.activeView = button.dataset.view || "analysis";
    viewButtons.forEach((item) => item.classList.toggle("active", item === button));
    renderViews();
    persistState();
  });
}

async function bootstrap() {
  await restoreState();
  await restoreTargetUrl();
  await restoreAuthState();
  await restoreUserSession();
  await restoreProductState();
  const tab = await getCurrentTab();
  if (state.targetUrl) {
    urlInput.value = state.targetUrl;
  } else if (tab?.url && isHttpUrl(tab.url)) {
    urlInput.value = tab.url;
  }
  await refreshContext();
  renderViews();
  if (state.hasResults) {
    renderResult();
  }
}

async function refreshContext() {
  const tab = await getCurrentTab();
  if (!tab?.id) {
    state.context = null;
    renderStoreState();
    return;
  }

  try {
    const response = await chrome.tabs.sendMessage(tab.id, { type: "REVIEWLENS_GET_CONTEXT" });
    state.context = response?.ok ? response.context : null;
  } catch (_) {
    state.context = null;
  }

  if (state.context?.isProductPage && state.context.productUrl) {
    state.targetUrl = state.context.productUrl;
    await persistTargetUrl();
    if (!urlInput.value || !isLikelyProductUrl(urlInput.value)) {
      urlInput.value = state.targetUrl;
    }
  } else if (!urlInput.value && state.targetUrl) {
    urlInput.value = state.targetUrl;
  }

  await refreshAuthStatus();
  await refreshAccessStatus();
  await refreshProductInfo();
  renderStoreState();
}

async function restoreState() {
  try {
    const stored = await chrome.storage.local.get(STORAGE_KEY);
    const saved = stored?.[STORAGE_KEY];
    if (!saved) return;

    state.data = saved.data || null;
    state.analysisResult = saved.analysisResult || null;
    state.activeView = saved.activeView || "analysis";
    state.activeTab = saved.activeTab || "negative";
    state.hasResults = Boolean(state.data);
  } catch (_) {}
}

async function restoreTargetUrl() {
  try {
    const stored = await chrome.storage.local.get(TARGET_URL_KEY);
    state.targetUrl = String(stored?.[TARGET_URL_KEY] || "");
  } catch (_) {}
}

async function persistState() {
  try {
    await chrome.storage.local.set({
      [STORAGE_KEY]: {
        data: state.data,
        analysisResult: state.analysisResult,
        activeView: state.activeView,
        activeTab: state.activeTab,
      },
    });
  } catch (_) {}
}

async function persistTargetUrl() {
  try {
    await chrome.storage.local.set({ [TARGET_URL_KEY]: state.targetUrl || "" });
  } catch (_) {}
}

async function restoreAuthState() {
  try {
    const stored = await chrome.storage.local.get(AUTH_KEY);
    state.auth = stored?.[AUTH_KEY] || null;
  } catch (_) {}
}

async function restoreUserSession() {
  try {
    const stored = await chrome.storage.local.get(USER_KEY);
    state.user = stored?.[USER_KEY] || null;
    if (!hasUsableUserSession()) await clearUserSession();
  } catch (_) {
    state.user = null;
  }
}

async function clearUserSession() {
  state.user = null;
  try {
    await chrome.storage.local.remove(USER_KEY);
  } catch (_) {}
}

function hasUsableUserSession() {
  return Boolean(
    state.user?.accessToken &&
    (!state.user.expiresAt || Number(state.user.expiresAt) > Date.now() + 30000)
  );
}

async function persistAuthState() {
  try {
    await chrome.storage.local.set({ [AUTH_KEY]: state.auth || null });
  } catch (_) {}
}

async function restoreProductState() {
  try {
    const stored = await chrome.storage.local.get(PRODUCT_KEY);
    state.product = stored?.[PRODUCT_KEY] || null;
  } catch (_) {}
}

async function persistProductState() {
  try {
    await chrome.storage.local.set({ [PRODUCT_KEY]: state.product || null });
  } catch (_) {}
}

function renderStoreState() {
  const ctx = state.context;
  const shopDomain = ctx?.shopDomain || state.auth?.shopDomain || inferShopDomainFromUrl(state.targetUrl);

  if (!ctx && !shopDomain) {
    storeNameEl.textContent = "No Shopify shop detected";
    storeMetaEl.textContent = "Open a Shopify storefront tab, then click Connect.";
    connectButton.disabled = true;
    renderProductState(null);
    return;
  }

  storeNameEl.textContent = shopDomain || "Shopify page detected";
  connectButton.disabled = !(ctx?.canAuthorize || shopDomain);

  if (state.auth?.authorized) {
    connectButton.textContent = "Connected";
    storeMetaEl.textContent = "Store connected. Open a product page, then analyze reviews.";
    renderProductState(state.product);
    return;
  }

  connectButton.textContent = "Connect Shopify Store";
  storeMetaEl.textContent = ctx?.url || state.targetUrl || "Open a Shopify storefront tab to detect the shop domain.";

  if (ctx && !ctx.canAuthorize) {
    storeMetaEl.textContent = "This page looks like Shopify, but the shop domain could not be resolved.";
  }

  renderProductState(state.product);
}

async function getCurrentTab() {
  const [tab] = await chrome.tabs.query({ active: true, currentWindow: true });
  return tab || null;
}

function renderResult() {
  const data = state.data;
  state.hasResults = Boolean(data);
  totalEl.textContent = String(data?.count || 0);
  negativeEl.textContent = String(data?.negativeCount || 0);
  positiveEl.textContent = String(data?.positiveCount || 0);
  state.activeView = "analysis";
  viewButtons.forEach((item) => item.classList.toggle("active", item.dataset.view === state.activeView));
  renderViews();
  renderList();
  renderAnalysisResult();
  persistState();
}

async function openCheckout(shopDomain) {
  setStatus("Creating secure checkout...");
  const response = await postJson(
    `${APP_BASE_URL}/api/checkout?plan=pro&shop=${encodeURIComponent(shopDomain)}`,
    {},
    { Authorization: `Bearer ${state.user.accessToken}` }
  );
  if (!response.ok || !response.data?.ok || !response.data?.checkout_url) {
    if (response.status === 401) {
      await clearUserSession();
      throw new Error("Your login session expired. Click Unlock Full Analysis again to sign in.");
    }
    throw new Error(response.data?.error || "Unable to create checkout.");
  }
  await chrome.tabs.create({ url: response.data.checkout_url, active: true });
}

async function runAnalysis(shopDomain) {
  const handle = productHandleFromUrl(state.targetUrl || urlInput.value);
  if (!handle) throw new Error("Open a Shopify product page before analyzing.");

  setStatus("Analyzing reviews...");
  unlockButton.textContent = "Analyzing...";
  const response = await postJson(
    `${APP_BASE_URL}/api/analysis?shop=${encodeURIComponent(shopDomain)}`,
    {
      handle,
      productUrl: state.targetUrl || urlInput.value,
    },
    { Authorization: `Bearer ${state.user.accessToken}` }
  );

  if (!response.ok || !response.data?.ok) {
    if (response.status === 401) {
      await clearUserSession();
      throw new Error("Your login session expired. Sign in again.");
    }
    throw new Error(response.data?.error || "AI analysis failed.");
  }

  state.analysisResult = response.data.analysisResult || null;
  renderAnalysisResult();
  await persistState();
  setStatus(response.data.cached ? "Loaded saved AI analysis." : "AI analysis completed.");
}

function renderAnalysisResult() {
  if (!analysisResultEl) return;
  const result = state.analysisResult;
  analysisResultEl.innerHTML = "";
  analysisResultEl.classList.toggle("is-hidden", !result);
  if (!result) return;

  const summary = document.createElement("section");
  summary.className = "analysis-block";
  summary.innerHTML = "<h3>Summary</h3>";
  const summaryText = document.createElement("p");
  summaryText.textContent = result.summary || "No summary returned.";
  summary.appendChild(summaryText);
  analysisResultEl.appendChild(summary);

  const issues = document.createElement("section");
  issues.className = "analysis-block";
  issues.innerHTML = "<h3>Top Issues</h3>";
  for (const issue of Array.isArray(result.top_issues) ? result.top_issues : []) {
    const item = document.createElement("div");
    item.className = "analysis-item";
    const title = document.createElement("strong");
    title.textContent = issue.title || "Issue";
    item.appendChild(title);
    for (const value of [issue.description, issue.impact, issue.recommendation]) {
      if (!value) continue;
      const paragraph = document.createElement("p");
      paragraph.textContent = value;
      item.appendChild(paragraph);
    }
    appendEvidence(item, issue.evidence);
    issues.appendChild(item);
  }
  analysisResultEl.appendChild(issues);

  const strengths = document.createElement("section");
  strengths.className = "analysis-block";
  strengths.innerHTML = "<h3>Strengths</h3>";
  for (const strength of Array.isArray(result.strengths) ? result.strengths : []) {
    const item = document.createElement("div");
    item.className = "analysis-item";
    const title = document.createElement("strong");
    title.textContent = strength.title || "Strength";
    item.appendChild(title);
    if (strength.description) {
      const paragraph = document.createElement("p");
      paragraph.textContent = strength.description;
      item.appendChild(paragraph);
    }
    appendEvidence(item, strength.evidence);
    strengths.appendChild(item);
  }
  analysisResultEl.appendChild(strengths);

  const actions = Array.isArray(result.priority_actions) ? result.priority_actions : [];
  if (actions.length) {
    const actionBlock = document.createElement("section");
    actionBlock.className = "analysis-block";
    actionBlock.innerHTML = "<h3>Priority Actions</h3>";
    const list = document.createElement("ol");
    for (const action of actions) {
      const item = document.createElement("li");
      item.textContent = action;
      list.appendChild(item);
    }
    actionBlock.appendChild(list);
    analysisResultEl.appendChild(actionBlock);
  }
}

function appendEvidence(parent, evidence) {
  if (!Array.isArray(evidence) || !evidence.length) return;
  const list = document.createElement("ul");
  list.className = "analysis-evidence";
  for (const item of evidence) {
    const entry = document.createElement("li");
    entry.textContent = item?.quote || "";
    if (entry.textContent) list.appendChild(entry);
  }
  if (list.children.length) parent.appendChild(list);
}

function renderList() {
  const data = state.data;
  const reviews = state.activeTab === "negative" ? data?.negativeReviews || [] : data?.positiveReviews || [];
  const label = state.activeTab === "negative" ? "Negative Reviews" : "Positive Reviews";

  listEl.innerHTML = "";

  if (!data) {
    listEl.innerHTML = `<div class="placeholder">No results yet.</div>`;
    return;
  }

  if (!reviews.length) {
    listEl.innerHTML = `<div class="placeholder">No ${label.toLowerCase()} found.</div>`;
    return;
  }

  for (const review of reviews) {
    listEl.appendChild(buildCard(review));
  }
}

function renderViews() {
  const hasResults = state.hasResults;

  resultsPanelEl.classList.toggle("is-hidden", !hasResults);

  analysisViewEl.classList.toggle("is-hidden", state.activeView !== "analysis");
  reviewsViewEl.classList.toggle("is-hidden", state.activeView !== "reviews");

  viewButtons.forEach((item) => item.classList.toggle("active", item.dataset.view === state.activeView));
}

function buildCard(review) {
  const card = document.createElement("article");
  card.className = "card";

  const rating = Number(review.rating || 0);
  const stars = "★★★★★".slice(0, Math.round(rating)) + "☆☆☆☆☆".slice(0, 5 - Math.round(rating));

  card.innerHTML = `
    <div class="card-head">
      <div class="author">${escapeHtml(review.author || "Anonymous")}</div>
      <div class="rating">${escapeHtml(stars)}</div>
    </div>
    <p class="body">${escapeHtml(review.body || "")}</p>
    <div class="meta">${escapeHtml(review.source || "review")}${review.date ? ` • ${escapeHtml(review.date)}` : ""}</div>
  `;

  return card;
}

function setStatus(message, isError = false) {
  statusEl.textContent = message;
  statusEl.style.color = isError ? "#ef786b" : "";
}

function normalizeUrl(value) {
  const raw = String(value || "").trim();
  if (!raw) throw new Error("Please enter a product URL.");
  if (!/^https?:\/\//i.test(raw)) throw new Error("Only http and https URLs are supported.");
  return raw;
}

function isLikelyProductUrl(value) {
  try {
    const url = new URL(String(value || ""));
    return /\/products\//i.test(url.pathname);
  } catch {
    return false;
  }
}

async function getTabContext(tabId) {
  try {
    const response = await chrome.tabs.sendMessage(tabId, { type: "REVIEWLENS_GET_CONTEXT" });
    return response?.ok ? response.context : null;
  } catch {
    return null;
  }
}

function inferShopDomainFromUrl(value) {
  const raw = String(value || "").trim();
  if (!raw) return "";
  try {
    const url = new URL(raw);
    const host = url.hostname.toLowerCase();
    if (host.endsWith(".myshopify.com")) return host;
    return "";
  } catch {
    return "";
  }
}

function productHandleFromUrl(value) {
  try {
    const url = new URL(String(value || ""));
    const match = url.pathname.match(/\/products\/([^/?#]+)/i);
    return match ? decodeURIComponent(match[1]) : "";
  } catch {
    return "";
  }
}

async function refreshAuthStatus() {
  const shopDomain = state.context?.shopDomain || inferShopDomainFromUrl(state.targetUrl);
  if (!shopDomain) return;

  try {
    const response = await fetchJson(`${APP_BASE_URL}/api/shopify/auth-status?shop=${encodeURIComponent(shopDomain)}`);
    const data = response.data;
    if (!response.ok || !data?.ok) throw new Error(data?.error || "Auth status failed.");
    state.auth = {
      shopDomain,
      authorized: Boolean(data.authorized),
      installation: data.installation || null,
    };
    await persistAuthState();
  } catch (_) {
    state.auth = {
      shopDomain,
      authorized: false,
      installation: null,
    };
  }
}

async function refreshProductInfo() {
  const shopDomain = state.context?.shopDomain || state.auth?.shopDomain || inferShopDomainFromUrl(state.targetUrl);
  const productUrl = state.context?.isProductPage ? state.context.productUrl : state.targetUrl;
  const handle = productHandleFromUrl(productUrl);
  if (!shopDomain || !state.auth?.authorized || !handle) return;

  try {
    const params = new URLSearchParams({
      shop: shopDomain,
      handle,
      url: productUrl,
    });
    const response = await fetchJson(`${APP_BASE_URL}/api/shopify/product?${params.toString()}`);
    const data = response.data;
    if (!response.ok || !data?.ok) throw new Error(data?.error || "Product fetch failed.");
    state.product = data.product || null;
    await persistProductState();
    renderProductState(state.product);
  } catch (_) {}
}

async function refreshAccessStatus() {
  const shopDomain = state.context?.shopDomain || state.auth?.shopDomain || inferShopDomainFromUrl(state.targetUrl);
  if (!shopDomain || !state.auth?.authorized || !hasUsableUserSession()) {
    state.billing = null;
    return;
  }

  try {
    const response = await fetchJson(
      `${APP_BASE_URL}/api/analysis?shop=${encodeURIComponent(shopDomain)}`,
      { Authorization: `Bearer ${state.user.accessToken}` }
    );
    const data = response.data;
    if (!response.ok || !data?.ok) throw new Error(data?.error || "Access status failed.");
    state.billing = {
      shopDomain,
      paid: Boolean(data.paid),
      plan: data.plan || null,
      updatedAt: data.updatedAt || null,
    };
  } catch (error) {
    if (error?.status === 401) await clearUserSession();
    state.billing = {
      shopDomain,
      paid: false,
      plan: null,
      updatedAt: null,
    };
  }
}

function renderProductState(product) {
  if (!product?.title) {
    productTitleEl.textContent = "No product loaded yet.";
    productDescriptionEl.textContent = "Open a Shopify product page and click Use Current Tab.";
    productMetaEl.textContent = "Waiting for product metadata.";
    return;
  }

  productTitleEl.textContent = product.title;
  productDescriptionEl.textContent = product.description || "No description returned.";
  const parts = [];
  if (product.handle) parts.push(`Handle: ${product.handle}`);
  if (product.vendor) parts.push(`Vendor: ${product.vendor}`);
  productMetaEl.textContent = parts.length ? parts.join(" • ") : "Product metadata loaded.";
}

async function fetchJson(url, headers = {}) {
  const response = await chrome.runtime.sendMessage({
    type: "REVIEWLENS_FETCH_JSON",
    url,
    headers,
  });

  if (!response?.ok) {
    throw new Error(response?.error || "Request failed.");
  }

  return response.result;
}

async function postJson(url, body, headers = {}) {
  const response = await chrome.runtime.sendMessage({
    type: "REVIEWLENS_FETCH_JSON",
    url,
    method: "POST",
    body,
    headers,
  });

  if (!response?.ok) {
    throw new Error(response?.error || "Request failed.");
  }

  return response.result;
}

async function syncReviews(data) {
  try {
    const targetUrl = data?.url || state.targetUrl || urlInput.value;
    const shopDomain = state.context?.shopDomain || state.auth?.shopDomain || inferShopDomainFromUrl(targetUrl);
    const handle = productHandleFromUrl(targetUrl);
    const reviews = Array.isArray(data?.reviews)
      ? data.reviews
      : [...(data?.negativeReviews || []), ...(data?.positiveReviews || [])];

    if (!shopDomain || !handle || !reviews.length) {
      return { ok: false, saved: 0 };
    }

    const product = {
      ...(state.product || {}),
      handle: state.product?.handle || handle,
      url: state.product?.url || targetUrl,
    };
    const response = await postJson(`${APP_BASE_URL}/api/reviews/import`, {
      shopDomain,
      product,
      reviews,
      source: primaryReviewSource(data),
    });

    if (!response.ok || !response.data?.ok) {
      return { ok: false, saved: 0 };
    }

    return { ok: true, saved: Number(response.data.saved || reviews.length) };
  } catch (_) {
    return { ok: false, saved: 0 };
  }
}

function primaryReviewSource(data) {
  const sources = data?.sources;
  if (sources && typeof sources === "object") {
    const [source] = Object.entries(sources).sort((a, b) => Number(b[1] || 0) - Number(a[1] || 0))[0] || [];
    if (source) return source;
  }

  const reviews = Array.isArray(data?.reviews) ? data.reviews : [];
  return reviews.find((review) => review?.source)?.source || "";
}

function isHttpUrl(value) {
  try {
    const url = new URL(String(value || ""));
    return url.protocol === "http:" || url.protocol === "https:";
  } catch {
    return false;
  }
}

function escapeHtml(value) {
  return String(value)
    .replaceAll("&", "&amp;")
    .replaceAll("<", "&lt;")
    .replaceAll(">", "&gt;")
    .replaceAll('"', "&quot;")
    .replaceAll("'", "&#39;");
}

const APP_BASE_URL = "https://reviewlensvercelsitev3.vercel.app";

const state = {
  data: null,
  activeView: "analysis",
  activeTab: "negative",
  context: null,
  auth: null,
  product: null,
  hasResults: false,
  targetUrl: "",
};
const STORAGE_KEY = "reviewlens_popup_state";
const TARGET_URL_KEY = "reviewlens_target_url";
const AUTH_KEY = "reviewlens_auth_state";
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
const viewButtons = Array.from(document.querySelectorAll(".view-tab"));
const tabButtons = Array.from(document.querySelectorAll(".tab"));
const unlockButton = document.getElementById("unlock-analysis");

unlockButton.addEventListener("click", async () => {
  await chrome.tabs.create({ url: `${APP_BASE_URL}/#pricing`, active: true });
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
    renderResult();
    await persistState();
    setStatus(response.result?.debug?.diagnosis || "Done.");
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
  await refreshProductInfo();
  renderStoreState();
}

async function restoreState() {
  try {
    const stored = await chrome.storage.local.get(STORAGE_KEY);
    const saved = stored?.[STORAGE_KEY];
    if (!saved) return;

    state.data = saved.data || null;
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
  persistState();
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

async function fetchJson(url) {
  const response = await chrome.runtime.sendMessage({
    type: "REVIEWLENS_FETCH_JSON",
    url,
  });

  if (!response?.ok) {
    throw new Error(response?.error || "Request failed.");
  }

  return response.result;
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

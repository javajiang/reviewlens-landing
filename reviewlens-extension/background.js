const EXTENSION_PREFIX = "[ReviewLens]";

chrome.runtime.onMessage.addListener((message, sender, sendResponse) => {
  if (message?.type !== "REVIEWLENS_SCRAPE_URL") return;

  handleScrapeRequest(message.url)
    .then((result) => sendResponse({ ok: true, result }))
    .catch((error) =>
      sendResponse({
        ok: false,
        error: error instanceof Error ? error.message : String(error),
      })
    );

  return true;
});

chrome.runtime.onMessage.addListener((message, sender, sendResponse) => {
  if (message?.type !== "REVIEWLENS_FETCH_JSON") return;

  handleJsonRequest(message)
    .then((result) => sendResponse({ ok: true, result }))
    .catch((error) =>
      sendResponse({
        ok: false,
        error: error instanceof Error ? error.message : String(error),
      })
    );

  return true;
});

chrome.runtime.onMessage.addListener((message, sender, sendResponse) => {
  if (message?.type !== "REVIEWLENS_FETCH_REVIEW_JSON") return;

  handleReviewJsonRequest(message)
    .then((result) => sendResponse({ ok: true, result }))
    .catch((error) => sendResponse({
      ok: false,
      error: error instanceof Error ? error.message : String(error),
    }));

  return true;
});

async function handleScrapeRequest(url) {
  const targetUrl = String(url || "").trim();
  if (!targetUrl) throw new Error("Missing URL.");

  const currentTab = await getCurrentTab();
  const currentUrl = currentTab?.url || "";

  if (currentTab?.id && sameUrl(currentUrl, targetUrl)) {
    return scrapeTab(currentTab.id);
  }

  const tab = await chrome.tabs.create({ url: targetUrl, active: false });
  try {
    await waitForTabComplete(tab.id);
    return await scrapeTab(tab.id, true);
  } finally {
    if (tab.id) {
      await chrome.tabs.remove(tab.id).catch(() => {});
    }
  }
}

async function scrapeTab(tabId, retries = false) {
  const response = await sendMessageWithRetry(
    tabId,
    { type: "REVIEWLENS_SCRAPE_PAGE" },
    retries ? 12 : 8,
    400
  );
  if (!response?.ok) {
    throw new Error(response?.error || "The page crawler could not extract reviews.");
  }
  return response;
}

async function sendMessageWithRetry(tabId, message, attempts, delayMs) {
  let lastError;

  for (let attempt = 0; attempt < attempts; attempt += 1) {
    try {
      return await chrome.tabs.sendMessage(tabId, message);
    } catch (error) {
      lastError = error;
      await sleep(delayMs);
    }
  }

  throw lastError || new Error("Unable to reach the page script.");
}

async function waitForTabComplete(tabId) {
  const tab = await chrome.tabs.get(tabId);
  if (tab.status === "complete") {
    await sleep(700);
    return;
  }

  await new Promise((resolve, reject) => {
    const timeout = setTimeout(() => {
      chrome.tabs.onUpdated.removeListener(onUpdated);
      reject(new Error("Timed out waiting for page load."));
    }, 30000);

    function onUpdated(updatedTabId, info) {
      if (updatedTabId !== tabId || info.status !== "complete") return;
      clearTimeout(timeout);
      chrome.tabs.onUpdated.removeListener(onUpdated);
      sleep(700).then(resolve);
    }

    chrome.tabs.onUpdated.addListener(onUpdated);
  });
}

async function getCurrentTab() {
  const [tab] = await chrome.tabs.query({ active: true, currentWindow: true });
  return tab || null;
}

function sameUrl(a, b) {
  try {
    return new URL(a).href === new URL(b).href;
  } catch {
    return String(a || "").trim() === String(b || "").trim();
  }
}

function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

async function handleJsonRequest(message) {
  const url = String(message?.url || "").trim();
  if (!url) throw new Error("Missing request URL.");

  const method = String(message?.method || "GET").toUpperCase();
  const headers = { ...(message?.headers || {}) };
  const hasBody = message?.body !== undefined && message?.body !== null;
  if (hasBody && !Object.keys(headers).some((key) => key.toLowerCase() === "content-type")) {
    headers["content-type"] = "application/json";
  }

  const response = await fetch(url, {
    method,
    headers,
    body: hasBody ? JSON.stringify(message.body) : undefined,
  });

  const text = await response.text();
  let data;
  try {
    data = text ? JSON.parse(text) : {};
  } catch {
    data = { raw: text };
  }

  return {
    status: response.status,
    ok: response.ok,
    data,
  };
}

async function handleReviewJsonRequest(message) {
  const url = new URL(String(message?.url || ""));
  const isOkendo = url.hostname === "api.okendo.io" && url.pathname.startsWith("/v1/");
  const isJunip = url.hostname === "apid.juniphq.com"
    && /^\/[a-z-]+\/v2\/products\/remote\/[^/]+\/reviews$/i.test(url.pathname);
  if (url.protocol !== "https:" || (!isOkendo && !isJunip)) {
    throw new Error("Unsupported review API URL.");
  }
  const headers = {
    accept: "application/json,text/plain,*/*",
    "user-agent": "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124.0 Safari/537.36",
  };
  if (isJunip) {
    const storeKey = String(message?.headers?.["junip-store-key"] || "").trim();
    if (!/^[a-z0-9_-]{8,128}$/i.test(storeKey)) throw new Error("Missing Junip store key.");
    headers["junip-store-key"] = storeKey;
  }
  const response = await fetch(url.toString(), {
    headers,
  });
  return {
    ok: response.ok,
    status: response.status,
    contentType: response.headers.get("content-type") || "application/json",
    data: await response.json().catch(() => null),
  };
}

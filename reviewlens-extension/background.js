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
  return sendMessageWithRetry(tabId, { type: "REVIEWLENS_SCRAPE_PAGE" }, retries ? 12 : 8, 400);
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

  const response = await fetch(url, {
    method: String(message?.method || "GET").toUpperCase(),
    headers: message?.headers || {},
    body: message?.body ? JSON.stringify(message.body) : undefined,
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

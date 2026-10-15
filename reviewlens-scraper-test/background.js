chrome.runtime.onMessage.addListener((message, sender, sendResponse) => {
  if (message?.type !== "REVIEWLENS_TEST_SCRAPE_ACTIVE_TAB") return;

  scrapeActiveTab()
    .then((result) => sendResponse({ ok: true, result }))
    .catch((error) => {
      sendResponse({
        ok: false,
        error: error instanceof Error ? error.message : String(error),
      });
    });

  return true;
});

async function scrapeActiveTab() {
  const [tab] = await chrome.tabs.query({ active: true, currentWindow: true });
  if (!tab?.id) throw new Error("No active browser tab found.");
  if (!/^https?:\/\//i.test(tab.url || "")) {
    throw new Error("Open a public Shopify product page before testing.");
  }

  return sendMessageWithRetry(tab.id, { type: "REVIEWLENS_SCRAPE_PAGE" }, 8, 400);
}

async function sendMessageWithRetry(tabId, message, attempts, delayMs) {
  let lastError;

  for (let attempt = 0; attempt < attempts; attempt += 1) {
    try {
      const response = await chrome.tabs.sendMessage(tabId, message);
      if (!response?.ok) throw new Error(response?.error || "Scrape failed.");
      return response;
    } catch (error) {
      lastError = error;
      await sleep(delayMs);
    }
  }

  throw lastError || new Error("Unable to reach the page script. Refresh the product page and try again.");
}

function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

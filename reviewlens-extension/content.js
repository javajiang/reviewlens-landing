(() => {
  const isTopFrame = window.top === window;

  const REVIEW_URL_PATTERN = /review|reviews|judgeme|judge\.me|loox|yotpo|stamped|okendo|bazaarvoice|powerreviews/i;
  const CAPTURE_LIMIT = 100;
  const JUDGE_ME_REVIEW_LIMIT = 100;
  const JUDGE_ME_LOAD_TIMEOUT_MS = 60_000;
  const YOTPO_REVIEW_LIMIT = 100;
  const YOTPO_LOAD_TIMEOUT_MS = 60_000;
  const STAMPED_REVIEW_LIMIT = 100;
  const STAMPED_LOAD_TIMEOUT_MS = 60_000;
  const OKENDO_REVIEW_LIMIT = 100;
  const OKENDO_LOAD_TIMEOUT_MS = 60_000;
  const state = {
    networkPayloads: [],
    looxInlineSnapshots: [],
    looxExpectedCount: null,
    frameExpansions: [],
    hooksInstalled: false,
  };

  installLooxSnapshotObserver();
  installPageHooks();
  window.addEventListener("message", onWindowMessage);

  chrome.runtime.onMessage.addListener((message, sender, sendResponse) => {
    if (message?.type !== "REVIEWLENS_GET_CONTEXT") return;
    if (!isTopFrame) return;

    sendResponse({
      ok: true,
      context: getPageContext(),
    });
  });

  chrome.runtime.onMessage.addListener((message, sender, sendResponse) => {
    if (message?.type !== "REVIEWLENS_SCRAPE_PAGE") return;
    if (!isTopFrame) return;

    runScrape()
      .then((result) => sendResponse(result))
      .catch((error) =>
        sendResponse({
          ok: false,
          error: error instanceof Error ? error.message : String(error),
        })
      );

    return true;
  });

  window.addEventListener("message", onFrameExpansionRequest);

  async function onFrameExpansionRequest(event) {
    if (isTopFrame || event.source !== window.parent) return;
    if (!event.data || event.data.source !== "reviewlens" || event.data.type !== "expand-frame") return;

    const providerDetection = detectReviewProvider();
    if (providerDetection.primary !== "okendo") return;

    const expansion = await expandOkendoReviews();
    window.parent.postMessage({
      source: "reviewlens",
      type: "frame-expansion-result",
      result: {
        providerDetection,
        ...expansion,
      },
    }, "*");
  }

  function installPageHooks() {
    if (state.hooksInstalled) return;
    state.hooksInstalled = true;

    const script = document.createElement("script");
    script.textContent = `(() => {
      if (window.__reviewLensHooksInstalled) return;
      window.__reviewLensHooksInstalled = true;

      const REVIEW_URL_PATTERN = ${REVIEW_URL_PATTERN.toString()};
      const MAX_BODY_LENGTH = ${1_000_000};

      const postPayload = (payload) => {
        try {
          window.postMessage({ source: "reviewlens", type: "network", payload }, "*");
        } catch (_) {}
      };

      const shouldCapture = (url, contentType) => {
        return REVIEW_URL_PATTERN.test(url) && /json|javascript|text|html/i.test(contentType || "");
      };

      const readBody = async (response, contentType) => {
        try {
          const clone = response.clone();
          if (/json/i.test(contentType)) return await clone.json();
          const text = await clone.text();
          return text.length > MAX_BODY_LENGTH ? text.slice(0, MAX_BODY_LENGTH) : text;
        } catch (error) {
          return null;
        }
      };

      const originalFetch = window.fetch;
      window.fetch = async function (...args) {
        const response = await originalFetch.apply(this, args);
        try {
          const request = args[0];
          const url = typeof request === "string" ? request : (request && request.url) || "";
          const contentType = response.headers.get("content-type") || "";
          if (shouldCapture(url, contentType)) {
            const body = await readBody(response, contentType);
            if (body !== null) {
              postPayload({ url, contentType, body });
            }
          }
        } catch (_) {}
        return response;
      };

      const originalOpen = XMLHttpRequest.prototype.open;
      const originalSend = XMLHttpRequest.prototype.send;

      XMLHttpRequest.prototype.open = function (method, url, ...rest) {
        this.__reviewLensUrl = String(url || "");
        return originalOpen.call(this, method, url, ...rest);
      };

      XMLHttpRequest.prototype.send = function (...args) {
        this.addEventListener("load", () => {
          try {
            const url = this.__reviewLensUrl || "";
            const contentType = this.getResponseHeader("content-type") || "";
            if (!shouldCapture(url, contentType)) return;
            const body = /json/i.test(contentType) ? JSON.parse(this.responseText) : this.responseText;
            if (body !== null && body !== undefined) {
              postPayload({ url, contentType, body });
            }
          } catch (_) {}
        });

        return originalSend.apply(this, args);
      };

      const postOkendoMetadata = () => {
        try {
          const node = document.querySelector('script[data-oke-metafield-data]');
          if (!node?.textContent) return;
          const body = JSON.parse(node.textContent);
          window.postMessage({
            source: 'reviewlens',
            type: 'network',
            payload: {
              url: 'https://reviewlens.local/okendo/embedded-meta',
              contentType: 'application/json',
              body,
            },
          }, '*');
        } catch (_) {}
      };

      const observeOkendoMetadata = () => {
        postOkendoMetadata();

        const observer = new MutationObserver(() => {
          postOkendoMetadata();
        });

        observer.observe(document.documentElement, {
          subtree: true,
          childList: true,
          attributes: true,
          characterData: true,
        });

        setTimeout(postOkendoMetadata, 1200);
        setTimeout(postOkendoMetadata, 3000);
      };

      if (document.readyState === 'loading') {
        document.addEventListener('DOMContentLoaded', observeOkendoMetadata, { once: true });
      } else {
        observeOkendoMetadata();
      }
    })();`;
    document.documentElement.appendChild(script);
    script.remove();
  }

  function getPageContext() {
    const hostname = location.hostname || "";
    const url = location.href || "";
    const title = document.title || "";
    const shopDomain = detectShopDomain();
    const isProductPage = detectProductPage();

    return {
      url,
      title,
      hostname,
      isShopify: Boolean(shopDomain || /shopify/i.test(hostname)),
      isProductPage,
      shopDomain,
      productUrl: isProductPage ? url : "",
      canAuthorize: Boolean(shopDomain),
    };
  }

  function detectProductPage() {
    const url = location.href.toLowerCase();
    if (url.includes("/products/")) return true;
    if (document.querySelector("meta[property='og:type'][content='product']")) return true;
    if (document.querySelector("form[action*='/cart/add']")) return true;
    if (document.querySelector("[name='add'], button[type='submit'], button[name='add']")) return true;
    if (document.querySelector("input[name='id']")) return true;
    return false;
  }

  function detectShopDomain() {
    const hostname = String(location.hostname || "").toLowerCase();
    if (hostname.endsWith(".myshopify.com")) return hostname;

    const explicitShop =
      String(window.Shopify?.shop || "").trim().toLowerCase() ||
      String(window.Shopify?.shopOrigin || "").trim().toLowerCase();
    if (explicitShop && explicitShop.endsWith(".myshopify.com")) return explicitShop;

    const canonical = document.querySelector('link[rel="canonical"]')?.href || "";
    try {
      const canonicalHost = new URL(canonical).hostname.toLowerCase();
      if (canonicalHost.endsWith(".myshopify.com")) return canonicalHost;
    } catch (_) {}

    return "";
  }

  function onWindowMessage(event) {
    const data = event.data;
    if (!data || data.source !== "reviewlens") return;

    if (isTopFrame && data.type === "frame-expansion-result" && data.result) {
      state.frameExpansions.push(data.result);
      return;
    }
    if (data.type !== "network") return;

    const payload = data.payload;
    if (!payload || !payload.url) return;

    if (!isTopFrame) {
      try {
        window.top.postMessage(data, "*");
      } catch (_) {}
      return;
    }

    if (state.networkPayloads.some((item) => item.url === payload.url && stableBodyKey(item.body) === stableBodyKey(payload.body))) {
      return;
    }

    state.networkPayloads.push({
      url: String(payload.url),
      contentType: String(payload.contentType || ""),
      body: payload.body,
    });

    if (state.networkPayloads.length > CAPTURE_LIMIT) {
      state.networkPayloads.shift();
    }
  }

  async function requestFrameExpansions() {
    if (!isTopFrame || document.querySelectorAll("iframe").length === 0) return [];

    state.frameExpansions = [];
    for (const iframe of document.querySelectorAll("iframe")) {
      try {
        iframe.contentWindow?.postMessage({
          source: "reviewlens",
          type: "expand-frame",
        }, "*");
      } catch (_) {}
    }

    await sleep(7_000);
    return state.frameExpansions.slice();
  }

  async function runScrape() {
    await settlePage();

    const debug = {
      url: location.href,
      pageTitle: document.title || "",
      visibleReviewCounts: {},
      iframeCount: 0,
      detectedProviders: [],
      providerDetection: null,
      loadMore: null,
      diagnosis: "",
    };

    if (!isLikelyShopifyProductPage()) {
      return {
        ok: false,
        error: "Unsupported URL. Please open a Shopify product page.",
        debug,
      };
    }

    const providerDetection = detectReviewProvider();
    const expansion = providerDetection.primary === "judge.me"
      ? await expandJudgeMeReviews()
      : providerDetection.primary === "loox"
        ? await collectLooxReviews()
        : providerDetection.primary === "yotpo"
          ? await expandYotpoReviews()
          : providerDetection.primary === "stamped"
            ? await expandStampedReviews()
          : providerDetection.primary === "okendo"
            ? await expandOkendoReviews()
          : await expandGenericReviewWidgets();
    const frameExpansions = await requestFrameExpansions();
    await waitForOkendoMetadata(5_000);

    const html = document.documentElement.outerHTML;
    const jsonLdReviews = extractJsonLdReviews(html);
    const visibleReviews = extractVisibleReviews(document);
    const embeddedFrameReviews = extractFrameReviews();
    const providerReviews = extractProviderReviews(state.networkPayloads);
    const expandedFrameReviews = frameExpansions.flatMap((item) => item.reviews || []);
    const allReviews = dedupeReviews([
      ...(expansion.reviews || []),
      ...jsonLdReviews,
      ...visibleReviews,
      ...embeddedFrameReviews,
      ...expandedFrameReviews,
      ...providerReviews,
    ]);
    const reviews = allReviews.sort((a, b) => reviewRank(a) - reviewRank(b) || (ratingValue(a) - ratingValue(b)));

    const negative = reviews.filter((review) => Number.isFinite(review?.rating) && review.rating <= 3);
    const positive = reviews.filter((review) => Number.isFinite(review?.rating) && review.rating >= 4);

    debug.visibleReviewCounts = countVisibleSignals();
    debug.iframeCount = document.querySelectorAll("iframe").length;
    debug.detectedProviders = Array.from(new Set([
      ...inferProviders(state.networkPayloads, debug.visibleReviewCounts),
      ...(providerDetection.primary !== "unknown" ? [providerDetection.primary] : []),
    ])).sort();
    debug.providerDetection = providerDetection;
    debug.loadMore = frameExpansions.find((item) => item.diagnostics)?.diagnostics
      || expansion.diagnostics;
    debug.frameExpansions = frameExpansions.map((item) => ({
      provider: item.providerDetection?.primary || item.diagnostics?.provider || "unknown",
      diagnostics: item.diagnostics || null,
      reviewCount: item.reviews?.length || 0,
    }));
    debug.diagnosis = diagnoseScrape(debug.iframeCount, debug.visibleReviewCounts, state.networkPayloads, reviews.length);

    return {
      ok: true,
      url: location.href,
      scrapedAt: new Date().toISOString(),
      count: reviews.length,
      negativeCount: negative.length,
      positiveCount: positive.length,
      reviews,
      negativeReviews: negative,
      positiveReviews: positive,
      analysis: {
        status: "coming-soon",
        label: "Analysis coming soon",
      },
      debug,
    };
  }

  async function settlePage() {
    await sleep(800);
    await Promise.race([
      waitForAnyReviewSignal(5000),
      sleep(1200),
    ]);
  }

  async function waitForAnyReviewSignal(timeoutMs) {
    const selectors = reviewSelectors();
    const matched = document.querySelector(selectors.join(","));
    if (matched) return;

    await new Promise((resolve) => setTimeout(resolve, timeoutMs));
  }

  async function waitForOkendoMetadata(timeoutMs) {
    const start = Date.now();
    while (Date.now() - start < timeoutMs) {
      const okendoPayload = state.networkPayloads.find((item) => /okendo/i.test(item.url));
      if (okendoPayload) return true;
      await sleep(250);
    }
    return false;
  }

  function isLikelyShopifyProductPage() {
    const url = location.href.toLowerCase();
    if (url.includes("/products/")) return true;
    if (document.querySelector("meta[property='og:type'][content='product']")) return true;
    if (document.querySelector("form[action*='/cart/add']")) return true;
    if (document.querySelector("[name='add'], button[type='submit'], button[name='add']")) return true;
    if (document.querySelector("input[name='id']")) return true;
    return /shopify|cdn\.shopify\.com/i.test(document.documentElement.innerHTML);
  }

  function detectReviewProvider() {
    const candidates = [];

    addProviderCandidate(candidates, "judge.me", ".jdgm-rev-widg", "Judge.me review widget");
    addProviderCandidate(candidates, "judge.me", ".jdgm-rev", "Judge.me review items");
    addProviderCandidate(candidates, "judge.me", ".jdgm-paginate", "Judge.me pagination");
    addProviderCandidate(candidates, "loox", ".loox-review, .grid-item.clearfix", "Loox review items");
    addProviderCandidate(candidates, "loox", "#loox-inline-reviews, .loox-reviews", "Loox review wrapper");
    addProviderCandidate(candidates, "loox", ".loox-rating[data-testid='loox-rating-widget'], script[src*='loox.io']", "Loox widget script or rating");
    addProviderCandidate(candidates, "loox", "[data-loox-hash]", "Loox data hash");
    addProviderHtmlCandidate(candidates, "loox", /"namespace"\s*:\s*"loox"[\s\S]{0,200}"key"\s*:\s*"reviews"/i, "Loox embedded reviews metafield");
    addProviderHtmlCandidate(candidates, "loox", /id=\\?["']loox-inline-reviews/i, "Loox embedded review markup");
    if (state.looxInlineSnapshots.length > 0) {
      candidates.push({ provider: "loox", signal: "Captured Loox inline review snapshot" });
    }
    addProviderCandidate(candidates, "yotpo", ".yotpo-review", "Yotpo review items");
    addProviderCandidate(candidates, "yotpo", ".yotpo-widget-instance, .yotpo-main-widget, [data-yotpo-instance-id]", "Yotpo review widget");
    addProviderCandidate(candidates, "yotpo", ".yotpo-reviews-pagination-container, .yotpo-pager, [class*='yotpo'][class*='pagination']", "Yotpo pagination");
    addProviderCandidate(candidates, "yotpo", "script[src*='yotpo.com'], script[src*='yotpoassets.com']", "Yotpo widget script");
    addProviderCandidate(candidates, "stamped", ".stamped-review, .stamped-product-reviews-badge", "Stamped review widget");
    addProviderCandidate(candidates, "stamped", ".stamped-pagination, [class*='stamped'][class*='pagination']", "Stamped pagination");
    addProviderCandidate(candidates, "stamped", "script[src*='stamped.io'], script[src*='stampedapp.io']", "Stamped widget script");
    addProviderCandidate(candidates, "okendo", ".okeReviews, .oke-w-reviews-list-item, .okeReviews-review", "Okendo review widget");
    addProviderCandidate(candidates, "junip", ".junip-review-list-item-container, .junip-review, .junip-product-review", "Junip review widget");

    const grouped = new Map();
    for (const candidate of candidates) {
      const signals = grouped.get(candidate.provider) || [];
      signals.push(candidate.signal);
      grouped.set(candidate.provider, signals);
    }

    const ranked = Array.from(grouped.entries())
      .map(([provider, signals]) => ({ provider, signals }))
      .sort((left, right) => right.signals.length - left.signals.length);
    const primary = ranked[0] || null;

    return {
      primary: primary?.provider || "unknown",
      confidence: primary ? (primary.signals.length >= 2 ? "high" : "medium") : "unknown",
      signals: primary?.signals || [],
      candidates: ranked,
    };
  }

  function addProviderCandidate(candidates, provider, selector, signal) {
    if (document.querySelector(selector)) candidates.push({ provider, signal });
  }

  function addProviderHtmlCandidate(candidates, provider, pattern, signal) {
    if (pattern.test(document.documentElement.outerHTML)) candidates.push({ provider, signal });
  }

  function installLooxSnapshotObserver() {
    const capture = (root) => {
      if (!root) return;
      const nodes = [];
      if (root.nodeType === Node.ELEMENT_NODE && root.matches("#loox-inline-reviews")) {
        nodes.push(root);
      }
      if (typeof root.querySelectorAll === "function") {
        nodes.push(...root.querySelectorAll("#loox-inline-reviews"));
        const rating = root.querySelector(".loox-rating[data-raters]");
        const count = positiveInteger(rating?.dataset?.raters);
        if (count) state.looxExpectedCount = Math.max(state.looxExpectedCount || 0, count);
      }

      for (const node of nodes) {
        const snapshot = node.outerHTML || "";
        const previous = state.looxInlineSnapshots[0] || "";
        if (snapshot.includes("class=\"review\"") && snapshot.length > previous.length) {
          state.looxInlineSnapshots = [snapshot];
        }
      }
    };

    const start = () => {
      if (!document.documentElement) {
        setTimeout(start, 0);
        return;
      }

      capture(document.documentElement);
      const observer = new MutationObserver((mutations) => {
        for (const mutation of mutations) {
          for (const node of mutation.addedNodes) capture(node);
          if (mutation.target?.nodeType === Node.ELEMENT_NODE) {
            capture(mutation.target.closest?.("#loox-inline-reviews"));
          }
        }
      });
      observer.observe(document.documentElement, {
        subtree: true,
        childList: true,
      });
    };

    start();
  }

  async function expandJudgeMeReviews() {
    const widget = document.querySelector(".jdgm-rev-widg");
    const pagination = document.querySelector(".jdgm-paginate");
    const expectedCount = positiveInteger(widget?.dataset?.numberOfReviews);
    const perPage = positiveInteger(pagination?.dataset?.perPage) || 5;
    const initialCount = getJudgeMeReviewCount();
    const targetCount = Math.min(expectedCount || JUDGE_ME_REVIEW_LIMIT, JUDGE_ME_REVIEW_LIMIT);
    const reviews = extractJudgeMeReviews();
    const errors = [];
    const startedAt = Date.now();
    let attempts = 0;
    let pagesLoaded = 0;
    let stoppedReason = "";

    while (getJudgeMeReviewCount() < targetCount) {
      if (Date.now() - startedAt >= JUDGE_ME_LOAD_TIMEOUT_MS) {
        stoppedReason = "timeout";
        break;
      }

      const button = findJudgeMeLoadMoreButton();
      if (!button) {
        stoppedReason = "button_missing";
        break;
      }

      const beforeCount = getJudgeMeReviewCount();
      const beforePage = positiveInteger(button.dataset?.page);
      attempts += 1;
      button.scrollIntoView({ block: "center" });
      button.click();

      const progressed = await waitForJudgeMeProgress({
        beforeCount,
        beforePage,
        previousButton: button,
        timeoutMs: 5_000,
      });

      reviews.push(...extractJudgeMeReviews());
      if (!progressed) {
        errors.push(`Load More attempt ${attempts} did not add reviews or advance the page.`);
        stoppedReason = "no_progress";
        break;
      }

      pagesLoaded += 1;
    }

    const finalCount = getJudgeMeReviewCount();
    if (!stoppedReason) {
      if (expectedCount && finalCount >= expectedCount) {
        stoppedReason = "expected_count_reached";
      } else if (finalCount >= JUDGE_ME_REVIEW_LIMIT) {
        stoppedReason = "configured_limit_reached";
      } else {
        stoppedReason = "completed";
      }
    }

    return {
      reviews: dedupeReviews(reviews),
      diagnostics: {
        provider: "judge.me",
        method: "provider_load_more",
        expectedCount,
        configuredLimit: JUDGE_ME_REVIEW_LIMIT,
        targetCount,
        perPage,
        initialCount,
        finalDomCount: finalCount,
        attempts,
        pagesLoaded,
        complete: Boolean(expectedCount && finalCount >= expectedCount),
        stoppedReason,
        elapsedMs: Date.now() - startedAt,
        errors,
      },
    };
  }

  function findJudgeMeLoadMoreButton() {
    const candidates = Array.from(document.querySelectorAll(
      ".jdgm-paginate__load-more, .jdgm-paginate a[role='button']"
    ));

    return candidates.find((node) => {
      if (!node.isConnected) return false;
      if (node.matches("[disabled], [aria-disabled='true']")) return false;
      const style = window.getComputedStyle(node);
      return style.display !== "none" && style.visibility !== "hidden";
    }) || null;
  }

  function getJudgeMeReviewCount() {
    return document.querySelectorAll(".jdgm-rev").length;
  }

  function extractJudgeMeReviews() {
    return Array.from(document.querySelectorAll(".jdgm-rev"))
      .map((node) => extractReviewFromContainer(node))
      .filter(Boolean);
  }

  async function waitForJudgeMeProgress({ beforeCount, beforePage, previousButton, timeoutMs }) {
    const start = Date.now();

    while (Date.now() - start < timeoutMs) {
      await sleep(250);
      if (getJudgeMeReviewCount() > beforeCount) return true;

      const currentButton = findJudgeMeLoadMoreButton();
      if (!currentButton && !previousButton.isConnected) return true;
      const currentPage = positiveInteger(currentButton?.dataset?.page);
      if (beforePage && currentPage && currentPage > beforePage) return true;
      if (currentButton && currentButton !== previousButton) return true;
    }

    return false;
  }

  function positiveInteger(value) {
    const number = Number.parseInt(String(value || "").replaceAll(",", ""), 10);
    return Number.isFinite(number) && number > 0 ? number : null;
  }

  async function collectLooxReviews() {
    const html = document.documentElement.outerHTML;
    const embedded = extractEmbeddedLooxReviews(html);
    const inlineReviews = dedupeLooxReviews([
      ...extractInlineLooxReviews(document),
      ...state.looxInlineSnapshots.flatMap((snapshot) => extractInlineLooxReviewsFromHtml(snapshot)),
    ]);
    const legacyReviews = extractLegacyLooxReviews();
    const reviews = dedupeLooxReviews([
      ...embedded.reviews,
      ...inlineReviews,
      ...legacyReviews,
    ]);
    const methods = [];
    if (embedded.blocksFound > 0) methods.push("embedded_metafield");
    if (inlineReviews.length > 0) methods.push("inline_html");
    if (legacyReviews.length > 0) methods.push("legacy_dom");
    methods.push("network");

    return {
      reviews,
      diagnostics: {
        provider: "loox",
        method: methods.join("+"),
        expectedCount: extractLooxExpectedCount(html),
        embeddedCount: embedded.reviews.length,
        embeddedBlocks: embedded.blocksFound,
        inlineCount: inlineReviews.length,
        finalDomCount: legacyReviews.length,
        extractedCount: reviews.length,
        attempts: 0,
        pagesLoaded: 0,
        complete: false,
        stoppedReason: inlineReviews.length > 0
          ? "inline_snapshot_extracted"
          : embedded.blocksFound > 0
            ? "embedded_snapshot_extracted"
            : "legacy_snapshot_extracted",
        errors: embedded.errors,
      },
    };
  }

  function extractEmbeddedLooxReviews(html) {
    const reviews = [];
    const errors = [];
    const values = [];
    const valuePattern = /"namespace"\s*:\s*"loox"\s*,\s*"key"\s*:\s*"reviews"\s*,\s*"value"\s*:\s*"((?:\\.|[^"\\])*)"/gi;
    let match;

    while ((match = valuePattern.exec(html)) !== null) {
      try {
        values.push(JSON.parse(`"${match[1]}"`));
      } catch (error) {
        errors.push(`Unable to decode an embedded Loox review block: ${error instanceof Error ? error.message : String(error)}`);
      }
    }

    for (const value of values) {
      const doc = new DOMParser().parseFromString(value, "text/html");
      const containers = Array.from(doc.querySelectorAll(
        "#loox-inline-reviews .review, .loox-reviews .review"
      ));

      for (const container of containers) {
        const review = extractEmbeddedLooxReview(container);
        if (review) reviews.push(review);
      }
    }

    return {
      reviews: dedupeLooxReviews(reviews),
      blocksFound: values.length,
      errors,
    };
  }

  function extractInlineLooxReviews(root) {
    return Array.from(root.querySelectorAll(
      "#loox-inline-reviews .review, .loox-reviews-default #loox-inline-reviews .review"
    ))
      .map((container) => extractEmbeddedLooxReview(container, "loox-inline"))
      .filter(Boolean);
  }

  function extractInlineLooxReviewsFromHtml(html) {
    const doc = new DOMParser().parseFromString(html, "text/html");
    return extractInlineLooxReviews(doc);
  }

  function extractEmbeddedLooxReview(container, source = "loox-embedded") {
    const body = pickText(container, [".review_text", ".review-text", "[itemprop='reviewBody']"]);
    if (clean(body).length < 12) return null;

    return normalizeReview({
      source,
      title: pickText(container, [".review_title", ".review-title", "[itemprop='name']"]),
      body,
      author: pickText(container, [".name", ".reviewer-name", "[itemprop='author']"]),
      date: pickText(container, [".date", ".review-date", "time", "[itemprop='datePublished']"]),
      rating: readRating(container),
    });
  }

  function extractLegacyLooxReviews() {
    return Array.from(document.querySelectorAll(".loox-review, .grid-item.clearfix"))
      .map((node) => extractReviewFromContainer(node))
      .filter(Boolean);
  }

  function extractLooxExpectedCount(html) {
    const counts = Array.from(document.querySelectorAll(".loox-rating[data-raters]"))
      .map((node) => positiveInteger(node.dataset?.raters))
      .filter(Boolean);
    if (state.looxExpectedCount) counts.push(state.looxExpectedCount);
    const metafieldMatch = html.match(
      /"namespace"\s*:\s*"loox"\s*,\s*"key"\s*:\s*"num_reviews"\s*,\s*"value"\s*:\s*"(\d+)"/i
    );
    const metafieldCount = positiveInteger(metafieldMatch?.[1]);
    if (metafieldCount) counts.push(metafieldCount);

    return counts.length > 0 ? Math.max(...counts) : null;
  }

  function dedupeLooxReviews(reviews) {
    const seen = new Set();
    const results = [];

    for (const review of reviews) {
      if (!review?.body) continue;
      const key = reviewContentKey(review);
      if (seen.has(key)) continue;
      seen.add(key);
      results.push(review);
    }

    return results;
  }

  async function expandYotpoReviews() {
    const reviews = [];
    const errors = [];
    const startedAt = Date.now();
    const expectedCount = extractYotpoExpectedCount();
    const initialCount = getYotpoReviewCount();
    let attempts = 0;
    let pagesLoaded = 0;
    let stoppedReason = "";

    const firstPageButton = findYotpoPageButton(1);
    const currentPage = getYotpoCurrentPage();
    if (firstPageButton && currentPage && currentPage > 1) {
      const beforeFingerprint = getYotpoPageFingerprint();
      firstPageButton.scrollIntoView({ block: "center" });
      firstPageButton.click();
      const reset = await waitForYotpoPageChange(beforeFingerprint, 5_000);
      if (!reset) errors.push("Unable to return Yotpo pagination to page 1.");
    }

    while (reviews.length < YOTPO_REVIEW_LIMIT) {
      reviews.push(...extractYotpoReviews());
      const uniqueReviews = dedupeReviews(reviews);
      reviews.length = 0;
      reviews.push(...uniqueReviews);

      if (reviews.length >= YOTPO_REVIEW_LIMIT) {
        stoppedReason = "configured_limit_reached";
        break;
      }
      if (Date.now() - startedAt >= YOTPO_LOAD_TIMEOUT_MS) {
        stoppedReason = "timeout";
        break;
      }

      const nextButton = findYotpoNextButton();
      if (!nextButton) {
        stoppedReason = "next_button_missing";
        break;
      }

      const beforeFingerprint = getYotpoPageFingerprint();
      attempts += 1;
      nextButton.scrollIntoView({ block: "center" });
      nextButton.click();

      const progressed = await waitForYotpoPageChange(beforeFingerprint, 5_000);
      if (!progressed) {
        errors.push(`Next page attempt ${attempts} did not change the Yotpo reviews.`);
        stoppedReason = "no_progress";
        break;
      }

      pagesLoaded += 1;
    }

    if (!stoppedReason) stoppedReason = "completed";

    return {
      reviews: dedupeReviews(reviews).slice(0, YOTPO_REVIEW_LIMIT),
      diagnostics: {
        provider: "yotpo",
        method: "provider_pagination",
        expectedCount,
        configuredLimit: YOTPO_REVIEW_LIMIT,
        initialCount,
        finalDomCount: getYotpoReviewCount(),
        extractedCount: Math.min(reviews.length, YOTPO_REVIEW_LIMIT),
        attempts,
        pagesLoaded,
        complete: Boolean(expectedCount && reviews.length >= expectedCount),
        stoppedReason,
        elapsedMs: Date.now() - startedAt,
        errors,
      },
    };
  }

  function extractYotpoReviews() {
    return Array.from(document.querySelectorAll(".yotpo-review"))
      .map((node) => extractReviewFromContainer(node))
      .filter(Boolean);
  }

  function getYotpoReviewCount() {
    return document.querySelectorAll(".yotpo-review").length;
  }

  function getYotpoPageFingerprint() {
    return extractYotpoReviews()
      .map((review) => reviewContentKey(review))
      .join("##")
      .slice(0, 20_000);
  }

  function getYotpoCurrentPage() {
    return positiveInteger(clean(findYotpoCurrentPageNode()?.textContent));
  }

  function findYotpoCurrentPageNode() {
    const explicit = document.querySelector([
      ".yotpo-reviews-pagination-container [aria-current='page']",
      ".yotpo-reviews-pagination-container [aria-selected='true']",
      ".yotpo-pager .active",
      ".yotpo-pager .selected",
      ".yotpo-reviews-pagination-container [aria-pressed='true']",
      ".yotpo-reviews-pagination-container [data-active='true']",
      "[class*='yotpo'][class*='pagination'] [aria-current='page']",
      "[class*='yotpo'][class*='pagination'] [aria-selected='true']",
      "[class*='yotpo'][class*='pagination'] [aria-pressed='true']",
    ].join(","));
    if (explicit) return explicit;

    return getYotpoPaginationButtons().find((node) => {
      const page = positiveInteger(clean(node.textContent));
      return Boolean(page && /active|selected|current/i.test(String(node.className || "")));
    }) || null;
  }

  function findYotpoPageButton(page) {
    const candidates = getYotpoPaginationButtons();
    return candidates.find((node) => clean(node.textContent) === String(page)) || null;
  }

  function findYotpoNextButton() {
    const candidates = getYotpoPaginationButtons();
    const labelled = candidates.find((node) => {
      if (!isUsableAction(node)) return false;
      const text = [
        node.textContent,
        node.getAttribute("aria-label"),
        node.getAttribute("title"),
        node.getAttribute("data-testid"),
        node.className,
      ].map(clean).join(" ");
      if (/previous|prev|back|left/i.test(text)) return false;
      if (/next|right|forward/i.test(text)) return true;
      return Boolean(node.querySelector(
        "[class*='right' i], [class*='next' i], [data-testid*='next' i], svg[aria-label*='next' i]"
      ));
    });
    if (labelled) return labelled;

    const currentPage = getYotpoCurrentPage();
    const nextPageButton = currentPage
      ? candidates.find((node) => positiveInteger(clean(node.textContent)) === currentPage + 1 && isUsableAction(node))
      : null;
    if (nextPageButton) return nextPageButton;

    const numericIndexes = candidates
      .map((node, index) => ({ index, page: positiveInteger(clean(node.textContent)) }))
      .filter((item) => item.page);
    if (numericIndexes.length === 0) return null;

    const lastNumericIndex = numericIndexes[numericIndexes.length - 1].index;
    return candidates.slice(lastNumericIndex + 1).find(isUsableAction) || null;
  }

  function getYotpoPaginationButtons() {
    const selectors = [
      ".yotpo-reviews-pagination-container button",
      ".yotpo-reviews-pagination-container a",
      ".yotpo-pager button",
      ".yotpo-pager a",
      "[class*='yotpo'][class*='pagination'] button",
      "[class*='yotpo'][class*='pagination'] a",
      "[data-testid*='pagination' i] button",
      "[data-testid*='pagination' i] a",
      "button[data-testid*='next' i]",
      "a[data-testid*='next' i]",
    ];
    return Array.from(new Set(document.querySelectorAll(selectors.join(","))));
  }

  function isUsableAction(node) {
    if (!node?.isConnected) return false;
    if (node.matches("[disabled], [aria-disabled='true']")) return false;
    const style = window.getComputedStyle(node);
    return style.display !== "none" && style.visibility !== "hidden";
  }

  async function waitForYotpoPageChange(beforeFingerprint, timeoutMs) {
    const start = Date.now();
    while (Date.now() - start < timeoutMs) {
      await sleep(250);
      const fingerprint = getYotpoPageFingerprint();
      if (fingerprint && fingerprint !== beforeFingerprint) return true;
    }
    return false;
  }

  function extractYotpoExpectedCount() {
    const attributes = [
      "[data-total-reviews]",
      "[data-reviews-count]",
      "[data-review-count]",
      "[data-total]",
    ];
    const counts = [];
    const widget = findYotpoRoot();
    const searchRoot = widget || document;
    const countAttributeNames = ["data-total-reviews", "data-reviews-count", "data-review-count", "data-total"];

    const attributeNodes = Array.from(searchRoot.querySelectorAll(attributes.join(",")));
    if (widget?.matches(attributes.join(","))) attributeNodes.unshift(widget);
    for (const node of attributeNodes) {
      for (const name of countAttributeNames) {
        const count = positiveInteger(node.getAttribute(name));
        if (count) counts.push(count);
      }
    }

    const countNodes = searchRoot.querySelectorAll([
      ".yotpo-bottom-line-text",
      ".yotpo-reviews-count",
      "[data-testid*='reviews-count' i]",
      "[class*='reviews-count' i]",
    ].join(","));
    for (const node of countNodes) {
      const textMatch = clean(node.textContent).match(/([\d,]+)\s+(?:customer\s+)?reviews?/i);
      const textCount = positiveInteger(textMatch?.[1]);
      if (textCount) counts.push(textCount);
    }

    return counts.length > 0 ? Math.max(...counts) : null;
  }

  function findYotpoRoot() {
    const review = document.querySelector(".yotpo-review");
    return review?.closest(
      ".yotpo-widget-instance, .yotpo-main-widget, [data-yotpo-instance-id], [class*='yotpo'][class*='widget']"
    ) || document.querySelector(
      ".yotpo-widget-instance, .yotpo-main-widget, [data-yotpo-instance-id]"
    );
  }

  async function expandStampedReviews() {
    const reviews = [];
    const errors = [];
    const startedAt = Date.now();
    const expectedCount = extractStampedExpectedCount();
    const initialCount = getStampedReviewCount();
    let attempts = 0;
    let pagesLoaded = 0;
    let stoppedReason = "";

    const firstPageButton = findStampedPageButton(1);
    const currentPage = getStampedCurrentPage();
    if (firstPageButton && currentPage && currentPage > 1) {
      const beforeFingerprint = getStampedPageFingerprint();
      firstPageButton.scrollIntoView({ block: "center" });
      firstPageButton.click();
      const reset = await waitForStampedPageChange(beforeFingerprint, 5_000);
      if (!reset) errors.push("Unable to return Stamped pagination to page 1.");
    }

    while (reviews.length < STAMPED_REVIEW_LIMIT) {
      reviews.push(...extractStampedReviews());
      const uniqueReviews = dedupeReviews(reviews);
      reviews.length = 0;
      reviews.push(...uniqueReviews);

      if (reviews.length >= STAMPED_REVIEW_LIMIT) {
        stoppedReason = "configured_limit_reached";
        break;
      }
      if (expectedCount && reviews.length >= expectedCount) {
        stoppedReason = "expected_count_reached";
        break;
      }
      if (Date.now() - startedAt >= STAMPED_LOAD_TIMEOUT_MS) {
        stoppedReason = "timeout";
        break;
      }

      const nextButton = findStampedNextButton();
      if (!nextButton) {
        stoppedReason = "next_button_missing";
        break;
      }

      const beforeFingerprint = getStampedPageFingerprint();
      attempts += 1;
      nextButton.scrollIntoView({ block: "center" });
      nextButton.click();

      const progressed = await waitForStampedPageChange(beforeFingerprint, 5_000);
      if (!progressed) {
        errors.push(`Next page attempt ${attempts} did not change the Stamped reviews.`);
        stoppedReason = "no_progress";
        break;
      }

      pagesLoaded += 1;
    }

    if (!stoppedReason) stoppedReason = "completed";

    return {
      reviews: dedupeReviews(reviews).slice(0, STAMPED_REVIEW_LIMIT),
      diagnostics: {
        provider: "stamped",
        method: "provider_pagination",
        expectedCount,
        configuredLimit: STAMPED_REVIEW_LIMIT,
        initialCount,
        finalDomCount: getStampedReviewCount(),
        extractedCount: Math.min(reviews.length, STAMPED_REVIEW_LIMIT),
        attempts,
        pagesLoaded,
        complete: Boolean(expectedCount && reviews.length >= expectedCount),
        stoppedReason,
        elapsedMs: Date.now() - startedAt,
        errors,
      },
    };
  }

  function extractStampedReviews() {
    return Array.from(document.querySelectorAll(".stamped-review"))
      .map((node) => extractReviewFromContainer(node))
      .filter(Boolean);
  }

  function getStampedReviewCount() {
    return document.querySelectorAll(".stamped-review").length;
  }

  function getStampedPageFingerprint() {
    return extractStampedReviews()
      .map((review) => reviewContentKey(review))
      .join("##")
      .slice(0, 20_000);
  }

  function getStampedCurrentPage() {
    const currentNode = document.querySelector([
      ".stamped-pagination .active",
      ".stamped-pagination [aria-current='page']",
      ".stamped-pagination [aria-selected='true']",
      "[class*='stamped'][class*='pagination'] [aria-current='page']",
      "[class*='stamped'][class*='pagination'] [aria-selected='true']",
    ].join(","));
    if (!currentNode) return null;

    return positiveInteger(
      currentNode.getAttribute("data-page")
      || currentNode.querySelector("[data-page]")?.getAttribute("data-page")
      || clean(currentNode.textContent)
    );
  }

  function findStampedPageButton(page) {
    return getStampedPaginationButtons().find((node) => {
      const nodePage = positiveInteger(
        node.getAttribute("data-page")
        || node.closest("[data-page]")?.getAttribute("data-page")
        || clean(node.textContent)
      );
      return nodePage === page && isUsableAction(node);
    }) || null;
  }

  function findStampedNextButton() {
    const candidates = getStampedPaginationButtons();
    const labelled = candidates.find((node) => {
      if (!isUsableAction(node)) return false;
      const text = [
        node.textContent,
        node.getAttribute("aria-label"),
        node.getAttribute("title"),
        node.className,
        node.parentElement?.className,
      ].map(clean).join(" ");
      if (/previous|prev|back|left/i.test(text)) return false;
      return /next|right|forward/i.test(text);
    });
    if (labelled) return labelled;

    const currentPage = getStampedCurrentPage();
    if (currentPage) {
      const nextPageButton = findStampedPageButton(currentPage + 1);
      if (nextPageButton) return nextPageButton;
    }

    const numericIndexes = candidates
      .map((node, index) => ({
        index,
        page: positiveInteger(
          node.getAttribute("data-page")
          || node.closest("[data-page]")?.getAttribute("data-page")
          || clean(node.textContent)
        ),
      }))
      .filter((item) => item.page);
    if (numericIndexes.length === 0) return null;

    const lastNumericIndex = numericIndexes[numericIndexes.length - 1].index;
    return candidates.slice(lastNumericIndex + 1).find(isUsableAction) || null;
  }

  function getStampedPaginationButtons() {
    const selectors = [
      ".stamped-pagination button",
      ".stamped-pagination a",
      ".stamped-pagination [role='button']",
      "[class*='stamped'][class*='pagination'] button",
      "[class*='stamped'][class*='pagination'] a",
      "[class*='stamped'][class*='pagination'] [role='button']",
    ];
    return Array.from(new Set(document.querySelectorAll(selectors.join(","))));
  }

  async function waitForStampedPageChange(beforeFingerprint, timeoutMs) {
    const start = Date.now();
    while (Date.now() - start < timeoutMs) {
      await sleep(250);
      const fingerprint = getStampedPageFingerprint();
      if (fingerprint && fingerprint !== beforeFingerprint) return true;
    }
    return false;
  }

  function extractStampedExpectedCount() {
    const counts = [];
    const attributeNames = [
      "data-count-reviews",
      "data-review-count",
      "data-reviews-count",
      "data-total-reviews",
      "data-total",
    ];
    const attributeSelector = attributeNames.map((name) => `[${name}]`).join(",");
    const root = findStampedRoot();
    const searchRoot = root || document;
    const attributeNodes = Array.from(searchRoot.querySelectorAll(attributeSelector));
    if (root?.matches(attributeSelector)) attributeNodes.unshift(root);

    for (const node of attributeNodes) {
      for (const name of attributeNames) {
        const count = positiveInteger(node.getAttribute(name));
        if (count) counts.push(count);
      }
    }

    const countNodes = searchRoot.querySelectorAll([
      ".stamped-summary-text",
      ".stamped-summary-caption",
      ".stamped-product-reviews-badge",
      "[class*='stamped'][class*='count']",
    ].join(","));
    for (const node of countNodes) {
      const match = clean(node.textContent).match(/(?:based\s+on\s+)?([\d,]+)\s+(?:customer\s+)?reviews?/i);
      const count = positiveInteger(match?.[1]);
      if (count) counts.push(count);
    }

    return counts.length > 0 ? Math.max(...counts) : null;
  }

  function findStampedRoot() {
    const review = document.querySelector(".stamped-review");
    return review?.closest(
      "#stamped-main-widget, .stamped-main-widget, .stamped-container, [data-widget-type*='review' i]"
    ) || document.querySelector(
      "#stamped-main-widget, .stamped-main-widget, .stamped-container"
    );
  }

  async function expandOkendoReviews() {
    const reviews = [];
    const errors = [];
    const startedAt = Date.now();
    const expectedCount = extractOkendoExpectedCount();
    const initialCount = getOkendoReviewCount();
    let attempts = 0;
    let pagesLoaded = 0;
    let stoppedReason = "";

    while (reviews.length < OKENDO_REVIEW_LIMIT) {
      reviews.push(...extractOkendoReviews());
      const uniqueReviews = dedupeReviews(reviews);
      reviews.length = 0;
      reviews.push(...uniqueReviews);

      if (reviews.length >= OKENDO_REVIEW_LIMIT) {
        stoppedReason = "configured_limit_reached";
        break;
      }
      if (Date.now() - startedAt >= OKENDO_LOAD_TIMEOUT_MS) {
        stoppedReason = "timeout";
        break;
      }

      const button = findOkendoShowMoreButton();
      if (!button) {
        stoppedReason = expectedCount && reviews.length >= expectedCount
          ? "expected_count_reached"
          : "button_missing";
        break;
      }

      const beforeFingerprint = getOkendoPageFingerprint();
      const beforePayloadKey = getOkendoPayloadKey();
      attempts += 1;
      button.scrollIntoView({ block: "center" });
      clickOkendoAction(button);

      const progressed = await waitForOkendoProgress(
        beforeFingerprint,
        beforePayloadKey,
        5_000
      );
      if (!progressed) {
        errors.push(`Show More attempt ${attempts} did not add or replace Okendo reviews.`);
        stoppedReason = "no_progress";
        break;
      }

      pagesLoaded += 1;
    }

    if (!stoppedReason) stoppedReason = "completed";

    return {
      reviews: dedupeReviews(reviews).slice(0, OKENDO_REVIEW_LIMIT),
      diagnostics: {
        provider: "okendo",
        method: "provider_load_more",
        expectedCount,
        configuredLimit: OKENDO_REVIEW_LIMIT,
        initialCount,
        finalDomCount: getOkendoReviewCount(),
        extractedCount: Math.min(reviews.length, OKENDO_REVIEW_LIMIT),
        attempts,
        pagesLoaded,
        complete: Boolean(expectedCount && reviews.length >= expectedCount),
        stoppedReason,
        elapsedMs: Date.now() - startedAt,
        errors,
      },
    };
  }

  function extractOkendoReviews() {
    return Array.from(document.querySelectorAll(
      ".oke-w-reviews-list-item, .okeReviews-review"
    ))
      .map((node) => extractReviewFromContainer(node))
      .filter(Boolean);
  }

  function getOkendoReviewCount() {
    return document.querySelectorAll(
      ".oke-w-reviews-list-item, .okeReviews-review"
    ).length;
  }

  function getOkendoPageFingerprint() {
    return extractOkendoReviews()
      .map((review) => reviewContentKey(review))
      .join("##")
      .slice(0, 20_000);
  }

  function findOkendoShowMoreButton() {
    const candidates = Array.from(document.querySelectorAll([
      ".oke-showMore-button",
      ".oke-show-more",
      ".okeReviews-showMore",
      ".oke-w-reviews-show-more",
      "[class*='oke'][class*='show'][class*='more' i]",
      "[data-oke-button='show-more']",
      "button",
      "a",
      "[role='button']",
    ].join(",")));

    return candidates.find((node) => {
      if (!isUsableAction(node)) return false;
      if (node.hidden) return false;
      const text = [
        node.textContent,
        node.getAttribute("aria-label"),
        node.getAttribute("title"),
        node.dataset?.okeButton,
        node.className,
      ].map(clean).join(" ");
      if (/read more|write a review|sort|filter/i.test(text)) return false;
      return /show\s*more|load\s*more|more\s*reviews|view\s*more/i.test(text)
        || node.matches(".oke-showMore-button, .oke-show-more, .okeReviews-showMore, .oke-w-reviews-show-more, [data-oke-button='show-more']");
    }) || null;
  }

  function clickOkendoAction(node) {
    if (node.matches("a")) {
      node.addEventListener("click", (event) => event.preventDefault(), {
        capture: true,
        once: true,
      });
    }
    node.click();
  }

  function getOkendoPayloadKey() {
    return state.networkPayloads
      .filter((item) => /okendo/i.test(item.url))
      .map((item) => `${item.url}|${stableBodyKey(item.body)}`)
      .join("##")
      .slice(-20_000);
  }

  async function waitForOkendoProgress(beforeFingerprint, beforePayloadKey, timeoutMs) {
    const start = Date.now();
    while (Date.now() - start < timeoutMs) {
      await sleep(250);
      const fingerprint = getOkendoPageFingerprint();
      const payloadKey = getOkendoPayloadKey();
      if (
        (fingerprint && fingerprint !== beforeFingerprint)
        || (payloadKey && payloadKey !== beforePayloadKey)
      ) {
        return true;
      }
    }
    return false;
  }

  function extractOkendoExpectedCount() {
    const counts = [];
    const root = document.querySelector(
      ".okeReviews, .oke-w-reviews, [data-oke-container], [data-oke-widget]"
    ) || document;
    const attributes = [
      "data-review-count",
      "data-reviews-count",
      "data-total-reviews",
      "data-total",
    ];
    const selector = attributes.map((name) => `[${name}]`).join(",");
    const nodes = Array.from(root.querySelectorAll(selector));
    if (root.matches(selector)) nodes.unshift(root);

    for (const node of nodes) {
      for (const name of attributes) {
        const count = positiveInteger(node.getAttribute(name));
        if (count) counts.push(count);
      }
    }

    const textNodes = root.querySelectorAll([
      ".okeReviews-reviewsAggregate",
      ".oke-w-reviews-count",
      "[class*='oke'][class*='review'][class*='count' i]",
    ].join(","));
    for (const node of textNodes) {
      const match = clean(node.textContent).match(/([\d,]+)\s+(?:customer\s+)?reviews?/i);
      const count = positiveInteger(match?.[1]);
      if (count) counts.push(count);
    }

    return counts.length > 0 ? Math.max(...counts) : null;
  }

  async function expandGenericReviewWidgets() {
    let idleRounds = 0;

    for (let i = 0; i < 18; i += 1) {
      const beforeCount = getReviewNodeCount();
      const action = findReviewActionElement();

      if (action) {
        action.scrollIntoView({ block: "center" });
        action.click();
        await waitForReviewGrowth(beforeCount, 3500);
      } else {
        window.scrollTo({ top: document.body.scrollHeight });
        await sleep(900);
      }

      const afterCount = getReviewNodeCount();
      if (afterCount > beforeCount) {
        idleRounds = 0;
        continue;
      }

      idleRounds += 1;
      if (idleRounds >= 3) break;
    }

    for (let i = 0; i < 2; i += 1) {
      window.scrollTo({ top: document.body.scrollHeight });
      await sleep(700);
    }

    return {
      reviews: [],
      diagnostics: {
        provider: "generic",
        method: "generic_load_more",
        initialCount: null,
        finalDomCount: getReviewNodeCount(),
        attempts: null,
        pagesLoaded: null,
        complete: null,
        stoppedReason: "generic_flow_finished",
        errors: [],
      },
    };
  }

  function findReviewActionElement() {
    const candidates = Array.from(
      document.querySelectorAll(
        [
          ".oke-showMore-button",
          ".oke-show-more",
          ".oke-pagination__button",
          ".junip-see-more",
          "button",
          "a",
          "[role='button']",
        ].join(",")
      )
    );

    return candidates.find((node) => {
      const text = `${node.textContent || ""} ${node.getAttribute("aria-label") || ""} ${node.getAttribute("title") || ""}`.trim();
      if (!text) return false;
      if (/read more/i.test(text)) return false;
      if (/show more|load more|see more reviews|more reviews|view more|next/i.test(text)) return true;
      if (node.matches(".oke-showMore-button, .oke-show-more, .junip-see-more")) return true;
      return false;
    });
  }

  function getReviewNodeCount() {
    return document.querySelectorAll(reviewSelectors().join(",")).length;
  }

  async function waitForReviewGrowth(beforeCount, timeoutMs) {
    const start = Date.now();
    while (Date.now() - start < timeoutMs) {
      await sleep(350);
      if (getReviewNodeCount() > beforeCount) return true;
    }
    return false;
  }

  function extractVisibleReviews(root) {
    const containers = Array.from(root.querySelectorAll(reviewSelectors().join(",")));
    const results = [];

    for (const container of containers) {
      const review = extractReviewFromContainer(container);
      if (review) results.push(review);
    }

    return results;
  }

  function extractFrameReviews() {
    const reviews = [];
    const frames = Array.from(document.querySelectorAll("iframe"));

    for (const iframe of frames) {
      try {
        const doc = iframe.contentDocument;
        if (!doc) continue;
        reviews.push(...extractVisibleReviews(doc));
        reviews.push(...extractJsonLdReviews(doc.documentElement.outerHTML));
      } catch (_) {}
    }

    return reviews;
  }

  function extractReviewFromContainer(container) {
    const text = clean(container.innerText || container.textContent);
    if (text.length < 20 || text.length > 5000) return null;

    const isLooxReview = container.matches(".loox-review, .grid-item.clearfix");
    const title = isLooxReview ? "" : pickText(container, [
      ".jdgm-rev__title",
      ".loox-review__title",
      ".yotpo-review-title",
      ".stamped-review-title",
      ".okeReviews-review-title",
      ".oke-reviewContent-title",
      "[itemprop='name']",
      "[class*='title' i]",
    ]);
    const author = pickText(container, [
      ".block.title",
      ".jdgm-rev__author",
      ".loox-review__author",
      ".yotpo-user-name",
      ".stamped-review-header-title",
      ".okeReviews-review-reviewer-name",
      ".oke-w-reviewer-name",
      "[itemprop='author']",
      "[class*='author' i]",
      "[class*='name' i]",
    ]);
    const body = pickText(container, [
      ".pre-wrap.main-text",
      "[data-testid*='-text']",
      ".jdgm-rev__body",
      ".loox-review__content",
      ".content-review",
      ".yotpo-review-content",
      ".stamped-review-content-body",
      ".okeReviews-review-primary",
      ".oke-reviewContent-body",
      "[itemprop='reviewBody']",
      "[class*='body' i]",
      "[class*='content' i]",
    ]) || text;
    const date = pickText(container, [
      ".jdgm-rev__timestamp",
      ".loox-review__date",
      ".yotpo-review-date",
      ".stamped-review-date",
      ".okeReviews-review-date",
      ".oke-w-reviewMinimal-date",
      "time",
      "[itemprop='datePublished']",
      "[class*='date' i]",
    ]);
    const rating = readRating(container);

    if (!isLikelyReview({ container, title, body, author, date, rating, text, isLooxReview })) return null;

    return normalizeReview({
      source: container.matches(".oke-w-reviews-list-item")
        ? "okendo-dom"
        : isLooxReview
          ? "loox-dom"
          : container.matches(".yotpo-review")
            ? "yotpo-dom"
            : container.matches(".stamped-review")
              ? "stamped-dom"
            : "visible-dom",
      title,
      body,
      author,
      date,
      rating,
    });
  }

  function isLikelyReview({ container, title, body, author, date, rating, text, isLooxReview }) {
    const hasSchema = Boolean(container.matches("[itemprop='review']") || container.querySelector("[itemprop='reviewBody']"));
    const hasKnownReviewClass = Boolean(
      container.matches(".jdgm-rev, .loox-review, .grid-item.clearfix, .yotpo-review, .stamped-review, .okeReviews-review, .oke-w-reviews-list-item, .okeReviews-review")
    );
    const hasProviderReviewId = Boolean(container.getAttribute("data-review-id"));
    const hasReviewBody = Boolean(body && body !== text);
    const hasReviewSignals = [author, date, rating, title].filter(Boolean).length;
    const isControlText = /Search Reviews|Write a Review|Most Recent|Highest Rating|Lowest Rating|Click to scroll to reviews/i.test(text);
    const hasLooxSignals = Boolean(isLooxReview && (body || author || rating));

    if (isControlText) return false;
    if (!hasSchema && !hasKnownReviewClass && !hasProviderReviewId) return false;
    if (isLooxReview && !hasLooxSignals) return false;
    if (!isLooxReview && !hasReviewBody && hasReviewSignals < 2) return false;
    if (clean(body).length < 12) return false;
    return true;
  }

  function reviewSelectors() {
    return [
      ".jdgm-rev",
      ".loox-review",
      ".grid-item.clearfix",
      ".yotpo-review",
      ".stamped-review",
      ".okeReviews-review",
      ".oke-w-reviews-list-item",
      ".okeReviews-review",
      "[itemprop='review']",
      "[data-review-id]",
    ];
  }

  function countVisibleSignals() {
    return {
      okendo: document.querySelectorAll(".oke-w-reviews-list-item, .okeReviews-review").length,
      junip: document.querySelectorAll(".junip-review-list-item-container, .junip-review, .junip-product-review").length,
      judgeMe: document.querySelectorAll(".jdgm-rev, .jdgm-full-rev").length,
      loox: document.querySelectorAll(".loox-review, .grid-item.clearfix, #loox-inline-reviews .review").length,
      yotpo: document.querySelectorAll(".yotpo-review").length,
      stamped: document.querySelectorAll(".stamped-review").length,
      stampedBadge: document.querySelectorAll(".stamped-product-reviews-badge").length,
      schemaReviews: document.querySelectorAll("[itemprop='review']").length,
      reviewDataIds: document.querySelectorAll("[data-review-id]").length,
    };
  }

  function inferProviders(networkPayloads, visibleCounts) {
    const providers = new Set();
    for (const payload of networkPayloads) {
      const url = String(payload.url || "");
      if (/okendo/i.test(url)) providers.add("okendo");
      if (/juniphq|junip/i.test(url)) providers.add("junip");
      if (/judgeme|judge\.me|cdn\.judge\.me/i.test(url)) providers.add("judge.me");
      if (/loox/i.test(url)) providers.add("loox");
      if (/yotpo/i.test(url)) providers.add("yotpo");
      if (/stamped/i.test(url)) providers.add("stamped");
      if (/bazaarvoice/i.test(url)) providers.add("bazaarvoice");
      if (/powerreviews/i.test(url)) providers.add("powerreviews");
    }

    for (const [name, count] of Object.entries(visibleCounts)) {
      if (count > 0 && ["okendo", "junip", "judgeMe", "loox", "yotpo", "stamped"].includes(name)) {
        providers.add(name === "judgeMe" ? "judge.me" : name);
      }
    }

    return Array.from(providers).sort();
  }

  function diagnoseScrape(iframeCount, visibleCounts, networkPayloads, reviewCount) {
    const hasVisibleMatches = [
      visibleCounts.okendo,
      visibleCounts.junip,
      visibleCounts.judgeMe,
      visibleCounts.loox,
      visibleCounts.yotpo,
      visibleCounts.stamped,
      visibleCounts.schemaReviews,
      visibleCounts.reviewDataIds,
    ].some((count) => count > 0);
    const hasReviewNetwork = networkPayloads.length > 0;
    const hasKnownProviderNetwork = networkPayloads.some((payload) =>
      /okendo|juniphq|judgeme|judge\.me|loox|yotpo|stamped|bazaarvoice|powerreviews/i.test(payload.url)
    );

    if (reviewCount > 0 || hasVisibleMatches) {
      return "Review markup is present in the DOM.";
    }

    if (hasKnownProviderNetwork) {
      if (visibleCounts.stampedBadge > 0 && visibleCounts.stamped === 0) {
        return "Stamped badge detected, but no review list was rendered.";
      }
      return "Review API/network payloads were detected, but the DOM parser did not match them.";
    }

    if (iframeCount > 0) {
      return "Review content may be rendered inside an iframe.";
    }

    if (hasReviewNetwork) {
      return "Some review-like requests were detected, but none matched a supported provider.";
    }

    return "No clear review source was detected on this page.";
  }

  function extractJsonLdReviews(html) {
    const reviews = [];
    const scripts = Array.from(html.matchAll(/<script[^>]+type=["']application\/ld\+json["'][^>]*>([\s\S]*?)<\/script>/gi));

    for (const match of scripts) {
      const raw = match[1]?.trim();
      if (!raw) continue;

      let data;
      try {
        data = JSON.parse(raw);
      } catch {
        continue;
      }

      visitJsonLd(data, reviews);
    }

    return reviews;
  }

  function visitJsonLd(value, reviews) {
    if (!value) return;
    if (Array.isArray(value)) {
      for (const item of value) visitJsonLd(item, reviews);
      return;
    }
    if (typeof value !== "object") return;

    const types = normalizeTypes(value["@type"]);
    if (types.includes("Review")) {
      reviews.push(
        normalizeReview({
          source: "json-ld",
          title: pick(value, ["name", "headline", "review.name"]),
          body: stripHtml(pick(value, ["reviewBody", "review.body", "description", "body"])),
          author: pick(value, ["author.name", "author", "reviewer.name", "reviewer"]),
          date: pick(value, ["datePublished", "publishedAt", "review.datePublished"]),
          rating: pick(value, ["reviewRating.ratingValue", "ratingValue", "rating", "score"]),
        })
      );
    }

    for (const child of Object.values(value)) {
      visitJsonLd(child, reviews);
    }
  }

  function extractProviderReviews(networkPayloads) {
    const reviews = [];

    for (const payload of networkPayloads) {
      const source = detectSource(payload.url);
      const structuredCandidates = extractStructuredCandidates(payload.body, source);
      const candidates = structuredCandidates.length > 0 ? structuredCandidates : findReviewLikeObjects(payload.body, 0, [], source);

      for (const candidate of candidates) {
        const review = objectToReview(candidate, source);
        if (review) reviews.push(review);
      }
    }

    return reviews;
  }

  function extractStructuredCandidates(value, source) {
    const paths = getCollectionPaths(source);
    const candidates = [];

    for (const path of paths) {
      const collection = getPath(value, path);
      if (Array.isArray(collection)) {
        for (const item of collection) {
          if (item && typeof item === "object") candidates.push(item);
        }
        continue;
      }

      if (collection && typeof collection === "object") candidates.push(collection);
    }

    return candidates;
  }

  function detectSource(url) {
    if (/judgeme|judge\.me|cdn\.judge\.me/i.test(url)) return "judge.me";
    if (/loox/i.test(url)) return "loox";
    if (/yotpo/i.test(url)) return "yotpo";
    if (/stamped/i.test(url)) return "stamped";
    if (/okendo|okeReviews/i.test(url)) return "okendo";
    if (/juniphq/i.test(url)) return "junip";
    if (/bazaarvoice/i.test(url)) return "bazaarvoice";
    if (/powerreviews/i.test(url)) return "powerreviews";
    return "review-api";
  }

  function findReviewLikeObjects(value, depth = 0, results = [], source = "review-api") {
    if (depth > 8 || value === null || value === undefined) return results;

    if (typeof value === "string") {
      parseEmbeddedJson(value, depth, results, source);
      return results;
    }

    if (Array.isArray(value)) {
      for (const item of value) findReviewLikeObjects(item, depth + 1, results, source);
      return results;
    }

    if (typeof value !== "object") return results;

    if (looksLikeReview(value, source)) results.push(value);

    for (const child of Object.values(value)) {
      findReviewLikeObjects(child, depth + 1, results, source);
    }

    return results;
  }

  function parseEmbeddedJson(value, depth, results, source) {
    const trimmed = value.trim();
    if (!trimmed || trimmed.length > 1_000_000) return;
    if (!trimmed.startsWith("{") && !trimmed.startsWith("[")) return;

    try {
      findReviewLikeObjects(JSON.parse(trimmed), depth + 1, results, source);
    } catch {}
  }

  function looksLikeReview(value, source = "review-api") {
    const keys = Object.keys(value).map((key) => key.toLowerCase());
    const hasBody = keys.some((key) =>
      ["body", "content", "review", "reviewbody", "description", "message", "comment"].includes(key) || ["body_html", "bodyhtml"].includes(key)
    );
    const hasReviewHint = keys.some((key) =>
      /review|rating|score|stars|author|customer|date|title|display_name|reviewer|published|created_at|createdat|review_title|review_message|review_content/i.test(key)
    );

    if (source === "yotpo" || source === "loox" || source === "stamped") {
      const hasProviderBody = keys.some((key) =>
        ["review_content", "reviewcontent", "review_message", "reviewmessage", "review_body", "reviewbody", "content", "message", "text", "summary"].includes(key)
      );

      return (hasBody || hasProviderBody) && (hasReviewHint || hasProviderBody);
    }

    return hasBody && hasReviewHint;
  }

  function objectToReview(value, source) {
    const fieldMap = getFieldMap(source);
    const body = pick(value, fieldMap.body);
    if (!cleanText(body)) return null;

    return normalizeReview({
      source,
      title: pick(value, fieldMap.title),
      body: stripHtml(body),
      author: pick(value, fieldMap.author),
      rating: pick(value, fieldMap.rating),
      date: pick(value, fieldMap.date),
    });
  }

  function getFieldMap(source) {
    const shared = {
      body: ["body", "reviewBody", "review_body", "body_html", "bodyHtml", "content", "review", "description", "message", "comment", "text"],
      title: ["title", "headline", "name", "subject", "review_title", "reviewTitle"],
      author: ["author", "author_name", "display_name", "reviewer_name", "public_reviewer_name", "user_name", "customer_name", "name", "customer", "user.display_name", "user.name", "reviewer.display_name", "reviewer.name"],
      rating: ["rating", "score", "stars", "ratingValue", "review_rating", "reviewScore"],
      date: ["date", "created_at", "createdAt", "datePublished", "published_at", "review_date", "reviewDate", "created_at_ts"],
    };

    if (source === "loox") {
      return {
        body: [...shared.body, "review_content", "reviewContent", "review_body", "reviewBody", "text", "summary"],
        title: [...shared.title, "review_title", "reviewTitle", "summary"],
        author: [...shared.author, "customer.display_name", "customer.name"],
        rating: [...shared.rating],
        date: [...shared.date, "created", "submitted_at"],
      };
    }

    if (source === "yotpo") {
      return {
        body: [...shared.body, "content", "review_content", "reviewContent", "description", "text"],
        title: [...shared.title, "title", "headline"],
        author: [...shared.author, "user.display_name", "user.name", "reviewer.display_name", "reviewer.name", "customer.display_name", "customer.name"],
        rating: [...shared.rating, "score", "stars"],
        date: [...shared.date, "created_at", "created", "submitted_at"],
      };
    }

    if (source === "stamped") {
      return {
        body: [...shared.body, "review_message", "reviewMessage", "review_body", "reviewBody", "message"],
        title: [...shared.title, "review_title", "reviewTitle", "summary"],
        author: [...shared.author, "reviewer_name", "reviewer.display_name", "reviewer.name"],
        rating: [...shared.rating, "rating", "score"],
        date: [...shared.date, "created", "created_at", "submitted_at"],
      };
    }

    return shared;
  }

  function getCollectionPaths(source) {
    if (source === "loox") {
      return ["reviews", "data.reviews", "response.reviews", "items", "results", "payload.reviews"];
    }

    if (source === "yotpo") {
      return ["response.reviews", "reviews", "data.reviews", "data", "products.reviews", "result.reviews"];
    }

    if (source === "stamped") {
      return ["data", "reviews", "response.reviews", "result.reviews", "results", "payload.reviews"];
    }

    return [];
  }

  function getPath(object, path) {
    if (!path.includes(".")) return object?.[path];
    return path.split(".").reduce((current, segment) => current?.[segment], object);
  }

  function pick(object, keys) {
    for (const key of keys) {
      const value = getPath(object, key);
      if (value === null || value === undefined || value === "") continue;
      if (typeof value === "object") {
        if (value.name) return value.name;
        if (value.first_name || value.last_name) return [value.first_name, value.last_name].filter(Boolean).join(" ");
        if (value.value) return value.value;
        if (value.ratingValue) return value.ratingValue;
        continue;
      }
      return value;
    }

    return "";
  }

  function normalizeReview(review) {
    return {
      source: String(review.source || "visible-dom"),
      rating: normalizeRating(review.rating),
      title: cleanText(review.title),
      body: cleanText(review.body),
      author: cleanText(review.author),
      date: cleanText(review.date),
    };
  }

  function normalizeRating(value) {
    const numeric = typeof value === "number" ? value : Number(String(value || "").match(/([0-5](?:\.\d+)?)/)?.[1]);
    if (!Number.isFinite(numeric)) return null;
    return Math.max(0, Math.min(5, numeric));
  }

  function ratingValue(review) {
    return Number.isFinite(review?.rating) ? review.rating : 0;
  }

  function reviewRank(review) {
    if (!Number.isFinite(review?.rating)) return 1;
    const rating = ratingValue(review);
    return rating <= 3 ? 0 : 1;
  }

  function dedupeReviews(reviews) {
    const seen = new Set();
    const looxContent = new Set();
    const deduped = [];

    for (const review of reviews) {
      if (!review?.body) continue;
      const contentKey = reviewContentKey(review);
      const key = `${String(review.source || "").toLowerCase()}||${contentKey}`;
      if (seen.has(key)) continue;
      if (looxContent.has(contentKey)) continue;
      seen.add(key);
      if (/^loox(?:-|$)/i.test(String(review.source || ""))) {
        looxContent.add(contentKey);
      }
      deduped.push(review);
    }

    return deduped;
  }

  function reviewContentKey(review) {
    return [review.rating, review.title, review.body, review.author, review.date].join("||").toLowerCase();
  }

  function stableBodyKey(body) {
    if (body === null || body === undefined) return "";
    if (typeof body === "string") return body.slice(0, 300);
    try {
      return JSON.stringify(body).slice(0, 300);
    } catch {
      return String(body).slice(0, 300);
    }
  }

  function normalizeTypes(value) {
    if (!value) return [];
    return Array.isArray(value) ? value.map(String) : [String(value)];
  }

  function stripHtml(value) {
    return String(value || "").replace(/<[^>]*>/g, " ");
  }

  function clean(value) {
    return String(value || "").replace(/\s+/g, " ").trim();
  }

  function cleanText(value) {
    return clean(stripHtml(value));
  }

  function pickText(root, selectors) {
    for (const selector of selectors) {
      const node = root.querySelector(selector);
      const value = clean(node?.getAttribute("content") || node?.getAttribute("datetime") || node?.textContent);
      if (value) return value;
    }
    return "";
  }

  function readRating(root) {
    const explicit = root.querySelector("[itemprop='ratingValue'], [aria-label*='star' i], [title*='star' i], .oke-reviewContent-stars");
    const raw = explicit?.getAttribute("content") || explicit?.getAttribute("aria-label") || explicit?.getAttribute("title") || explicit?.textContent || "";
    const explicitMatch = String(raw).match(/([0-5](?:\.\d+)?)/);
    if (explicitMatch) return Number(explicitMatch[1]);

    const filledStars = root.querySelectorAll(".jdgm-star.jdgm--on, .loox-icon-star, .yotpo-icon-star, .stamped-fa-star, [class*='star'][class*='full']").length;
    return filledStars > 0 ? Math.min(filledStars, 5) : null;
  }

  function sleep(ms) {
    return new Promise((resolve) => setTimeout(resolve, ms));
  }
})();

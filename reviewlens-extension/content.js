(() => {
  const isTopFrame = window.top === window;

  const REVIEW_URL_PATTERN = /review|reviews|judgeme|judge\.me|loox|yotpo|stamped|okendo|bazaarvoice|powerreviews/i;
  const CAPTURE_LIMIT = 100;
  const state = {
    networkPayloads: [],
    hooksInstalled: false,
  };

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
    if (!data || data.source !== "reviewlens" || data.type !== "network") return;

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

  async function runScrape() {
    await settlePage();

    const debug = {
      url: location.href,
      pageTitle: document.title || "",
      visibleReviewCounts: {},
      iframeCount: 0,
      detectedProviders: [],
      diagnosis: "",
    };

    if (!isLikelyShopifyProductPage()) {
      return {
        ok: false,
        error: "Unsupported URL. Please open a Shopify product page.",
        debug,
      };
    }

    await expandVisibleReviewWidgets();
    await waitForOkendoMetadata(5_000);

    const html = document.documentElement.outerHTML;
    const jsonLdReviews = extractJsonLdReviews(html);
    const visibleReviews = extractVisibleReviews(document);
    const frameReviews = extractFrameReviews();
    const providerReviews = extractProviderReviews(state.networkPayloads);
    const allReviews = dedupeReviews([...jsonLdReviews, ...visibleReviews, ...frameReviews, ...providerReviews]);
    const reviews = allReviews.sort((a, b) => reviewRank(a) - reviewRank(b) || (ratingValue(a) - ratingValue(b)));

    const negative = reviews.filter((review) => ratingValue(review) <= 3);
    const positive = reviews.filter((review) => ratingValue(review) >= 4);

    debug.visibleReviewCounts = countVisibleSignals();
    debug.iframeCount = document.querySelectorAll("iframe").length;
    debug.detectedProviders = inferProviders(state.networkPayloads, debug.visibleReviewCounts);
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

  async function expandVisibleReviewWidgets() {
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
          "[tabindex='0']",
          "div",
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

    const isLooxReview = container.matches(".grid-item.clearfix");
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
      loox: document.querySelectorAll(".loox-review, .grid-item.clearfix").length,
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
    const rating = ratingValue(review);
    return rating <= 3 ? 0 : 1;
  }

  function dedupeReviews(reviews) {
    const seen = new Set();
    const deduped = [];

    for (const review of reviews) {
      if (!review?.body) continue;
      const key = [review.source, review.rating, review.title, review.body, review.author, review.date].join("||").toLowerCase();
      if (seen.has(key)) continue;
      seen.add(key);
      deduped.push(review);
    }

    return deduped;
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

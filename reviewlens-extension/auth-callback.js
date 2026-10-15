const AUTH_KEY = "reviewlens_user_session";
const STORAGE_KEY = "reviewlens_popup_state";
const APP_BASE_URL = "https://www.reviewlens.org";

function message() {
  return document.getElementById("message");
}

function decodeJwtPayload(token) {
  try {
    const payload = token.split(".")[1];
    const normalized = payload.replace(/-/g, "+").replace(/_/g, "/");
    const json = decodeURIComponent(
      atob(normalized)
        .split("")
        .map((char) => `%${char.charCodeAt(0).toString(16).padStart(2, "0")}`)
        .join("")
    );
    return JSON.parse(json);
  } catch {
    return {};
  }
}

async function saveSession() {
  const hash = new URLSearchParams(window.location.hash.replace(/^#/, ""));
  const accessToken = hash.get("access_token");
  const refreshToken = hash.get("refresh_token");
  const expiresIn = Number(hash.get("expires_in") || 3600);
  const code = new URLSearchParams(window.location.search).get("code");

  if (!accessToken) {
    throw new Error(code
      ? "This sign-in link returned a code flow that this extension version cannot complete."
      : "No access token was returned.");
  }

  const payload = decodeJwtPayload(accessToken);
  const session = {
    accessToken,
    refreshToken: refreshToken || null,
    userId: payload.sub || null,
    email: payload.email || null,
    expiresAt: Date.now() + expiresIn * 1000,
  };

  await chrome.storage.local.set({ [AUTH_KEY]: session });
  return session;
}

async function getJson(url, session) {
  const response = await fetch(url, {
    headers: {
      authorization: `Bearer ${session.accessToken}`,
    },
  });
  const data = await response.json().catch(() => ({}));
  return { ok: response.ok, status: response.status, data };
}

async function postJson(url, body, session) {
  const response = await fetch(url, {
    method: "POST",
    headers: {
      "content-type": "application/json",
      authorization: `Bearer ${session.accessToken}`,
    },
    body: JSON.stringify(body || {}),
  });
  const data = await response.json().catch(() => ({}));
  return { ok: response.ok, status: response.status, data };
}

async function saveAnalysisResult(result) {
  const stored = await chrome.storage.local.get(STORAGE_KEY);
  const current = stored?.[STORAGE_KEY] || {};
  await chrome.storage.local.set({
    [STORAGE_KEY]: {
      ...current,
      analysisResult: result,
      activeView: "analysis",
    },
  });
}

async function continueUnlockFlow(session) {
  const params = new URLSearchParams(window.location.search);
  const intent = params.get("intent") || "";
  const shop = params.get("shop") || "";
  const handle = params.get("handle") || "";

  if (intent !== "unlock") return false;
  if (!shop) throw new Error("Missing shop for unlock flow.");

  const access = await getJson(
    `${APP_BASE_URL}/api/analysis?shop=${encodeURIComponent(shop)}`,
    session
  );
  if (!access.ok || !access.data?.ok) {
    throw new Error(access.data?.error || "Unable to check Pro access.");
  }

  if (!access.data.paid) {
    message().textContent = "Signed in. Opening checkout...";
    const checkout = await postJson(
      `${APP_BASE_URL}/api/checkout?plan=pro&shop=${encodeURIComponent(shop)}`,
      {},
      session
    );
    if (!checkout.ok || !checkout.data?.ok || !checkout.data?.checkout_url) {
      throw new Error(checkout.data?.error || "Unable to create checkout.");
    }
    await chrome.tabs.create({ url: checkout.data.checkout_url, active: true });
    setTimeout(() => window.close(), 600);
    return true;
  }

  if (!handle) throw new Error("Missing product handle for AI analysis.");
  message().textContent = "Signed in. Running AI analysis...";
  const analysis = await postJson(
    `${APP_BASE_URL}/api/analysis?shop=${encodeURIComponent(shop)}`,
    { handle },
    session
  );
  if (!analysis.ok || !analysis.data?.ok) {
    throw new Error(analysis.data?.error || "AI analysis failed.");
  }

  await saveAnalysisResult(analysis.data.analysisResult || null);
  message().textContent = "AI analysis completed. Reopen ReviewLens to view the result.";
  setTimeout(() => window.close(), 1600);
  return true;
}

saveSession()
  .then(async (session) => {
    const continued = await continueUnlockFlow(session);
    if (continued) return;
    message().textContent = "Signed in. You can close this tab and reopen ReviewLens.";
    setTimeout(() => window.close(), 900);
  })
  .catch((error) => {
    message().textContent = error instanceof Error ? error.message : String(error);
  });

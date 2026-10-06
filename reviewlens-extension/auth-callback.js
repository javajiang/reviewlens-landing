const AUTH_KEY = "reviewlens_user_session";

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
  await chrome.storage.local.set({
    [AUTH_KEY]: {
      accessToken,
      refreshToken: refreshToken || null,
      userId: payload.sub || null,
      email: payload.email || null,
      expiresAt: Date.now() + expiresIn * 1000,
    },
  });
}

saveSession()
  .then(() => {
    document.getElementById("message").textContent = "Signed in. You can close this tab and reopen ReviewLens.";
    setTimeout(() => window.close(), 900);
  })
  .catch((error) => {
    document.getElementById("message").textContent = error instanceof Error ? error.message : String(error);
  });

export async function getAuthToken(interactive = true) {
  return new Promise((resolve) => {
    chrome.identity.getAuthToken({ interactive }, (token) => {
      const err = chrome.runtime.lastError;
      if (err) {
        resolve({ ok: false, error: err.message });
        return;
      }
      if (!token) {
        resolve({ ok: false, error: "No token returned." });
        return;
      }
      resolve({ ok: true, token });
    });
  });
}

/**
 * Forces Google's consent screen by using getAuthToken after fullSignOut()
 * has already cleared Chrome's grant cache.  getAuthToken's redirect is
 * handled internally by Chrome and never needs a redirect URI registered in
 * Google Cloud Console — avoiding the redirect_uri_mismatch that
 * launchWebAuthFlow requires.
 */
export async function getAuthTokenWithForcedConsent() {
  return getAuthToken(true);
}

/**
 * Fully signs out by draining every token Chrome has cached for this app,
 * revoking each one on Google's servers so the next interactive sign-in
 * shows the full consent screen with ALL scopes (including photoslibrary.readonly).
 */
export async function fullSignOut() {
  // Chrome can hold multiple tokens. Keep pulling and revoking until none remain.
  for (let i = 0; i < 10; i++) {
    const token = await new Promise((resolve) => {
      chrome.identity.getAuthToken({ interactive: false }, (t) => {
        resolve(chrome.runtime.lastError || !t ? null : t);
      });
    });

    if (!token) break; // no more tokens cached

    // Revoke on Google's servers.
    // Use accounts.google.com (GET) — oauth2.googleapis.com is NOT in
    // host_permissions so POSTing there is silently blocked, leaving
    // Chrome's refresh token alive and the consent screen never shown.
    try {
      await fetch(
        `https://accounts.google.com/o/oauth2/revoke?token=${encodeURIComponent(token)}`
      );
    } catch (_) { /* ignore network errors */ }

    // Remove from Chrome's in-memory and persistent cache
    await new Promise((resolve) => chrome.identity.removeCachedAuthToken({ token }, resolve));
  }
}

export async function clearCachedToken(token) {
  return new Promise((resolve) => {
    chrome.identity.removeCachedAuthToken({ token }, () => {
      resolve();
    });
  });
}

export async function revokeToken(token) {
  // Remove from Chrome's cache first
  await clearCachedToken(token);
  // Also revoke on Google's servers so the next sign-in shows the full consent screen
  try {
    await fetch(`https://accounts.google.com/o/oauth2/revoke?token=${token}`);
  } catch (_) { /* ignore network errors */ }
}

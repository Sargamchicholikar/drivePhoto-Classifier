// Runs in MAIN world — can intercept window.fetch used by Google Photos SPA.
// Communicates to gp-relay.js (ISOLATED world) via window.postMessage.
(function () {
  'use strict';

  function relay(type, data) {
    window.postMessage({ __gpScraper: true, type, ...data }, '*');
  }

  // ── Intercept fetch to capture batchexecute API responses ──────────────────
  const origFetch = window.fetch.bind(window);
  window.fetch = async function (input, init) {
    const response = await origFetch(input, init);
    const url = typeof input === 'string' ? input
      : (input instanceof Request ? input.url : String(input));

    if (url.includes('batchexecute') && url.includes('PhotosUi')) {
      try {
        const clone = response.clone();
        clone.text().then(text => parseResponse(text)).catch(() => {});
      } catch (_) {}
    }
    return response;
  };

  // ── Extract image filenames from the raw batchexecute response body ─────────
  // Google Photos embeds filenames as plain strings inside deeply nested JSON.
  // Any string ending in a known image/video extension is a candidate filename.
  const EXT = /\.(jpg|jpeg|png|heic|heif|gif|webp|bmp|tiff|tif|mp4|mov|avi|mkv|3gp)$/i;

  function parseResponse(text) {
    const personId = getCurrentPersonId();
    if (!personId) return;

    const seen = new Set();
    const filenames = [];

    // Match quoted strings that end with an image/video extension.
    // The inner group captures the filename without the surrounding quotes.
    const re = /"([^"\\]{1,200}\.(?:jpg|jpeg|png|heic|heif|gif|webp|bmp|tiff|tif|mp4|mov|avi|mkv|3gp))"/gi;
    let m;
    while ((m = re.exec(text)) !== null) {
      const name = m[1].trim();
      // Reject obvious non-filenames (paths, URLs, class names)
      if (name.includes('/') || name.includes('\\') || seen.has(name)) continue;
      seen.add(name);
      filenames.push(name);
    }

    if (filenames.length > 0) {
      relay('FILENAMES', { personId, filenames, pageUrl: location.href });
    }
  }

  function getCurrentPersonId() {
    // /people/{clusterId}
    const m1 = location.pathname.match(/\/people\/([^/?#]+)/);
    if (m1) return m1[1];
    // /search/{encoded-person-query}  (when you click a person from search results)
    const m2 = location.pathname.match(/\/search\/([^/?#]+)/);
    if (m2) return 'search_' + m2[1].slice(0, 40);
    // /u/0/people/{clusterId} (some accounts use this path)
    const m3 = location.pathname.match(/\/u\/\d+\/people\/([^/?#]+)/);
    if (m3) return m3[1];
    return null;
  }

  // ── Watch for SPA navigation ───────────────────────────────────────────────
  let lastPath = location.pathname;
  new MutationObserver(() => {
    if (location.pathname === lastPath) return;
    lastPath = location.pathname;
    const personId = getCurrentPersonId();
    relay('NAV', { personId, pageUrl: location.href });
  }).observe(document.documentElement, { childList: true, subtree: true });

  relay('READY', {});
})();

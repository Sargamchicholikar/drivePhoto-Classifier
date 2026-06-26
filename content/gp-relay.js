// Runs in ISOLATED world — bridges MAIN world (gp-scraper.js) ↔ chrome.runtime.
(function () {
  'use strict';

  // ── Receive messages from MAIN world ────────────────────────────────────────
  window.addEventListener('message', (event) => {
    if (event.source !== window || !event.data?.__gpScraper) return;
    const { type, ...data } = event.data;

    if (type === 'FILENAMES') {
      chrome.runtime.sendMessage({
        type: 'GPHOTO_FILENAMES',
        personId: data.personId,
        filenames: data.filenames,
        pageUrl: data.pageUrl,
      }).catch(() => {});
    }

    if (type === 'NAV' || type === 'READY') {
      setTimeout(() => {
        const personId = data.personId;
        // Send person name/context regardless of URL pattern
        if (personId) {
          const name = readPersonName();
          chrome.runtime.sendMessage({
            type: 'GPHOTO_PAGE_CHANGE',
            personId,
            name,
            pageUrl: data.pageUrl || location.href,
          }).catch(() => {});
        }
        readAndSendPeopleList();
      }, type === 'READY' ? 2000 : 1500);
    }
  });

  // ── Read person name from the page header ──────────────────────────────────
  function readPersonName() {
    // Google Photos shows the person name in an h1 or a prominent heading
    const candidates = [
      document.querySelector('h1'),
      document.querySelector('[data-latest-bg] + * h1'),
      document.querySelector('[aria-label][role="heading"]'),
    ];
    for (const el of candidates) {
      const t = el?.textContent?.trim();
      if (t && t.length < 80) return t;
    }
    return null;
  }

  // ── Read the people list from the /people index page ──────────────────────
  function readAndSendPeopleList() {
    if (!location.pathname.startsWith('/people')) return;

    const links = Array.from(document.querySelectorAll('a[href*="/people/"]'));
    const seen = new Set();
    const people = [];

    for (const link of links) {
      const m = (link.href || '').match(/\/people\/([^/?#]+)/);
      if (!m || seen.has(m[1])) continue;
      seen.add(m[1]);

      const img = link.querySelector('img');
      // Person name may be in aria-label on the link, or in a text child
      const name = link.getAttribute('aria-label')
        || link.querySelector('[aria-label]')?.getAttribute('aria-label')
        || link.querySelector('span:last-child')?.textContent?.trim()
        || null;

      people.push({
        id: m[1],
        name: name && name.length < 80 ? name : null,
        thumbnailUrl: img?.src || null,
      });
    }

    if (people.length > 0) {
      chrome.runtime.sendMessage({ type: 'GPHOTO_PEOPLE_LIST', people }).catch(() => {});
    }
  }

  // Re-read when DOM settles (people grid loads asynchronously)
  let timer = null;
  new MutationObserver(() => {
    if (!location.pathname.startsWith('/people')) return;
    clearTimeout(timer);
    timer = setTimeout(readAndSendPeopleList, 1200);
  }).observe(document.body || document.documentElement, { childList: true, subtree: false });

})();

const DRIVE_FILES_ENDPOINT  = "https://www.googleapis.com/drive/v3/files";

// Fetch with one automatic token-refresh retry on 401.
// On a 401 it asks Chrome's identity system for a fresh token
// (chrome.identity handles the OAuth refresh-token exchange internally),
// then retries the request exactly once.
async function driveFetch(token, url, init = {}) {
  const makeReq = (t) => fetch(url, {
    ...init,
    headers: { Authorization: `Bearer ${t}`, ...(init.headers || {}) },
  });

  let res = await makeReq(token);

  if (res.status === 401) {
    // Remove the stale token so Chrome will issue a new one.
    await new Promise((r) => chrome.identity.removeCachedAuthToken({ token }, r));

    // Use interactive: true so Chrome is forced to exchange the refresh token
    // for a new access token rather than potentially serving a stale cached one.
    // When the user is already signed in this never shows any UI — interactive
    // only triggers a consent screen when no grant exists at all.
    const fresh = await new Promise((r) =>
      chrome.identity.getAuthToken({ interactive: true }, (t) =>
        r(chrome.runtime.lastError ? null : t)
      )
    );

    if (!fresh) {
      throw new Error(
        "Your session has expired. Please sign out and sign back in, then try again."
      );
    }

    // Keep background.js's cachedToken in sync.
    chrome.runtime.sendMessage({ type: "_INTERNAL_TOKEN_REFRESHED", token: fresh })
      .catch(() => {});

    res = await makeReq(fresh);

    // If the retry is ALSO rejected, surface a clear message rather than a
    // raw JSON blob — means the grant itself was revoked.
    if (res.status === 401) {
      const text = await res.text().catch(() => "");
      throw new Error(
        "Google authentication failed after token refresh. " +
        "Please sign out of the extension and sign back in. " +
        `(Details: ${text.slice(0, 200)})`
      );
    }
  }

  if (!res.ok) {
    const text = await res.text();
    throw new Error(`Drive API ${res.status}: ${text}`);
  }
  return res;
}

export async function listImageFiles(token) {
  const allFiles = [];
  let pageToken = "";

  do {
    const page = await listImageFilesPage(token, {
      pageToken,
      pageSize: 1000
    });
    allFiles.push(...page.files);
    pageToken = page.nextPageToken;
  } while (pageToken);

  return allFiles;
}

export async function listImageFilesPage(
  token,
  { pageToken = "", pageSize = 1000, includeVideos = false, excludeParentIds = [] } = {}
) {
  const mediaQuery = includeVideos
    ? "(mimeType contains 'image/' or mimeType contains 'video/')"
    : "mimeType contains 'image/'";

  const conditions = [mediaQuery, "trashed = false"];

  // Exclude files whose direct parent is any of the given folder IDs.
  // Used to skip Smart Photo Organizer sub-folders during a normal sort,
  // so already-sorted photos are never re-classified by accident.
  for (const fid of excludeParentIds) {
    if (fid) conditions.push(`not '${fid}' in parents`);
  }

  const query = conditions.join(" and ");

  const params = new URLSearchParams({
    q: query,
    fields: "nextPageToken,files(id,name,mimeType,modifiedTime,parents,size)",
    pageSize: String(pageSize),
    orderBy: "modifiedTime desc",
    includeItemsFromAllDrives: "true",
    supportsAllDrives: "true"
  });

  if (pageToken) {
    params.set("pageToken", pageToken);
  }

  const url = `${DRIVE_FILES_ENDPOINT}?${params.toString()}`;
  const res = await driveFetch(token, url);
  const data = await res.json();
  return {
    files: data.files || [],
    nextPageToken: data.nextPageToken || ""
  };
}

/**
 * Like listImageFilesPage but restricted to one Drive folder and all its
 * sub-folders (uses the `ancestors` operator so Takeout year-subfolders are
 * included automatically without extra API calls).
 */
export async function listImageFilesInFolderPage(
  token,
  folderId,
  { pageToken = "", pageSize = 1000, includeVideos = false } = {}
) {
  const mediaQuery = includeVideos
    ? "(mimeType contains 'image/' or mimeType contains 'video/')"
    : "mimeType contains 'image/'";
  const query = [
    mediaQuery,
    `'${folderId}' in parents`,
    "trashed = false",
  ].join(" and ");

  const params = new URLSearchParams({
    q: query,
    fields: "nextPageToken,files(id,name,mimeType,modifiedTime,parents,size,thumbnailLink)",
    pageSize: String(pageSize),
    orderBy: "modifiedTime desc",
    includeItemsFromAllDrives: "true",
    supportsAllDrives: "true"
  });

  if (pageToken) {
    params.set("pageToken", pageToken);
  }

  const url = `${DRIVE_FILES_ENDPOINT}?${params.toString()}`;
  const res = await driveFetch(token, url);
  const data = await res.json();
  return {
    files: data.files || [],
    nextPageToken: data.nextPageToken || ""
  };
}

export async function findFolderByName(token, name, parentId = null) {
  return findFolder(token, name, parentId);
}

export async function moveToTrash(token, fileId) {
  const url = `${DRIVE_FILES_ENDPOINT}/${fileId}?supportsAllDrives=true`;
  await driveFetch(token, url, {
    method:  "PATCH",
    headers: { "Content-Type": "application/json" },
    body:    JSON.stringify({ trashed: true }),
  });
}

async function findFolder(token, name, parentId = null) {
  const conditions = [
    "mimeType = 'application/vnd.google-apps.folder'",
    "trashed = false",
    `name = '${name.replace(/'/g, "\\'")}'`
  ];
  if (parentId) {
    conditions.push(`'${parentId}' in parents`);
  } else {
    conditions.push("'root' in parents");
  }

  const params = new URLSearchParams({
    q: conditions.join(" and "),
    fields: "files(id,name)",
    pageSize: "1"
  });
  const url = `${DRIVE_FILES_ENDPOINT}?${params.toString()}`;
  const res = await driveFetch(token, url);
  const data = await res.json();
  return data.files?.[0] || null;
}

async function createFolder(token, name, parentId = null) {
  const payload = {
    name,
    mimeType: "application/vnd.google-apps.folder",
    parents: [parentId || "root"]
  };
  const res = await driveFetch(token, DRIVE_FILES_ENDPOINT, {
    method: "POST",
    headers: {
      "Content-Type": "application/json"
    },
    body: JSON.stringify(payload)
  });
  return res.json();
}

export async function listSubfolders(token, parentId) {
  const params = new URLSearchParams({
    q: `mimeType = 'application/vnd.google-apps.folder' and '${parentId}' in parents and trashed = false`,
    fields: "files(id,name)",
    pageSize: "200",
    supportsAllDrives: "true",
    includeItemsFromAllDrives: "true",
  });
  const res  = await driveFetch(token, `${DRIVE_FILES_ENDPOINT}?${params}`);
  const data = await res.json();
  return data.files || [];
}

export async function getOrCreateFolder(token, name, parentId = null) {
  const existing = await findFolder(token, name, parentId);
  if (existing) return existing;
  return createFolder(token, name, parentId);
}

async function getFileParents(token, fileId) {
  const url = `${DRIVE_FILES_ENDPOINT}/${fileId}?fields=parents`;
  const res = await driveFetch(token, url);
  const data = await res.json();
  return data.parents || [];
}

export async function moveFileToFolder(token, fileId, targetFolderId) {
  const parents = await getFileParents(token, fileId);
  if (parents.includes(targetFolderId)) {
    return { skipped: true, reason: "already_in_target" };
  }
  const removeParents = parents.join(",");
  const params = new URLSearchParams({
    addParents: targetFolderId,
    fields: "id,parents"
  });
  if (removeParents) {
    params.set("removeParents", removeParents);
  }

  const url = `${DRIVE_FILES_ENDPOINT}/${fileId}?${params.toString()}`;
  await driveFetch(token, url, { method: "PATCH" });
  return { skipped: false };
}

# Drive Photo Classifier (Offline Chrome Extension)

This project is an MV3 Chrome extension that will classify and organize Google Drive photos fully offline inside the browser.

Current status: **Phase 2 scaffold complete**
- OAuth sign-in (`chrome.identity`)
- Drive API photo listing
- Offline MobileNet classification in offscreen runtime
- Popup UI to list and classify photos

## Setup

1. Open Google Cloud Console and create an OAuth client of type **Chrome Extension**.
2. Add your extension ID in OAuth client settings after loading unpacked once.
3. Replace `oauth2.client_id` in `manifest.json`.
4. In Chrome, open `chrome://extensions`.
5. Enable **Developer mode**.
6. Run `npm install` in this folder to install offline ML dependencies.
7. Click **Load unpacked** and select this project folder.

## Test Phase 1-2

1. Click the extension icon.
2. Press **Sign in with Google**.
3. Press **List Photos**.
4. You should see image files from Drive.
5. Press **Classify Photos**.
6. You should see top predictions mapped to `nature`, `human`, or `unused`.

## Planned next steps

- Phase 3: Add face-api.js face counting and folder routing
- Phase 4: Enrollment flow + IndexedDB embeddings
- Phase 5: Drive `changes` endpoint auto processing
- Phase 6: Review queue + polish

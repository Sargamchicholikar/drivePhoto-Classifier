# Drive Photo Classifier

A Chrome extension that automatically organises your Google Drive photos into folders using on-device AI — no photos ever leave your device.

---

## What it does

Upload your photos to Google Drive and the extension sorts them into:

| Folder | Contents |
|---|---|
| 👤 Human | Photos with a single person |
| 👥 Group Photos | Photos with multiple people |
| 🐾 Animals | Photos with pets or wildlife |
| 🎬 Videos | Video files |
| ❓ Unsure | Low-confidence photos for you to review |
| 🗑️ Junk | Screenshots, documents, blurry or unrecognisable photos |

After sorting, the **Organise by Person** tab lets you find and move all photos of a specific person into their own folder — instantly.

---

## Features

### 🤖 On-device AI classification
- Uses **EfficientNet** (image classification) running via ONNX Runtime WebAssembly
- All processing happens inside your browser — no server, no API, no cloud

### 🧠 Face recognition
- Uses **ArcFace** (face recognition) to identify specific people
- Upload 4 reference photos per person (front, left, right, down angle)
- Scans your Human folder and moves matching photos into a dedicated folder per person

### 📈 Active Learning
- Every time you correct a misclassified photo, the model learns
- A k-NN classifier (k=5) is trained on your corrections locally
- Corrections apply to all future sorts — the product gets smarter the more you use it
- **Junk Review**: manually review Junk folder photos and rescue misclassified ones; each correction improves accuracy

### ⚡ Auto face indexing
- After initial setup, new photos added to your Human folder are automatically indexed every 30 minutes
- No manual action needed — face search stays up to date

### 🔒 100% private
- No photos are sent to any server
- All AI models run locally via WebAssembly
- Face embeddings stored in browser IndexedDB
- Corrections and settings stored in `chrome.storage.local`

---

## How to use

### Step 1 — Sort your photos
1. Install the extension and sign in with Google
2. Click **Sort Drive Photos**
3. The extension scans your Drive and sorts unsorted photos into the folders above

### Step 2 — Review uncertain photos
After sorting, a prompt appears to review photos the AI was unsure about. Your choices teach the AI for next time.

### Step 3 — Set up face recognition
1. Go to the **Organise** tab
2. Click **Get Started** — the extension scans your Human folder once (takes a few minutes)
3. New photos are auto-indexed every 30 minutes after that

### Step 4 — Find people
1. Click **+ Add Person**, enter a name, upload 4 photos (front, left, right, down-facing)
2. Click **Find & Organize All**
3. Matching photos are moved to `Smart Photo Organizer/People/<Name>/`

### Step 5 — Improve accuracy over time
- Use **Review Junk** to rescue misclassified photos and train the AI
- Use **Re-sort All** after enough corrections to re-classify everything with improved accuracy

---

## Tech stack

| Component | Technology |
|---|---|
| Extension platform | Chrome MV3 (Manifest V3) |
| Image classification | EfficientNet via ONNX Runtime WebAssembly |
| Face detection | BlazeFace / multi-scale detector |
| Face recognition | ArcFace w600k_mbf (512-dim embeddings) |
| Active learning | k-NN (k=5, cosine similarity ≥ 0.97) |
| Face index storage | IndexedDB (via custom faceDB wrapper) |
| Settings & corrections | chrome.storage.local |
| Drive integration | Google Drive API v3 |
| Auth | Google OAuth2 via chrome.identity |

---

## Architecture

```
User photos in Google Drive
        │
        ▼
┌─────────────────────────────┐
│   Sort Drive Photos         │  ← EfficientNet classifies each photo
│   Human / Group / Animals   │  ← k-NN corrections applied globally
│   Junk / Unsure / Videos    │
└─────────────────────────────┘
        │
        ▼
┌─────────────────────────────┐
│   Face Index (IndexedDB)    │  ← ArcFace extracts 512-dim embeddings
│   Auto-updated every 30 min │     from Human folder photos
└─────────────────────────────┘
        │
        ▼
┌─────────────────────────────┐
│   Find & Organize by Person │  ← Cosine similarity matching
│   threshold = 0.45          │     winner-takes-all + margin filter
│   People/<Name>/ folders    │
└─────────────────────────────┘
        │
        ▼
┌─────────────────────────────┐
│   Active Learning (k-NN)    │  ← Unsure Review + Junk Review
│   Personalised per user     │     corrections stored locally
│   Improves with every use   │
└─────────────────────────────┘
```

---

## Privacy

- All AI inference runs inside the browser using WebAssembly
- No photo pixels, embeddings, or metadata are ever sent to any external server
- Google Drive is accessed using your own OAuth2 token — only you have access
- All learned corrections are stored locally in your browser and never shared

---

## Accuracy (tested on personal library of ~15,000 indexed faces)

| Person | Photos found | Precision |
|---|---|---|
| Friend | 86 | 93% |
| Father | 75 | 96% |
| Brother | 85 | 95.3% |
| Mother | 67 | 91% |
| Self | 96 | 86.5% |

Accuracy improves with better reference photos and more Junk/Unsure reviews.

---

## Roadmap

- [ ] Gallery Expansion — store high-confidence match embeddings to grow recall over runs
- [ ] Junk Review improvements — batch actions, keyboard shortcuts
- [ ] Support for video thumbnails in face recognition
- [ ] Multi-language UI

---

## License

Copyright (c) 2026 Sargam Chicholikar. All Rights Reserved.

Unauthorised copying, distribution, modification, or sale of this software is strictly prohibited.
For licensing enquiries: sargamchicholikar@gmail.com

# 🎵 Setlist Optimizer

An AI-powered PWA for live performers. Build, optimize, and generate setlists with intelligent sequencing, key/tempo analysis, and AI-driven suggestions.

## Features

- **Auto-detect** BPM, key, energy & duration from song title/artist
- **Drag & drop** reordering
- **Generate Setlist** — AI builds an optimal set from your library to fit a target duration, with swap suggestions
- **Optimize** — AI analyzes flow score, energy arc, key transitions, and suggests moves/replacements/additions
- **Key / Tempo tab** — Camelot Wheel compatibility between every transition
- **Duration tracker** — live total time in the header
- **Vocal toggle** — Male / Female / Mixed filters all AI suggestions
- **Export PDF** — full setlist + analysis
- **CSV import** — bulk upload songs
- **Offline support** — works without internet after first load
- **Installable PWA** — add to your home screen on Android or iOS

---

## Deploy to GitHub Pages (5 minutes)

### 1. Create a new GitHub repository

Go to [github.com/new](https://github.com/new) and create a **public** repository named anything you like (e.g. `setlist-optimizer`).

### 2. Push these files

```bash
git init
git add .
git commit -m "Initial commit"
git branch -M main
git remote add origin https://github.com/YOUR_USERNAME/YOUR_REPO.git
git push -u origin main
```

### 3. Enable GitHub Pages

1. Go to your repo → **Settings** → **Pages**
2. Under **Source**, select **GitHub Actions**
3. The workflow will run automatically and deploy your app

Your app will be live at:
```
https://YOUR_USERNAME.github.io/YOUR_REPO/
```

---

## Add to Home Screen (Google Pixel / Android)

1. Open **Chrome** on your Pixel
2. Navigate to your GitHub Pages URL
3. Tap the **Install** banner that appears, or tap **⋮ → Add to Home screen**
4. The app installs as a standalone app — no browser chrome, works offline

## Add to Home Screen (iOS)

1. Open **Safari** on iPhone/iPad
2. Navigate to your URL
3. Tap the **Share** button → **Add to Home Screen**

---

## API Key Setup

The app uses the Anthropic Claude API for AI features. 

1. Get a key at [console.anthropic.com](https://console.anthropic.com)
2. In the app, tap **⚙ Settings** and paste your key
3. Keys are stored in your browser's localStorage — never sent anywhere except Anthropic

---

## CSV Format

Upload songs in bulk with a CSV file:

```csv
title,artist,genre,bpm,key,duration,energy
Bohemian Rhapsody,Queen,Rock,72,Bb,5:55,High
Hotel California,Eagles,Rock,74,Bm,6:30,Medium
```

Columns `title` and `artist` are most important — the AI will auto-detect the rest.

---

## File Structure

```
├── index.html          # App shell + PWA meta tags
├── app.js              # Full application (vanilla JS, no build step needed)
├── sw.js               # Service worker for offline caching
├── manifest.json       # PWA manifest
├── icons/              # App icons (all sizes)
└── .github/
    └── workflows/
        └── deploy.yml  # Auto-deploy to GitHub Pages on push
```

No build step required. Pure HTML + JS that runs directly in the browser.

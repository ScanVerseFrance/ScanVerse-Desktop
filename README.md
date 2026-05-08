# ScanVerse Webview

Native desktop wrapper for [ScanVerse](https://scanverse.fr) with Discord Rich Presence.

Loads the ScanVerse site in a borderless Chromium window and pushes a custom
Discord activity to the local Discord client based on the page being viewed.

## Stack

- **Electron 41** — webview shell
- **discord-rpc** — IPC connection to local Discord client (no internet needed)
- **App ID** : `1500986435220541591`

## Setup

```bash
cd "ScanVerse Webview"
npm install
```

## Run

| Command | Loads | DevTools |
|---|---|---|
| `npm start` | `https://scanverse.fr` (prod) | off |
| `npm run dev` | `http://localhost:5173` | on |
| `npm run lan` | `http://192.168.2.100:5173` | on |
| custom | set `SCANVERSE_URL=...` | set `SCANVERSE_DEV=1` for tools |

Example for a different LAN IP:
```bash
SCANVERSE_URL=http://192.168.1.42:5173 SCANVERSE_DEV=1 npm start
```

## Discord Rich Presence

The wrapper has **two presence detection modes**, both active at once:

### 1. URL-based (zero site changes required)

The main process listens to webview navigation events and parses the URL to
infer what page you're on. Works for: `/`, `/catalogue`, `/manga/:id`,
`/manga/:id/chapter/:n`, `/profile/:user`, `/friends`, `/wrapped`, `/admin`,
`/login`, `/register`, `/settings`, `/me`, 404.

### 2. Page-emitted (rich data — title, cover, author)

When the site is loaded inside the wrapper, `window.scanverse` is exposed.
The site can call:

```js
if (window.scanverse?.isElectron) {
  window.scanverse.setPresence('manga', {
    id: 'abc-123',
    title: 'One Piece',
    author: 'Eiichiro Oda',
    cover: 'https://s4.anilist.co/file/anilistcdn/media/manga/cover/large/...jpg'
  });
}
```

Page-emitted presence overrides URL-based (fires later with more info).

## Route → Presence mapping

| Route | `details` | `state` | Large image |
|---|---|---|---|
| `/` | Sur l'accueil | Parcourt la bibliothèque | `scanverse_logo` |
| `/catalogue?type=manga` | Parcourt le catalogue | Mangas | `scanverse_logo` |
| `/catalogue?type=comics` | Parcourt le catalogue | Comics | `scanverse_logo` |
| `/manga/:id` | Consulte *Titre* | *Auteur* / *Année* | **Cover URL** |
| `/read/:mangaId/:chapterId` | Lit *Titre* | Chapitre N | **Cover URL** |
| `/profile/:handle` | Regarde un profil | @*handle* | `scanverse_logo` |
| `/friends` | Gère ses amis | — | `scanverse_logo` |
| `/wrapped` | Regarde son Wrapped | Année 2026 | `scanverse_logo` |
| `/admin` | Espace admin | — | `scanverse_logo` |
| `/login` | Se connecte | — | `scanverse_logo` |
| `/register` | Crée un compte | — | `scanverse_logo` |
| `/settings*` | Personnalise son profil | — | `scanverse_logo` |
| `/univers/:id` | Explore un univers | — | `scanverse_logo` |
| `/suggestions` | Lit les suggestions | — | `scanverse_logo` |
| `/premium` | Découvre Premium | — | `scanverse_logo` |
| `/about` | Découvre ScanVerse | À propos | `scanverse_logo` |
| `/contact` | Page contact | — | `scanverse_logo` |
| `/privacy-policy` | Politique de confidentialité | — | `scanverse_logo` |
| `/terms` | Conditions d'utilisation | — | `scanverse_logo` |
| `/changelog` | Lit les notes de version | — | `scanverse_logo` |
| 404 / catch | S'est perdu | Page introuvable | `scanverse_logo` |

Per spec: **no small image** anywhere. Large image is either a cover URL
(for `/manga/*`) or the static `scanverse_logo` asset (uploaded once to the
Discord Developer Portal under that exact key name).

## Discord Developer Portal — one-time setup

1. Open https://discord.com/developers/applications/1500986435220541591
2. Go to **Rich Presence → Art Assets**
3. Upload the SV violet logo (square PNG, 512×512+) with key name
   `scanverse_logo`
4. Save. Done — no other assets are needed since covers come from public
   CDNs (AniList, ComicVine, Electre) at runtime.

## Architecture

```
src/
├── main.js       Boots BrowserWindow, listens to navigation,
│                 routes URL/IPC events to RPC layer
├── preload.js    Context bridge — exposes window.scanverse to the page
├── rpc.js        discord-rpc client wrapper with auto-reconnect
└── routes.js     Pure mapping: (route, params) -> Discord activity payload
```

## Discord "Rejoindre" / Join feature

Each manga and reader presence carries a `joinSecret` + `partyId/partySize/partyMax`
so Discord shows an **"Invitation de jeu"** card on the user's profile with a
**"Rejoint"** button (the badge "ScanVerse est compatible avec les invitations
de jeu" confirms it).

**Flow when a friend clicks Rejoint:**
- Friend has ScanVerse Webview **running** + connected to Discord with the
  same App ID → their app receives `ACTIVITY_JOIN` with the secret
  (`m:<id>` or `r:<id>:<chapter>`) → main process decodes it and loads the
  corresponding `/manga/:id` or `/read/:id/:chapter` page.
- Friend has the app **installed but not running** → Discord cannot
  auto-launch ScanVerse Webview unless the app is in Discord's
  "Detectable Games" list (requires verification → ~75 unique users).
  Until then: friend must open the app manually before clicking Rejoint.
- Friend doesn't have the app → Join fails silently. No web fallback —
  matching the spec ("only if they have the application").

`ACTIVITY_JOIN_REQUEST` is also auto-accepted in `rpc.js`, so the
right-click "Demander à rejoindre" path works the same way.

### `scanverse://` deep links

The desktop app registers a custom protocol so anyone can share links like:

```
scanverse://manga/one_piece
scanverse://read/one_piece/1042
scanverse://m/abc      ← matches Discord joinSecret format too
scanverse://r/abc/1
```

Clicking such a link in any app (Discord chat, Twitter, browser address
bar, etc.) launches ScanVerse Webview at the right page. If the app is
already running, it focuses the existing window and navigates instead of
spawning a duplicate (single-instance lock).

In dev mode, the protocol is registered to launch via `electron.exe + path/to/main.js`.
In production builds, it'll point at `scanverse-webview.exe`.

## Limitations

- **Local cover URLs (LAN, localhost) won't show in Discord** — Discord's
  CDN can't reach your machine. The wrapper detects non-https URLs and
  falls back to `scanverse_logo` automatically.
- **Buttons in Rich Presence** point to `https://scanverse.fr/...` even in
  dev — change `SCANVERSE_PUBLIC_URL` env var to override.
- **Discord client must be running** locally for presence to appear. The
  wrapper handles disconnect/reconnect gracefully (queues last presence,
  retries every 15 s).

## Distribution & updates

Builds are produced by GitHub Actions on tag push.

### Cutting a release

```bash
# 1. Bump both versions (must match)
#    package.json            → "version": "X.Y.Z"
#    installer/package.json  → "version": "X.Y.Z"
git commit -am "release vX.Y.Z"

# 2. Tag and push — Actions takes it from there
git tag vX.Y.Z
git push --tags
```

`.github/workflows/release.yml` builds the custom installer
(`dist/ScanVerse-Setup-X.Y.Z.exe`) on a fresh Windows runner and attaches it
to a GitHub Release tied to the tag. Release notes are auto-generated from
commit messages (editable on github.com afterward).

### Update flow on the user's machine

`src/update-check.js` hits the GitHub Releases API on app startup, compares
the installed version against the latest release, and shows a native dialog
if a newer one exists. Picking "Télécharger" opens the installer asset in
the user's default browser; they re-run the installer, which overwrites
the existing install in place. No silent / background-update flow yet —
that requires a code-signing cert to avoid SmartScreen warnings on each
update, which the project doesn't have.

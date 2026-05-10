/**
 * ScanVerse Webview — Electron main process.
 *
 * Boots a single-window webview pointed at the ScanVerse site, and bridges
 * route changes (and rich data from the page itself) to a Discord Rich
 * Presence connection.
 *
 * URL is selected from env vars:
 *   SCANVERSE_URL   — full URL to load (e.g. http://192.168.2.100:5173)
 *   SCANVERSE_DEV   — if set, defaults to http://localhost:5173 + opens DevTools
 *   (otherwise defaults to https://scanverse.fr — the public prod URL)
 */
const { app, BrowserWindow, ipcMain, shell, nativeImage, powerMonitor } = require('electron');
const path = require('path');

// Windows app identity — without this, Windows lumps the dev process under
// the generic electron.exe in the taskbar (so the icon doesn't apply and
// pinned/grouped state is wrong). With it set BEFORE any window is created,
// Windows treats ScanVerse as its own app.
if (process.platform === 'win32') {
  app.setAppUserModelId('com.scanverse.webview');
}

const ICON_PATH = path.join(__dirname, '..', 'assets', 'icon.png');
const { init: initRpc, updatePresence, clearPresence } = require('./rpc');
const { getPresenceForRoute, cleanChapterLabel } = require('./routes');
const { checkForUpdates } = require('./update-check');
const fs = require('fs');
const os = require('os');

/**
 * Sweep stale ScanVerse installer .exes from %TEMP%.
 *
 * The in-app updater downloads each new release into the OS temp dir
 * (see update-check.js → ipc 'update:download'). After a successful
 * silent install the file isn't needed anymore, but the *running*
 * installer can't delete its own .exe. So we wait until the next launch
 * of ScanVerse — which is *after* the silent installer relaunched us —
 * and clean the residue here. unlinkSync swallows EBUSY/EPERM silently:
 * if for some reason the installer is still running, its file stays
 * locked; we just try again next launch.
 */
function cleanupStaleInstallers() {
  try {
    const tmp = os.tmpdir();
    for (const name of fs.readdirSync(tmp)) {
      if (/^ScanVerse-Setup-.*\.exe$/i.test(name)) {
        try { fs.unlinkSync(path.join(tmp, name)); } catch {}
      }
    }
  } catch {/* ignore — best-effort */}
}

const isDev = !!process.env.SCANVERSE_DEV;
// Production target. www.scanverse.online is the canonical public domain
// (CNAME flipped to the Vercel deployment). Override with SCANVERSE_URL
// when pointing at a staging build or a LAN dev server.
const TARGET_URL = process.env.SCANVERSE_URL || (isDev ? 'http://localhost:5173' : 'https://www.scanverse.online');

let mainWindow = null;

// ── Custom protocol: scanverse:// ────────────────────────────────────────────
// Lets anyone share a deep link like scanverse://manga/abc that opens the
// desktop app directly at that page. Used for:
//   - Friends pasting share links in Discord/Twitter/etc.
//   - Future Discord auto-launch on Join (once the app is in Discord's
//     Detectable Games list — requires verification at scale).
//
// In dev mode the executable path is electron.exe, so we have to pass the
// "main script path" alongside it for Windows to know how to relaunch us.
if (process.defaultApp) {
  if (process.argv.length >= 2) {
    app.setAsDefaultProtocolClient('scanverse', process.execPath, [path.resolve(process.argv[1])]);
  }
} else {
  app.setAsDefaultProtocolClient('scanverse');
}

// Single-instance lock — if the user clicks a scanverse:// link while the
// app is already open, Windows tries to launch a second instance. We refuse
// the second one and instead surface the URL to the existing window.
const gotLock = app.requestSingleInstanceLock();
if (!gotLock) {
  app.quit();
}

/**
 * Translate a scanverse:// URL into a path on the target site.
 *   scanverse://manga/abc           → /manga/abc
 *   scanverse://read/abc/1          → /read/abc/1
 *   scanverse://m/abc  (joinSecret) → /manga/abc
 *   scanverse://r/abc/1 (joinSecret)→ /read/abc/1
 */
function pathFromProtocolUrl(urlStr) {
  let u;
  try { u = new URL(urlStr); } catch { return null; }
  if (u.protocol !== 'scanverse:') return null;
  const host = u.hostname || '';
  const segs = u.pathname.split('/').filter(Boolean);
  // scanverse://manga/abc  →  host = 'manga', segs = ['abc']
  if ((host === 'manga' || host === 'm') && segs[0]) {
    return `/manga/${encodeURIComponent(segs[0])}`;
  }
  if ((host === 'read' || host === 'r') && segs[0] && segs[1]) {
    return `/read/${encodeURIComponent(segs[0])}/${encodeURIComponent(segs[1])}`;
  }
  return null;
}

function navigateFromProtocolUrl(urlStr) {
  const path = pathFromProtocolUrl(urlStr);
  if (!path || !mainWindow || mainWindow.isDestroyed()) return;
  const target = `${TARGET_URL.replace(/\/$/, '')}${path}`;
  console.log('[Main] scanverse:// →', target);
  mainWindow.loadURL(target);
  if (mainWindow.isMinimized()) mainWindow.restore();
  mainWindow.focus();
}

/**
 * Parses a URL and returns { route, params } usable by routes.js.
 * Used as a fallback when the page hasn't (yet) called setPresence —
 * gives us correct presence for plain-data pages even if site-side hook
 * isn't installed yet.
 */
function parseRouteFromUrl(urlStr) {
  let u;
  try { u = new URL(urlStr); } catch { return null; }
  const p = u.pathname.replace(/\/+$/, '') || '/';

  if (p === '/' || p === '') return { route: 'home' };
  if (p.startsWith('/catalogue')) {
    const type = u.searchParams.get('type') ||
      (p.endsWith('/comics') ? 'comics' : p.endsWith('/manga') ? 'manga' : 'manga');
    // Extract filter context from the query string. The CataloguePage will
    // push richer data via useDiscordPresence (with proper genre labels), but
    // this URL fallback handles the case where the hook hasn't fired yet.
    const q = u.searchParams.get('q');
    const genres = u.searchParams.get('genres');
    const sort   = u.searchParams.get('sort');
    return { route: 'catalogue', params: {
      type,
      q: q || null,
      genres: genres ? genres.split(',').filter(Boolean) : [],
      sort: sort || null,
    } };
  }
  // /read/:mangaId/:chapterId  (the actual reader route)
  let m = p.match(/^\/read\/([^/]+)\/([^/?#]+)/);
  if (m) return { route: 'reader', params: { id: m[1], chapter: m[2] } };
  m = p.match(/^\/manga\/([^/?#]+)/);
  if (m) return { route: 'manga', params: { id: m[1] } };
  m = p.match(/^\/profile\/([^/?#]+)/);
  if (m) return { route: 'profile', params: { username: m[1] } };
  m = p.match(/^\/univers\/([^/?#]+)/);
  if (m) return { route: 'universe', params: { id: m[1] } };
  if (p === '/friends') return { route: 'friends' };
  if (p === '/wrapped' || p.startsWith('/wrapped/')) {
    const year = p.match(/^\/wrapped\/(\d{4})/)?.[1];
    return { route: 'wrapped', params: year ? { year } : {} };
  }
  if (p === '/admin' || p.startsWith('/admin/')) return { route: 'admin' };
  if (p === '/login') return { route: 'login' };
  if (p === '/register') return { route: 'register' };
  // Settings sub-pages each get their own RPC line so people don't see a
  // generic "Réglages du compte" no matter which tab they're on.
  if (p === '/settings/blocked')    return { route: 'settings-blocked' };
  if (p === '/settings/privacy')    return { route: 'settings-privacy' };
  if (p === '/settings/appearance') return { route: 'settings-appearance' };
  if (p.startsWith('/settings')) return { route: 'settings' };
  if (p === '/suggestions') return { route: 'suggestions' };
  if (p === '/premium') return { route: 'premium' };
  if (p === '/about') return { route: 'about' };
  if (p === '/contact') return { route: 'contact' };
  if (p === '/privacy-policy') return { route: 'privacy' };
  if (p === '/terms') return { route: 'terms' };
  if (p === '/changelog') return { route: 'changelog' };
  // /messages and /messages/:handle — the inbox view + per-thread view.
  // We pass the handle through so both the title bar and Discord RPC can
  // show "Discute avec @kazu" rather than a generic label.
  if (p === '/messages' || p.startsWith('/messages/')) {
    const handle = p.match(/^\/messages\/([^/?#]+)/)?.[1] || null;
    return { route: 'messages', params: handle ? { handle: decodeURIComponent(handle) } : {} };
  }
  return { route: 'notfound' };
}

// Privacy gate — page can disable RPC via window.scanverse.setRpcEnabled(false).
// Synced from renderer's localStorage on DOMContentLoaded and on user toggle.
let rpcEnabled = true;

// Cache of the last *rich* payload pushed by the frontend hook.
// Without this cache, every re-emission triggered by the wrapper itself
// (online-count tick every 30 s, focus events, etc.) flattens the rich
// data — title, cover, author — back to the URL-only fallback, which is
// what causes "Lit une œuvre · Chapitre s1_scans__... · ScanVerse logo"
// to appear after a few minutes on the same manga / reader page.
//   route:  string ('manga' | 'reader' | 'profile' | …)
//   params: object the frontend passed (full rich data)
let lastRichPayload = null;

// Live session activity — # of users online on ScanVerse right now.
// Polled every 30 s from the backend; injected into all presence payloads
// so Discord shows "Parcourt la bibliothèque · 12 en ligne" etc.
let onlineCount = 0;
async function pollOnlineCount() {
  try {
    const url = `${TARGET_URL.replace(/\/$/, '')}/api/presence/online-count`;
    const r = await fetch(url);
    if (!r.ok) return;
    const data = await r.json();
    const next = Number(data.online) || 0;
    if (next !== onlineCount) {
      onlineCount = next;
      console.log('[Main] online count:', onlineCount);
      // Re-emit current presence so the count shows up immediately
      if (rpcEnabled && mainWindow && !mainWindow.isDestroyed()) {
        emitPresenceFromUrl(mainWindow.webContents.getURL());
      }
    }
  } catch { /* ignore */ }
}

// Build a short, human-readable label for the custom title bar from a
// URL-parsed route. We keep this independent from the RPC payload (which
// has its own "details / state" copy) — the title bar is more compact
// and uses Discord-channel-style "ScanVerse · <context>" formatting.
function titleBarLabelFor(route, params = {}) {
  switch (route) {
    case 'home':              return 'Accueil';
    case 'catalogue':         return params.type === 'comics' ? 'Catalogue · Comics' : 'Catalogue · Manga';
    case 'manga':             return params.title ? `${params.title}` : 'Fiche d\'œuvre';
    case 'reader': {
      // When the React hook has pushed rich data we know the manga title
      // and chapter — show "One Piece — Ch.1089". Otherwise fall back to
      // the generic "Lecture en cours" until the hook fires.
      const t = params.title || null;
      const ch = params.chapter != null ? cleanChapterLabel(params.chapter, params.id) : null;
      if (t && ch) {
        const isVol = /^(Tome|Intégrale|Hors-série)\s/.test(ch);
        return isVol ? `${t} — ${ch}` : `${t} — Ch.${ch}`;
      }
      if (t) return t;
      return 'Lecture en cours';
    }
    case 'profile':           return params.username ? `Profil de @${params.username}` : 'Profil';
    case 'friends':           return 'Amis';
    case 'wrapped':           return params.year ? `Wrapped ${params.year}` : 'Wrapped';
    case 'admin':             return 'Espace admin';
    case 'login':             return 'Connexion';
    case 'register':          return 'Inscription';
    case 'settings':          return 'Réglages';
    case 'settings-blocked':  return 'Réglages · Blocages';
    case 'settings-privacy':  return 'Réglages · Confidentialité';
    case 'settings-appearance': return 'Réglages · Apparence';
    case 'settings-music':    return 'Réglages · Musique';
    case 'settings-reader':   return 'Réglages · Lecteur';
    case 'universe':          return 'Univers';
    case 'suggestions':       return 'Suggestions';
    case 'premium':           return 'Premium';
    case 'about':             return 'À propos';
    case 'contact':           return 'Contact';
    case 'privacy':           return 'Confidentialité';
    case 'terms':             return 'CGU';
    case 'changelog':         return 'Changelog';
    case 'messages':          return params.handle ? `Messagerie · @${params.handle}` : 'Messagerie';
    case 'notfound':          return 'Page introuvable';
    default:                  return 'ScanVerse';
  }
}

// Push the current title-bar context to the renderer. The injected bar
// in preload.js listens for this IPC channel and updates its label —
// this is what swaps "Accueil" → "Lecture en cours" when the user opens
// a chapter, etc. Rich data pushed by the React hook (manga title, etc.)
// arrives through a separate channel and replaces this URL fallback.
function broadcastTitleBarContext(route, params = {}) {
  if (!mainWindow || mainWindow.isDestroyed()) return;
  const label = titleBarLabelFor(route, params);
  mainWindow.webContents.send('titlebar:context', { route, params, label });
}

function emitPresenceFromUrl(urlStr) {
  if (!rpcEnabled) return;
  const parsed = parseRouteFromUrl(urlStr);
  if (!parsed) return;

  // Prefer the cached frontend-pushed rich data when the context still
  // matches (same route, same id). This is what keeps title/cover/author
  // alive when the online-count poll, a focus change, or any other
  // wrapper-internal event triggers a re-emission. Without this guard,
  // the URL fallback would silently downgrade the activity every 30 s.
  if (lastRichPayload && lastRichPayload.route === parsed.route) {
    const richId = lastRichPayload.params?.id;
    const urlId  = parsed.params?.id;
    // Routes without an id (home, friends, settings…) match on route alone.
    // Routes with an id (manga, reader, profile, universe…) must match on
    // both — we don't want stale rich data from /manga/A to leak into a
    // re-emission for /manga/B.
    const idMatches = !richId || !urlId || String(richId) === String(urlId);
    if (idMatches) {
      const payload = getPresenceForRoute(lastRichPayload.route, lastRichPayload.params, { onlineCount });
      if (payload) updatePresence(payload);
      return;
    }
  }

  const payload = getPresenceForRoute(parsed.route, parsed.params || {}, { onlineCount });
  if (payload) updatePresence(payload);
}

function createWindow() {
  const icon = nativeImage.createFromPath(ICON_PATH);

  mainWindow = new BrowserWindow({
    width: 1400,
    height: 900,
    minWidth: 1024,
    minHeight: 700,
    icon,
    backgroundColor: '#0a0a0f',
    autoHideMenuBar: true,
    title: 'ScanVerse',
    // Custom title bar — Discord-style. We hide the OS chrome and let
    // titleBarOverlay paint the native min/max/close on the right with
    // colors that match the app (#0a0a0f bg / #9090a8 icons), then the
    // preload script injects a draggable strip on the left with the SV
    // logo + the current page name. Height is mirrored both here (so
    // Electron reserves the right amount of space for the overlay) and
    // in preload.js' CSS so the injected bar lines up perfectly with
    // the native controls.
    titleBarStyle: 'hidden',
    titleBarOverlay: {
      color: '#0a0a0f',
      symbolColor: '#9090a8',
      height: 32,
    },
    webPreferences: {
      preload: path.join(__dirname, 'preload.js'),
      contextIsolation: true,
      nodeIntegration: false,
      sandbox: false,
      // Allow autoplay, etc. — same as a normal browser
      webSecurity: true,
      // Hard-disable DevTools in production builds. With this off Electron
      // refuses to open DevTools at all (no Ctrl+Shift+I, no right-click
      // "Inspect", no programmatic openDevTools()). Dev mode keeps it on
      // so we can still debug the wrapper itself.
      devTools: isDev,
      // Kazu-reported bug: alt-tabbing away for a while comes back to a
      // black screen with all UI gone. Chromium's default behaviour for
      // backgrounded windows is to throttle requestAnimationFrame to 1 Hz,
      // freeze JS timers, and eventually evict WebGL contexts — the home
      // / catalogue Three.js background and the per-layer profile-effect
      // intervals don't recover cleanly when those resources come back.
      // Disabling backgroundThrottling keeps the renderer ticking at full
      // speed while unfocused. Cost: ~constant CPU when the window is
      // minimized, which is the right trade for a chat/reader app where
      // the user expects to come back to a live page.
      backgroundThrottling: false,
    },
  });

  // Belt-and-braces — some Windows configurations only pick up the
  // taskbar/titlebar icon via setIcon() called after construction.
  if (process.platform === 'win32') {
    mainWindow.setIcon(icon);
  }

  // ── Lockdown: keyboard shortcuts + context menu ────────────────────────
  // Even with devTools:false, some users will reach for F12 / Ctrl+Shift+I /
  // Ctrl+U / Ctrl+S out of habit. Swallow them silently in production so
  // there's no visible reaction (no error popup, no flash). In dev we let
  // them through so we can keep using DevTools.
  if (!isDev) {
    mainWindow.webContents.on('before-input-event', (event, input) => {
      if (input.type !== 'keyDown') return;
      const key = (input.key || '').toLowerCase();
      const blocked =
        key === 'f12' ||
        (input.control && input.shift && (key === 'i' || key === 'j' || key === 'c')) ||
        (input.control && (key === 'u' || key === 's')) ||
        (input.meta    && input.alt   && key === 'i'); // macOS DevTools shortcut
      if (blocked) event.preventDefault();
    });

    // Stop the default Chromium context menu (which exposes "Inspect Element"
    // and "View Page Source" entries even with devTools:false in some Electron
    // builds). The page can still implement its own context menus via JS —
    // this only suppresses the native one.
    mainWindow.webContents.on('context-menu', e => e.preventDefault());
  }

  // Open external links (target=_blank, http(s) outside the site) in default browser
  mainWindow.webContents.setWindowOpenHandler(({ url }) => {
    const isOurSite = url.startsWith(TARGET_URL.replace(/\/$/, '')) ||
                      url.startsWith('http://localhost') ||
                      url.startsWith('http://192.168.');
    if (!isOurSite && url.startsWith('http')) {
      shell.openExternal(url);
      return { action: 'deny' };
    }
    return { action: 'allow' };
  });

  // URL-based presence detection — events + polling fallback.
  // React Router pushState should trigger did-navigate-in-page, but in
  // practice some SPA navigations slip through. Polling getURL() every
  // 1 s is bullet-proof and cheap.
  let lastSeenUrl = '';
  function checkUrl(reason) {
    if (!mainWindow || mainWindow.isDestroyed()) return;
    const url = mainWindow.webContents.getURL();
    if (!url || url === lastSeenUrl) return;
    const prevUrl = lastSeenUrl;
    lastSeenUrl = url;
    // We used to drop lastRichPayload unconditionally on every URL
    // change. That broke same-manga chapter switches (and even React
    // Router pushState within the same page): the next emit ran the
    // URL fallback ("Lit une œuvre · Chapitre 25") for the few hundred
    // ms before the React hook re-fired, and friends saw that exact
    // stale state on Discord — verified in prod when kazu's friend's
    // RPC stuck on "Lit une œuvre / Chapitre 25 / 41:22".
    //
    // emitPresenceFromUrl already knows how to pick between cache and
    // URL fallback based on route + id match. So we just clear the
    // cache when the route OR id actually differs from the cached one;
    // chapter-only changes ("/read/X/24" → "/read/X/25") keep the rich
    // payload so cover + title survive.
    const prevParsed = prevUrl ? parseRouteFromUrl(prevUrl) : null;
    const nextParsed = parseRouteFromUrl(url);
    const idChanged =
      !prevParsed || !nextParsed ||
      prevParsed.route !== nextParsed.route ||
      String(prevParsed.params?.id || '') !== String(nextParsed.params?.id || '');
    if (idChanged) lastRichPayload = null;
    console.log(`[Main] URL change (${reason}):`, url, idChanged ? '— cache cleared' : '— cache kept');
    // Title bar follows URL changes regardless of the RPC privacy toggle —
    // even users who hide their Discord activity still want to know
    // which page they're on. The RPC emit is gated separately. We skip
    // data: / chrome: URLs (splash / error pages) because parseRouteFromUrl
    // would route them to "notfound" and briefly flash "Page introuvable"
    // in the title bar while the real site loads.
    if (/^https?:/i.test(url)) {
      const parsed = parseRouteFromUrl(url);
      if (parsed) broadcastTitleBarContext(parsed.route, parsed.params || {});
    }
    emitPresenceFromUrl(url);
  }
  mainWindow.webContents.on('did-navigate',         (_e, _url) => checkUrl('did-navigate'));
  mainWindow.webContents.on('did-navigate-in-page', (_e, _url) => checkUrl('did-navigate-in-page'));
  const pollId = setInterval(() => checkUrl('poll'), 1000);

  // OS-level idle detection — fallback for the frontend's idle timer.
  // The renderer's idle detection (frontend/src/pages/ReaderPage.jsx) is
  // the source of truth when the user is actively focused on ScanVerse,
  // but it's gated on `document.hidden` so it stops ticking when the
  // window loses focus. We've seen RPC stuck on "Lit une œuvre / Ch.25"
  // for 40+ min while the user was AFK because the renderer's idle
  // never fired in the background.
  //
  // powerMonitor.getSystemIdleTime() reads OS-level mouse/keyboard
  // idle time, so it works regardless of which window is focused. We
  // poll every 60 s and, when the user has been OS-idle for >= 10 min
  // AND we have a cached rich payload for a manga / reader page, we
  // re-emit it with idle:true so Discord shows the "📖 En pause sur"
  // wording + cover. When activity resumes, we re-emit without idle
  // so it flips back to "Lit One Piece" instantly.
  const OS_IDLE_THRESHOLD_S = 10 * 60; // 10 min
  let wrapperIdle = false;
  const idlePollId = setInterval(() => {
    if (!rpcEnabled) return;
    if (!lastRichPayload) return;
    // Only meaningful for routes that have an idle path in routes.js —
    // currently 'reader'. 'manga' and others don't render an idle
    // variant, so flipping idle there would be a no-op visual change.
    if (lastRichPayload.route !== 'reader') return;
    let idleSeconds;
    try { idleSeconds = powerMonitor.getSystemIdleTime(); }
    catch { return; /* unsupported on this OS — fall through */ }
    const shouldBeIdle = idleSeconds >= OS_IDLE_THRESHOLD_S;
    if (shouldBeIdle === wrapperIdle) return;
    wrapperIdle = shouldBeIdle;
    const merged = { ...lastRichPayload.params, idle: shouldBeIdle };
    lastRichPayload = { route: lastRichPayload.route, params: merged };
    const payload = getPresenceForRoute(lastRichPayload.route, merged, { onlineCount });
    if (payload) updatePresence(payload);
    console.log(`[Main] wrapper idle → ${shouldBeIdle} (${idleSeconds}s OS idle)`);
  }, 60_000);

  mainWindow.on('closed', () => {
    clearInterval(pollId);
    clearInterval(idlePollId);
    mainWindow = null;
  });

  // ── Loading + error overlays ─────────────────────────────────────────
  // Without these we'd briefly flash the BrowserWindow's #0a0a0f
  // background while the network/site is loading, and worst case sit
  // on a black screen forever if the site is unreachable. Now we paint
  // a branded splash immediately, swap to the real site on success,
  // and swap to a friendly error page on failure.

  // Google Fonts is loaded via <link> rather than @import inside <style>
  // because @import in a data: URL is sometimes blocked by Chromium for
  // CSP-ish reasons. The link tag works reliably.
  const FONTS_HEAD = `<link rel="preconnect" href="https://fonts.googleapis.com">
    <link rel="preconnect" href="https://fonts.gstatic.com" crossorigin>
    <link href="https://fonts.googleapis.com/css2?family=Syne:wght@400;700;800&family=JetBrains+Mono:wght@400;500&display=swap" rel="stylesheet">`;

  const SPLASH_HTML = `
    <html><head><meta charset="utf-8"><title>ScanVerse</title>
    ${FONTS_HEAD}
    <style>
      html,body{margin:0;height:100%;background:#0a0a0f;color:#f0f0f5;font-family:'Syne',system-ui,sans-serif}
      .wrap{display:flex;flex-direction:column;align-items:center;justify-content:center;height:100%;gap:24px}
      .logo{display:flex;align-items:center;gap:6px;font-weight:800;font-size:32px;letter-spacing:-1px}
      .logo .v{color:#a855f7}
      .spinner{width:32px;height:32px;border:3px solid rgba(168,85,247,0.2);border-top-color:#a855f7;border-radius:50%;animation:spin 0.8s linear infinite}
      .label{color:#5a5a72;font-size:12px;letter-spacing:0.1em;text-transform:uppercase;font-family:'JetBrains Mono',ui-monospace,monospace}
      @keyframes spin{to{transform:rotate(360deg)}}
    </style></head>
    <body><div class="wrap">
      <div class="logo"><span>Scan</span><span class="v">Verse</span></div>
      <div class="spinner"></div>
      <div class="label">Chargement…</div>
    </div></body></html>`;

  function buildErrorHtml(target, message) {
    const safeTarget = String(target || '').replace(/[<>&"]/g, c => ({ '<':'&lt;','>':'&gt;','&':'&amp;','"':'&quot;' }[c]));
    const safeMsg = String(message || '').replace(/[<>&"]/g, c => ({ '<':'&lt;','>':'&gt;','&':'&amp;','"':'&quot;' }[c]));
    return `
      <html><head><meta charset="utf-8"><title>ScanVerse — Erreur</title>
      ${FONTS_HEAD}
      <style>
        html,body{margin:0;height:100%;background:#0a0a0f;color:#f0f0f5;font-family:'Syne',system-ui,sans-serif}
        .wrap{display:flex;flex-direction:column;align-items:center;justify-content:center;height:100%;gap:18px;padding:24px;text-align:center;box-sizing:border-box}
        .logo{display:flex;align-items:center;gap:6px;font-weight:800;font-size:24px;letter-spacing:-1px;opacity:0.5;margin-bottom:8px}
        .logo .v{color:#a855f7}
        h1{margin:0;font-size:24px;font-weight:800;letter-spacing:-0.5px}
        p{margin:0;color:#9090a8;font-size:14px;max-width:480px;line-height:1.5}
        code{background:#18181f;padding:2px 8px;border-radius:4px;font-size:12px;color:#c4b5fd;font-family:'JetBrains Mono',ui-monospace,monospace}
        .err{background:#18181f;padding:8px 12px;border-radius:8px;font-size:12px;color:#ef4444;font-family:'JetBrains Mono',ui-monospace,monospace;max-width:560px;overflow-wrap:break-word;border:1px solid rgba(239,68,68,0.2)}
        .actions{display:flex;gap:12px;margin-top:8px}
        button{padding:10px 18px;border-radius:10px;border:none;font-weight:800;font-size:13px;cursor:pointer;transition:transform .1s;font-family:'Syne',system-ui,sans-serif;letter-spacing:0.02em;display:inline-flex;align-items:center;gap:7px}
        button:active{transform:scale(0.97)}
        .primary{background:#a855f7;color:#fff}
        .secondary{background:#18181f;color:#f0f0f5;border:1px solid rgba(255,255,255,0.1)}
        .discord{background:#5865f2;color:#fff}
        .discord-prompt{margin-top:4px;color:#9090a8;font-size:13px}
      </style></head>
      <body><div class="wrap">
        <div class="logo"><span>Scan</span><span class="v">Verse</span></div>
        <h1>ScanVerse est injoignable</h1>
        <p>Impossible de charger <code>${safeTarget}</code>. Vérifie que le site est en ligne.</p>
        <div class="err">${safeMsg}</div>
        <p class="discord-prompt">Pour toute question, rejoins le Discord :</p>
        <div class="actions">
          <button class="primary" onclick="location.reload()">Réessayer</button>
          <button class="discord" onclick="window.open('https://discord.gg/scanverse','_blank')">
            <svg width="14" height="14" viewBox="0 0 127 96" fill="currentColor"><path d="M107.7,8.07A105.15,105.15,0,0,0,81.47,0a72.06,72.06,0,0,0-3.36,6.83A97.68,97.68,0,0,0,49,6.83,72.37,72.37,0,0,0,45.64,0,105.89,105.89,0,0,0,19.39,8.09C2.79,32.65-1.71,56.6.54,80.21h0A105.73,105.73,0,0,0,32.71,96.36,77.7,77.7,0,0,0,39.6,85.25a68.42,68.42,0,0,1-10.85-5.18c.91-.66,1.8-1.34,2.66-2a75.57,75.57,0,0,0,64.32,0c.87.71,1.76,1.39,2.66,2a68.68,68.68,0,0,1-10.87,5.19,77,77,0,0,0,6.89,11.1A105.25,105.25,0,0,0,126.6,80.22h0C129.24,52.84,122.09,29.11,107.7,8.07ZM42.45,65.69C36.18,65.69,31,60,31,53s5-12.74,11.43-12.74S54,46,53.89,53,48.84,65.69,42.45,65.69Zm42.24,0C78.41,65.69,73.25,60,73.25,53s5-12.74,11.44-12.74S96.23,46,96.12,53,91.08,65.69,84.69,65.69Z"/></svg>
            Rejoindre
          </button>
          <button class="secondary" onclick="window.close()">Fermer</button>
        </div>
      </div></body></html>`;
  }

  // Show splash immediately while the real site loads.
  mainWindow.loadURL('data:text/html;charset=utf-8,' + encodeURIComponent(SPLASH_HTML));

  let didFinishOnce = false;
  // Catch network / loadURL failures and swap to a clean error page.
  mainWindow.webContents.on('did-fail-load', (_e, errorCode, errorDesc, validatedURL, isMainFrame) => {
    if (!isMainFrame) return; // ignore subresource failures
    // Skip aborted loads — they fire whenever we replace one navigation
    // with another (splash → target, or target → splash). We also skip
    // any failure on a `data:` URL — those are *our* splash/error pages
    // and treating their abort as a real failure causes infinite loops.
    if (errorCode === -3) return;
    if (/aborted/i.test(errorDesc || '')) return;
    if (validatedURL && validatedURL.startsWith('data:')) return;
    console.error('[Main] did-fail-load', errorCode, errorDesc, 'at', validatedURL);
    mainWindow.loadURL('data:text/html;charset=utf-8,' + encodeURIComponent(
      buildErrorHtml(TARGET_URL, `${errorDesc} (${errorCode})`)
    ));
  });
  mainWindow.webContents.on('did-finish-load', () => { didFinishOnce = true; });

  // Kick off the real site after a tiny delay so the splash is guaranteed
  // to paint at least one frame before being replaced. Without this, fast
  // local Vite servers blink the splash so quickly it feels glitchy.
  setTimeout(() => {
    console.log('[Main] Loading', TARGET_URL);
    mainWindow.loadURL(TARGET_URL).catch(err => {
      console.error('[Main] loadURL rejected:', err.message);
      // The did-fail-load handler above will normally catch this too, but
      // if loadURL itself synchronously rejects we paint the error here.
      if (!didFinishOnce) {
        mainWindow.loadURL('data:text/html;charset=utf-8,' + encodeURIComponent(
          buildErrorHtml(TARGET_URL, err.message)
        ));
      }
    });
  }, 250);

  if (isDev) {
    mainWindow.webContents.openDevTools({ mode: 'detach' });
  }
}

// Second-instance: another scanverse:// link was clicked while we're already
// running. Windows passes the URL as the last argv. Find it and navigate.
app.on('second-instance', (_event, argv) => {
  const protoUrl = argv.find(a => typeof a === 'string' && a.startsWith('scanverse://'));
  if (protoUrl) navigateFromProtocolUrl(protoUrl);
  if (mainWindow && !mainWindow.isDestroyed()) {
    if (mainWindow.isMinimized()) mainWindow.restore();
    mainWindow.focus();
  }
});

// macOS only — when a scanverse:// link is opened externally
app.on('open-url', (event, url) => {
  event.preventDefault();
  navigateFromProtocolUrl(url);
});

app.whenReady().then(async () => {
  // Clean up any installer .exe left in %TEMP% by a previous in-app update.
  // Runs before window creation so it's done by the time the user pokes
  // around (on the off-chance they'd notice anyway).
  cleanupStaleInstallers();

  await initRpc();
  createWindow();

  // If the app was launched VIA a scanverse:// URL (cold start), the URL is
  // in process.argv on Windows. Pick it up and navigate after the window
  // loads — small delay so loadURL has finished resolving the default page.
  const coldStartProtoUrl = process.argv.find(a =>
    typeof a === 'string' && a.startsWith('scanverse://')
  );
  if (coldStartProtoUrl) {
    setTimeout(() => navigateFromProtocolUrl(coldStartProtoUrl), 500);
  }

  // Start polling the online count (every 30 s) — initial fetch fires
  // shortly after the page has had time to load.
  setTimeout(pollOnlineCount, 3000);
  setInterval(pollOnlineCount, 30000);

  // Update check — fire after a longer delay so the dialog doesn't
  // pop in the user's face during the initial site load. Skipped in
  // dev so we don't get prompted while iterating on the wrapper.
  if (!isDev) {
    setTimeout(() => checkForUpdates(mainWindow).catch(() => {}), 8000);
  }

  app.on('activate', () => {
    if (BrowserWindow.getAllWindows().length === 0) createWindow();
  });
});

app.on('window-all-closed', () => {
  clearPresence();
  if (process.platform !== 'darwin') app.quit();
});

// IPC: page -> main, push rich presence data
ipcMain.on('presence:update', (_event, msg) => {
  if (!msg || typeof msg.route !== 'string') return;
  console.log('[Main] presence:update from page —', msg.route, JSON.stringify(msg.params));
  // Title bar consumes the rich data unconditionally — even with RPC off,
  // the user wants the page label to read "One Piece" rather than the
  // generic "Lecture en cours". The Discord push, on the other hand,
  // still respects the privacy toggle below.
  broadcastTitleBarContext(msg.route, msg.params || {});
  if (!rpcEnabled) return;
  // Cache the rich payload so wrapper-internal re-emissions (online-count
  // tick, focus events…) can preserve title/cover/author instead of
  // collapsing to the URL fallback.
  lastRichPayload = { route: msg.route, params: msg.params || {} };
  const payload = getPresenceForRoute(msg.route, msg.params || {}, { onlineCount });
  if (payload) updatePresence(payload);
});

ipcMain.on('presence:clear', () => {
  lastRichPayload = null;
  clearPresence();
});

ipcMain.on('presence:set-enabled', (_event, enabled) => {
  const next = !!enabled;
  if (next === rpcEnabled) return;
  rpcEnabled = next;
  console.log('[Main] RPC privacy →', rpcEnabled ? 'ENABLED' : 'DISABLED');
  if (!rpcEnabled) {
    lastRichPayload = null;
    clearPresence();
    return;
  }
  // Re-enable: immediately re-emit presence for the current URL so the user
  // doesn't have to navigate away and back to see Discord light up again.
  if (mainWindow && !mainWindow.isDestroyed()) {
    const url = mainWindow.webContents.getURL();
    if (url) emitPresenceFromUrl(url);
  }
});

/**
 * Bridge between the ScanVerse webview and the Electron main process.
 *
 * Exposes window.scanverse to the page so the React app can:
 *   - Detect it's running in the desktop wrapper
 *   - Push rich presence data (title, cover, etc.) for the current page
 *
 * Also injects a custom Discord-style title bar at the top of every page.
 * The title bar:
 *   - Hosts the SV logo + a contextual page label ("One Piece — Ch.1089",
 *     "Catalogue · Comics", etc.) on a dark background
 *   - Carries the OS-level drag region so the user can move the window
 *   - Leaves room on the right for the native min/max/close controls
 *     (painted by Electron via `titleBarOverlay`, see main.js)
 *   - Listens for `titlebar:context` IPC events to update its label —
 *     fires both on URL navigation and on rich data pushed by the
 *     React useDiscordPresence hook
 *
 * Only this minimal API is exposed to the page — no fs, no shell, no
 * node access.
 */
const { contextBridge, ipcRenderer } = require('electron');

contextBridge.exposeInMainWorld('scanverse', {
  isElectron: true,
  version: '0.1.0',
  /**
   * @param {string} route   one of: home | catalogue | manga | reader | profile |
   *                         friends | wrapped | admin | login | register | settings | notfound
   * @param {object} params  route-specific data (title, cover, chapter, etc.)
   */
  setPresence(route, params = {}) {
    if (typeof route !== 'string') return;
    console.log('[scanverse:preload] setPresence', route, params);
    ipcRenderer.send('presence:update', { route, params });
  },
  clearPresence() {
    ipcRenderer.send('presence:clear');
  },
  /**
   * Tell the main process whether Discord Rich Presence is allowed for the
   * current user. When disabled, the main process stops emitting presence
   * regardless of source (React hook OR URL detection) and clears any
   * existing activity. Backed by localStorage so it persists per device.
   */
  setRpcEnabled(enabled) {
    ipcRenderer.send('presence:set-enabled', !!enabled);
  },
});

// Sync the current privacy state with main as soon as the page loads, so
// the URL-based detection (which fires on every navigation) respects the
// toggle even if no React component has run useDiscordPresence yet.
window.addEventListener('DOMContentLoaded', () => {
  console.log('[scanverse:preload] bridge ready, window.scanverse is available');
  try {
    const disabled = localStorage.getItem('sv_discord_rpc_disabled') === '1';
    ipcRenderer.send('presence:set-enabled', !disabled);
  } catch { /* localStorage may be blocked */ }

  injectTitleBar();
});

// ──────────────────────────────────────────────────────────────────────────
// Custom title bar
// ──────────────────────────────────────────────────────────────────────────

const TITLE_BAR_HEIGHT = 32; // mirrors titleBarOverlay.height in main.js
// The native min/max/close icons sit on the right edge of the window via
// titleBarOverlay. We need to keep enough horizontal padding free in our
// custom bar so we don't paint behind them. Windows reserves ~140 px for
// the standard 3 controls; we use 150 to be safe with high-DPI rendering.
const NATIVE_CONTROLS_RESERVE = 150;

function injectTitleBar() {
  // Guard against double-injection — preload runs once per renderer but
  // an SPA navigation that triggered a full reload would call this again.
  if (document.getElementById('sv-titlebar')) return;

  // Stylesheet — kept inline so the bar paints with the very first frame
  // and there's no FOUC during the dark splash → site swap.
  const style = document.createElement('style');
  style.id = 'sv-titlebar-style';
  style.textContent = `
    /* Push the page content below the bar — the site's own floating
       navbar wrapper uses inline styles (position:fixed; top:16px) so
       Tailwind class selectors won't catch it; the JS pass below
       (shiftTopFixedElements) handles those case-by-case. body padding
       still helps non-fixed top content (the splash spinner etc.). */
    body { padding-top: ${TITLE_BAR_HEIGHT}px !important; }

    #sv-titlebar {
      position: fixed;
      top: 0; left: 0; right: 0;
      height: ${TITLE_BAR_HEIGHT}px;
      z-index: 2147483647;       /* sit above any in-page modal */
      display: flex;
      align-items: center;
      gap: 10px;
      padding: 0 ${NATIVE_CONTROLS_RESERVE}px 0 12px;
      background: #0a0a0f;
      border-bottom: 1px solid rgba(255,255,255,0.06);
      font-family: 'Syne', system-ui, -apple-system, Segoe UI, sans-serif;
      color: #f0f0f5;
      user-select: none;
      -webkit-user-select: none;
      /* Whole bar is draggable — the .sv-tb-no-drag children opt out for
         clickable elements. The native controls on the right paint over
         this bar but stay clickable because they live above the
         BrowserWindow's web contents layer. */
      -webkit-app-region: drag;
    }
    #sv-titlebar .sv-tb-no-drag { -webkit-app-region: no-drag; }

    #sv-titlebar .sv-tb-logo {
      display: inline-flex;
      align-items: baseline;
      gap: 1px;
      font-weight: 800;
      font-size: 13px;
      letter-spacing: -0.3px;
      color: #f0f0f5;
      flex-shrink: 0;
    }
    #sv-titlebar .sv-tb-logo .accent { color: #a855f7; }

    #sv-titlebar .sv-tb-divider {
      width: 1px;
      height: 14px;
      background: rgba(255,255,255,0.1);
      flex-shrink: 0;
    }

    #sv-titlebar .sv-tb-context {
      flex: 1;
      min-width: 0;
      font-size: 12px;
      font-weight: 500;
      color: #9090a8;
      white-space: nowrap;
      overflow: hidden;
      text-overflow: ellipsis;
    }
    #sv-titlebar .sv-tb-context strong {
      color: #f0f0f5;
      font-weight: 600;
    }
  `;
  document.head.appendChild(style);

  // Bar element. innerHTML is safe here — every interpolation is escaped
  // when we update the context label later via .textContent.
  const bar = document.createElement('div');
  bar.id = 'sv-titlebar';
  bar.innerHTML = `
    <span class="sv-tb-logo">Scan<span class="accent">Verse</span></span>
    <span class="sv-tb-divider"></span>
    <span class="sv-tb-context" id="sv-tb-context">Accueil</span>
  `;
  document.body.appendChild(bar);

  // React Router only owns the in-page area; in case the site itself
  // ever sets `position: fixed` on something at top: 0, our z-index
  // (max int) wins. No other guard needed.
}

// Update the label whenever main process broadcasts a context change.
// Receives { route, params, label } — we use `label` as the canonical
// human string, computed by titleBarLabelFor in main.js.
ipcRenderer.on('titlebar:context', (_event, msg) => {
  const ctx = document.getElementById('sv-tb-context');
  if (!ctx || !msg) return;
  // textContent (not innerHTML) — the label may include user-controlled
  // strings (manga titles, usernames) that we don't want HTML-rendered.
  ctx.textContent = msg.label || 'ScanVerse';
});

// ──────────────────────────────────────────────────────────────────────────
// Shift any fixed-positioned element pinned to the top edge so it doesn't
// sit underneath our injected title bar.
//
// The site's floating navbar uses an inline `style="position: fixed;
// top: 16px; …"` wrapper (no class), which means CSS class selectors
// won't catch it. Instead we walk the DOM, identify elements that are
// position:fixed with a top offset less than the title bar height, and
// add TITLE_BAR_HEIGHT to their `top` value via inline `!important`.
// Each shifted element gets a `data-sv-top-shifted` marker so we never
// double-shift, even across MutationObserver re-runs.
//
// The MutationObserver watches for nodes added to the body and for
// inline-style mutations on existing elements (the navbar wrapper's
// style attribute may be re-rendered by React on theme changes etc.)
// so newly-mounted toolbars/popovers also get the shift.
// ──────────────────────────────────────────────────────────────────────────

function shiftElementIfNeeded(el) {
  if (!el || el.nodeType !== 1) return;
  if (el.id === 'sv-titlebar') return;
  if (el.dataset.svTopShifted === '1') return;
  // Skip nodes outside the body (e.g. the title bar itself when re-checked,
  // and elements in <head>).
  if (!document.body || !document.body.contains(el)) return;
  const cs = getComputedStyle(el);
  if (cs.position !== 'fixed') return;
  const top = parseFloat(cs.top);
  if (!Number.isFinite(top)) return;
  if (top >= TITLE_BAR_HEIGHT) return; // already clear of the title bar
  // Don't touch full-screen overlays anchored at top:0 with bottom:0 —
  // shifting them down 32 px would create a 32 px gap at the bottom.
  // Only shift things that look like top-anchored bars (height < 200 px).
  if (el.offsetHeight > 0 && el.offsetHeight > 200 && parseFloat(cs.bottom) === 0) {
    return;
  }
  el.dataset.svTopShifted = '1';
  el.dataset.svOriginalTop = String(top);
  el.style.setProperty('top', `${top + TITLE_BAR_HEIGHT}px`, 'important');
}

function scanAndShiftFixedElements() {
  if (!document.body) return;
  // Scan the most likely suspects first — narrows the iteration cost.
  // Layout containers, semantic landmarks, and anything carrying a
  // `style` attribute (which is how the navbar wrapper expresses its
  // position:fixed in the live site).
  const candidates = document.querySelectorAll(
    'nav, header, aside, [role="banner"], [role="navigation"], [style*="fixed"], [class*="fixed"]'
  );
  candidates.forEach(shiftElementIfNeeded);
}

function startTopFixedShifter() {
  scanAndShiftFixedElements();

  const obs = new MutationObserver(muts => {
    let needsScan = false;
    for (const m of muts) {
      if (m.type === 'childList') {
        for (const n of m.addedNodes) {
          if (n.nodeType === 1) shiftElementIfNeeded(n);
        }
      } else if (m.type === 'attributes' && (m.attributeName === 'style' || m.attributeName === 'class')) {
        // Style/class change can flip an element to position:fixed at
        // top:0 — re-evaluate. Cheap enough to do per-mutation since
        // the predicate inside shiftElementIfNeeded short-circuits fast.
        const el = m.target;
        // Reset the marker so we re-evaluate after a style swap.
        if (el.dataset && el.dataset.svTopShifted === '1') {
          // If the element still has its shifted top, skip; otherwise re-shift.
          // Simplest: leave it shifted unless React removes the position:fixed.
        } else {
          shiftElementIfNeeded(el);
        }
      }
    }
    if (needsScan) scanAndShiftFixedElements();
  });
  obs.observe(document.body, {
    childList: true,
    subtree: true,
    attributes: true,
    attributeFilter: ['style', 'class'],
  });
  // Belt-and-braces — the React app may mount the navbar after our
  // initial scan, so we re-scan one more time after a tick. Cheap.
  setTimeout(scanAndShiftFixedElements, 500);
  setTimeout(scanAndShiftFixedElements, 1500);
}

// Kick the shifter off as soon as we have a body to work with.
if (document.readyState === 'loading') {
  window.addEventListener('DOMContentLoaded', startTopFixedShifter);
} else {
  startTopFixedShifter();
}

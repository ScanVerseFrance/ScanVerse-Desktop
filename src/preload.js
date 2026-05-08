/**
 * Bridge between the ScanVerse webview and the Electron main process.
 *
 * Exposes window.scanverse to the page so the React app can:
 *   - Detect it's running in the desktop wrapper
 *   - Push rich presence data (title, cover, etc.) for the current page
 *
 * Only this minimal API is exposed — no fs, no shell, no node access.
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
});

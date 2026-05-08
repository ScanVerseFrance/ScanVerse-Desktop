/**
 * ScanVerse — update checker.
 *
 * Hits the GitHub Releases API for `ScanVerseFrance/ScanVerse-Desktop` once
 * at startup, compares the latest tag against the installed version, and if
 * a newer one exists shows a native dialog with a "Télécharger" / "Plus
 * tard" choice. Picking download just opens the release page in the user's
 * default browser — no in-place update because our installer is custom and
 * doesn't follow the NSIS contract that electron-updater expects. Manual
 * re-run of the installer is the supported path for now.
 *
 * Why not electron-updater?
 *   It hard-codes NSIS-specific install args (`/S /NCRC ...`) when running
 *   the downloaded installer. Our custom installer doesn't speak those, so
 *   `quitAndInstall()` would just spawn it with bogus args. Adding silent-
 *   mode support to the installer is a future improvement; for a closed
 *   beta the manual re-run flow is fine and far less code.
 *
 * Failure is silent — if the network is down, the API rate-limits us, or
 * the release feed is empty, we just skip the check. No error popups.
 */

const { app, dialog, shell } = require('electron');

const REPO = 'ScanVerseFrance/ScanVerse-Desktop';
const RELEASES_API = `https://api.github.com/repos/${REPO}/releases/latest`;
const RELEASES_PAGE = `https://github.com/${REPO}/releases/latest`;

// Numeric semver compare. We only ship plain X.Y.Z tags so this is enough;
// no prerelease/build metadata handling needed.
function isNewer(latest, current) {
  const [la = 0, lb = 0, lc = 0] = String(latest).split('.').map(n => parseInt(n, 10) || 0);
  const [ca = 0, cb = 0, cc = 0] = String(current).split('.').map(n => parseInt(n, 10) || 0);
  if (la !== ca) return la > ca;
  if (lb !== cb) return lb > cb;
  return lc > cc;
}

async function fetchLatestRelease() {
  // 6-second timeout — don't make the user wait if GitHub is slow.
  const ctrl = new AbortController();
  const timer = setTimeout(() => ctrl.abort(), 6000);
  try {
    const r = await fetch(RELEASES_API, {
      headers: {
        'User-Agent': `ScanVerse-Desktop/${app.getVersion()}`,
        'Accept': 'application/vnd.github+json',
      },
      signal: ctrl.signal,
    });
    if (!r.ok) return null;
    return await r.json();
  } catch {
    return null;
  } finally {
    clearTimeout(timer);
  }
}

/**
 * Run the update check. Show a dialog only if a newer version is published.
 * Idempotent — safe to call once per app launch.
 *
 * @param {BrowserWindow|null} parent — optional window to anchor the dialog.
 */
async function checkForUpdates(parent) {
  const release = await fetchLatestRelease();
  if (!release || !release.tag_name) {
    console.log('[Update] no release feed (yet) — skipping');
    return;
  }
  if (release.draft || release.prerelease) {
    console.log('[Update] latest release is draft/prerelease — skipping');
    return;
  }
  const latest = release.tag_name.replace(/^v/i, '');
  const current = app.getVersion();
  console.log(`[Update] current=${current}, latest=${latest}`);
  if (!isNewer(latest, current)) return;

  // Prefer the installer asset's direct URL so the browser starts the
  // download immediately rather than dropping the user on the release page
  // where they'd have to find the right file in a list.
  const installer = (release.assets || []).find(a =>
    /Setup.*\.exe$/i.test(a.name)
  );
  const downloadUrl = installer?.browser_download_url || RELEASES_PAGE;

  const result = await dialog.showMessageBox(parent || null, {
    type: 'info',
    title: 'Mise à jour disponible',
    message: `ScanVerse ${latest} est disponible`,
    detail:
      `Tu utilises actuellement la version ${current}.\n\n` +
      `Veux-tu télécharger la mise à jour maintenant ? Le téléchargement ` +
      `s'ouvrira dans ton navigateur. Lance ensuite le nouvel installateur ` +
      `pour mettre à jour — tes paramètres sont conservés.`,
    buttons: ['Télécharger', 'Plus tard'],
    defaultId: 0,
    cancelId: 1,
    noLink: true,
  });
  if (result.response === 0) {
    shell.openExternal(downloadUrl);
  }
}

module.exports = { checkForUpdates };

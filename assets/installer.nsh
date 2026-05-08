; Custom NSIS hooks for ScanVerse installer.
;
; electron-builder injects this file via the `include` option in
; package.json → build.nsis. Macros that start with `customXxx` are the
; documented extension points — anything else is just plain NSIS that
; runs in the same script context.
;
; Reference: https://www.electron.build/configuration/nsis#custom-nsis-script

; ── Branding text shown above the standard wizard pages ─────────────────
; The default is "Nullsoft Install System v3.x" or empty depending on the
; theme. Replace it with our own footer so the wizard window doesn't look
; generic.
!define MUI_BRANDINGTEXT "ScanVerse — Lecture manga & comics communautaire"

; ── Welcome / Finish page customisation ─────────────────────────────────
!define MUI_WELCOMEPAGE_TITLE          "Bienvenue sur l'installation de ScanVerse"
!define MUI_WELCOMEPAGE_TEXT           "Cet assistant va installer ScanVerse sur votre ordinateur.$\r$\n$\r$\nL'application est un client desktop léger qui se connecte à scanverse-beta.vercel.app et active la présence Discord (manga en cours, chapitre, page) pendant que vous lisez.$\r$\n$\r$\nCliquez sur Suivant pour continuer."

!define MUI_FINISHPAGE_TITLE           "Installation terminée"
!define MUI_FINISHPAGE_TEXT            "ScanVerse est prêt. Lancez l'application pour découvrir le catalogue manga & comics, suivre vos amis et activer la présence Discord."
!define MUI_FINISHPAGE_RUN_TEXT        "Lancer ScanVerse maintenant"

; Uninstaller welcome / finish — same idea, French copy.
!define MUI_UNWELCOMEPAGE_TITLE        "Désinstallation de ScanVerse"
!define MUI_UNWELCOMEPAGE_TEXT         "Cet assistant va désinstaller ScanVerse de votre ordinateur.$\r$\n$\r$\nVos paramètres et préférences (cache navigateur, présence Discord) seront conservés au cas où vous réinstalleriez. Cliquez sur Suivant pour continuer."

!define MUI_UNFINISHPAGE_TITLE         "Désinstallation terminée"
!define MUI_UNFINISHPAGE_TEXT          "ScanVerse a été retiré de votre ordinateur. Vous pouvez fermer cette fenêtre."

; ── Component description in Add/Remove Programs ────────────────────────
!macro customHeader
  !system "echo Building ScanVerse installer (custom branding active)"
!macroend

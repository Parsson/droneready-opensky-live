# FlyMonitor PWA-Update

Enthaltene Änderungen:

- `index.html` mit PWA-/Apple-Meta-Tags, Manifest und App-Icons
- `src/main.jsx` mit Service-Worker-Registrierung und Update-Erkennung
- `public/manifest.webmanifest`
- `public/sw.js`
- `public/logo_neu.png`
- `public/icons/*` als 192/512-PNG und maskable Icons
- `src/App.jsx` mit Update-Hinweis und FlyMonitor-Briefkopf in den jsPDF-Exporten

Einbau:

1. Dateien in dein Projekt kopieren.
2. Falls dein Build-System alles aus `public` in das Webroot kopiert, muss `sw.js` im Webroot landen: `/sw.js`.
3. `npm run build` ausführen und danach mobil testen: Chrome/Edge „App installieren“ oder iOS Safari „Zum Home-Bildschirm“.

Hinweis: Externe Live-Daten funktionieren offline naturgemäß nur eingeschränkt; die App-Shell und zuletzt gecachte lokale Assets bleiben verfügbar.

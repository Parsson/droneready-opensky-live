# DroneReady OpenSky Live

Vollständiges Projekt-ZIP mit echter OpenSky-Live-Abfrage.

Enthalten:
- echte OpenSky-API-Abfrage im Bereich des Standorts
- automatische Aktualisierung alle 30 Sekunden
- Button "OpenSky jetzt neu laden"
- OpenSky-Limit-Hinweis
- keine Demo-Flugzeuge als Fallback

## VS Code Schritte

1. ZIP entpacken
2. Ordner in VS Code öffnen
3. Terminal:

npm install
npm run dev

4. Lokal testen:
http://localhost:5173

5. Für Server bauen:

npm run build

6. Inhalt aus `dist` hochladen nach:
/public/drohnenwetter/

7. Test:
https://www.pxfoto.de/drohnenwetter/

Hinweis: OpenSky ist kostenlos, hat aber Limits. Wenn keine Flugzeuge erscheinen, später erneut testen oder auf einen Standort mit Flugverkehr wechseln.

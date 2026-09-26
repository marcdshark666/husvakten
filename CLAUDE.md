# Husvakten – regler för AI-agenter (Claude, Codex, Antigravity)

Läs `../.agents/PROTOKOLL.md` först. Tillståndsnivå: standard (fri) – push/deploy OK,
men **inget som kostar pengar** utan Marcs ja.

## Vad projektet är
Statisk sajt (GitHub Pages, gren `main`, rot `/`) som håller koll på om hemmet är rent.
Hushållet = Marc och Ada. All UI på svenska, mobil först (Samsung Fold). Se `README.md`.

## Arkitektur – rör rätt fil
- `js/karta.js` – planritningen (egen SVG), rum, robotfria zoner, `STANDARDOBJEKT`.
  `verktyg/logga.js` läser `STANDARDOBJEKT` härifrån – nytt standardobjekt = en rad här.
- `js/valv.js` – inloggningen + WebCrypto-dekryptering av `data/valv/`; laddar karta/ml/hushall/app efter upplåsning.
- `verktyg/valv.js` – samma valvformat i Node (kryptera/dekryptera, `las`, `foto`, `migrera`).
- `js/hushall.js` – händelselogg (delad krypterad logg + lokala), härledd status, tilldelning, statistik, rättvis fördelning.
- `js/ml.js` – TF.js + MobileNet v2 + KNN (laddas lat från cdn.jsdelivr.net). Inga API-nycklar.
- `js/lagring.js` – localStorage + IndexedDB, allt i try/catch.
- `js/app.js` – UI: lista, objektblad, bildbedömning, timer, flikar, export/import. `HV_APP` på window för test.
- `verktyg/logga.js` – lägger till händelser i valvet, skalar och strippar bilder (sharp) och skriver dem krypterade.

## Regler
- **Valvet:** all delad data ligger krypterad i `data/valv/` (AES-256-GCM, PBKDF2-SHA256 600k, se README).
  Lösenordet finns BARA i `~/.husvakten/losen.txt` – skriv det aldrig i repot, commits, loggar eller rapporter.
  Lägg aldrig tillbaka okrypterad `data/events.json` eller `data/foton/`. Läs loggen med `node verktyg/valv.js las`.
- **Repot är publikt.** Inga skärmbilder av bostaden, inga originalfoton. Foton går ENDAST via
  `verktyg/logga.js` (max 1280 px, q75, all metadata bort, kontrolleras efteråt). Lägg aldrig in en bild för hand.
- Status härleds ur senaste händelsen; en utgången timer ger objektets `efterTimer` (ren/påminn).
- "Fel – det var …" skapar en händelse med `ersatter` = den felaktiga händelsens id (den räknas då inte).
- Statistik räknar insatser: status `pagar` (startat) och `ren`. `uppgift` blir egen rad.
- Commit-meddelanden avslutas med `Co-Authored-By: Claude Opus 5.5 (1M context) <noreply@anthropic.com>`.

## Verifiera
`node --check js/*.js verktyg/logga.js`, sedan röktest i headless Chrome (playwright-core) mot en lokal server.
Efter push: `curl -s -o /dev/null -w "%{http_code}" https://marcdshark666.github.io/husvakten/` → 200.

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
- `verktyg/valv.js` – samma valvformat i Node (kryptera/dekryptera, `las`, `foto`, `skriv`, `lasfil`, `migrera`, `byt-losen`).
- `js/robot.js` – 🤖 Robot-fliken: status, förbrukningsdelar, 2D-karta med SVG-överlägg, 3D (three.js lat från jsdelivr).
- `verktyg/roborock/robo.py` (+ `publicera.py`) – läser Roborock S7 MaxV (bara läskommandon). `robo.py publicera`
  hämtar allt, bygger ren kartbild + `robot.json` utanför repot och krypterar in i `data/valv/robot/`.
  `synka.py` = schemalagd uppgift "Husvakten Robotsynk" (var 30:e min 07–23), pushar bara vid ändring, max 1/h.
- `verktyg/roborock/live.py` – 📡 Vaktloggen (read-only): startas av synka.py när roboten är igång, läser status+karta
  var 90:e s, skriver tidslinjen `robot/logg.json` (krypterad; klartext bara i `~/.roborock/vaktlogg.json`), hämtar
  hinderfoton + AI-bedömning (`claude -p --model haiku`, aldrig API), golvvakten loggar "Golvet – <rum>" som person
  **Robot** (räknas aldrig i statistik), Telegram-notiser max 1/typ/10 min. `--simulera` skriver bara i `~/.roborock/sim/`.
- `js/hem.js` – 🎛 Styr-fliken (iPaden): knappar för Roborock, projektor och lampor via **hemservern** `hem/server.py`
  (127.0.0.1:5193, utåt BARA `tailscale serve --set-path /hem` → https://…ts.net/hem, aldrig Funnel). Samma
  inloggning som Spelkontroll (bearer-token, hashfilen i manadsavrakning), FAST whitelist av åtgärder, rate-limit,
  revisionslogg `hem/data/atgarder.log` (gitignorerad). SwitchBot-token/secret + enhets-id:n ligger ENBART i
  `~/.husvakten/hem.json`; serveradressen krypterad i valvet (`hem/konfig.json`). Se `hem/README.md`.
  Roboten startar aldrig härifrån utan ett knapptryck. Vakten: `hem/vakt/server_vakt.ps1` (jobb Husvakten-Hem-Server).
- `js/hushall.js` – händelselogg (delad krypterad logg + lokala), härledd status, tilldelning, statistik, rättvis fördelning.
- `js/ml.js` – TF.js + MobileNet v2 + KNN (laddas lat från cdn.jsdelivr.net). Inga API-nycklar.
- `js/lagring.js` – localStorage + IndexedDB, allt i try/catch.
- `js/app.js` – UI: lista, objektblad, bildbedömning, timer, flikar, export/import. `HV_APP` på window för test.
- `verktyg/logga.js` – lägger till händelser i valvet, skalar och strippar bilder (sharp) och skriver dem krypterade.

## Regler
- **Valvet:** all delad data ligger krypterad i `data/valv/` (AES-256-GCM, PBKDF2-SHA256, iterationer i meta.json (2M), se README).
  Lösenordet finns BARA i `~/.husvakten/losen.txt` – skriv det aldrig i repot, commits, loggar eller rapporter.
  Lägg aldrig tillbaka okrypterad `data/events.json` eller `data/foton/`. Läs loggen med `node verktyg/valv.js las`.
- **Repot är publikt.** Inga skärmbilder av bostaden, inga originalfoton. Foton går ENDAST via
  `verktyg/logga.js` (max 1280 px, q75, all metadata bort, kontrolleras efteråt). Lägg aldrig in en bild för hand.
- **Robotkartan visar planlösningen** – får bara ligga krypterad (`data/valv/robot/*.enc`). Kolla `git ls-files | grep -i robot`.
- Status härleds ur senaste händelsen; en utgången timer ger objektets `efterTimer` (ren/påminn).
- "Fel – det var …" skapar en händelse med `ersatter` = den felaktiga händelsens id (den räknas då inte).
- Statistik räknar insatser: status `pagar` (startat) och `ren`. `uppgift` blir egen rad.
- Commit-meddelanden avslutas med `Co-Authored-By: Claude Opus 5.5 (1M context) <noreply@anthropic.com>`.

## Verifiera
`node --check js/*.js verktyg/logga.js`, sedan röktest i headless Chrome (playwright-core) mot en lokal server.
Efter push: `curl -s -o /dev/null -w "%{http_code}" https://marcdshark666.github.io/husvakten/` → 200.

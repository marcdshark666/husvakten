# Hemservern – 🎛 Styr-fliken (iPaden som husets kontrollcenter)

Husvaktens sida får en flik **🎛 Styr** med stora knappar för Roborock, projektorn (SwitchBot) och lampor.
Knapparna går till en **lokal server på Marcs dator** (`hem/server.py`) som bara nås via Tailscale.
Den publika GitHub-sidan fungerar som vanligt utan servern (fliken visar då "Inte ansluten").

```
iPad (Tailscale-appen) ──https──▶ https://<dator>.ts.net/hem ──▶ 127.0.0.1:5193 hem/server.py
                                                                   ├─ Roborock (verktyg/roborock/robo.py, token i ~/.roborock/)
                                                                   └─ SwitchBot Cloud API v1.1 (token/secret i ~/.husvakten/hem.json)
```

## Öppna på iPaden
1. Installera **Tailscale** (gratis) på iPaden och logga in med samma konto som datorn och telefonen.
2. Öppna `https://<dator>.ts.net/hem/` (hela Husvakten, samma origin) **eller** den vanliga
   `https://marcdshark666.github.io/husvakten/` → fliken 🎛 Styr (anropar hemservern cross-origin, CORS).
3. Logga in som vanligt – samma e-post/lösenord loggar också in på hemservern (token sparas på iPaden i 30 dagar).

Adressen till hemservern ligger krypterad i valvet (`data/valv/hem/konfig.json.enc`) och kan även skrivas in
i fliken (sparas i localStorage). Den står aldrig i klartext i repot.

## Vad Marc måste lägga till (en gång)
**SwitchBot (projektor-knappen, lampor via SwitchBot):**
1. SwitchBot-appen → Profil → Inställningar → tryck 10× på *App Version* → *Developer Options* → kopiera **Token** och **Secret**.
2. Skriv dem i `C:\Users\PC\.husvakten\hem.json` (`"switchbot": {"token": "…", "secret": "…"}`).
3. `python hem/switchbot.py lista --konfig` skriver ut färdiga `"enheter"`-poster – klistra in dem i `hem.json`
   (ändra `namn`, `ikon`, `grupp` som du vill). `"status": true` på lampor/plugg visar på/av i fliken.
4. Servern läser `hem.json` vid varje anrop – ingen omstart behövs.

**Lampor av annat märke** (Hue, IKEA, Tuya/Smart Life, Govee …): säg vilket märke – då byggs en leverantör till.
Bäst är lampor som redan syns i SwitchBot-appen (SwitchBot-lampor/plugg, eller IR-lampor via en SwitchBot-hub).

**Alexa:** det finns inget gratis officiellt API för att styra ett Alexa-hem. Rekommendation: styr enheterna direkt
(ovan) och låt Alexa-rösten vara kvar i Alexa-appen. (Det inofficiella `alexa-remote` bygger på inloggningskakor
och går sönder ofta – inte byggt.)

## Säkerhet
- Lyssnar **bara** på 127.0.0.1:5193. Utåt enbart `tailscale serve --bg --set-path /hem http://127.0.0.1:5193`
  (tailnet only, **aldrig Funnel**). Inget LAN-läge: Husvaktens valv kräver WebCrypto = https.
- Inloggning som Spelkontroll: samma hashfil (`manadsavrakning/data/inloggning.json`), 5 fel/15 min per IP → 429.
  Bearer-token (ingen kaka), sessioner i `hem/data/sessioner.json` (gitignorerad).
- CORS/Origin: bara `https://marcdshark666.github.io` och servern själv. Allt annat → 403.
- **Fast whitelist**: `robot_start/paus/stopp/docka/rum`, `enhet` (id ur hem.json + kommando ur
  `press/turnOn/turnOff/toggle`), `scen`. Ingen text ur förfrågan blir ett kommando. Rum-id:n valideras mot robotens karta.
- Rate-limit 20 åtgärder/min per session, 3 s per enhet (8 s för Bot-tryck). Robotstart kräver två tryck i fliken.
- Revisionslogg `hem/data/atgarder.log` (vem/när/vad – aldrig hemligheter). `GET /api/logg` visar de senaste raderna.
- Roboten startar **aldrig** av sig själv härifrån – bara på knapptryck (Marcs regel 2026-09-26).

## Drift
```
python -X utf8 hem/server.py                     # starta för hand (Ctrl+C stoppar)
powershell -NoProfile -ExecutionPolicy Bypass -File hem\vakt\installera.ps1   # schemalagt jobb Husvakten-Hem-Server
powershell -NoProfile -ExecutionPolicy Bypass -File hem\vakt\server_vakt.ps1 -Status
curl http://127.0.0.1:5193/api/halsa             # {"ok": true}
```
Jobbet startar via dold VBS-launcher (`C:\Users\PC\.claude\tools\hidden-launchers\Husvakten-Hem-Server.vbs`),
vid inloggning + var 5:e minut; vakten rör aldrig en server som redan lyssnar. Loggar i `hem/data/vakt/`.

## API
```
GET  /api/halsa                 {"ok":true}
POST /api/logga-in              {"epost","losen"} → {"token","giltig_sek"}
POST /api/logga-ut
GET  /api/status[?farsk=1]      {"robot":{…,"rum":[…]}, "konfig":{enheter utan deviceId, scener}, "enheter":{id: status}}
GET  /api/logg                  {"rader":[…]}
POST /api/atgard                {"atgard":"robot_start"|"robot_paus"|"robot_stopp"|"robot_docka"}
                                {"atgard":"robot_rum","rum":[16]}
                                {"atgard":"enhet","id":"projektor","kommando":"press"}
                                {"atgard":"scen","id":"filmkvall"}
```

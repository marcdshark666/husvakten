# Husvakten 🏠

Håller koll på om hemmet är rent. Mobil först (Samsung Fold), all text på svenska.

**Live:** https://marcdshark666.github.io/husvakten/

## Vad den gör
- **Karta** – egen stiliserad planritning (SVG, förenklad – inga skärmbilder/foton av bostaden) med
  vardagsrum/kök, sovrum, lilla rummet, badrum och balkong. Robotfria zoner (balkongen, lampbordet med
  luftrenaren, kablarna i sovrummet och kabelhörnan vid soffan) är streckade.
- **Objekt** med status **SMUTSIG** (pulserar rött), **PÅGÅR** (gult + nedräkning) och **REN** (grönt).
  Rum och zoner färgas efter status. Egna objekt läggs till och placeras med ett tryck på kartan.
- **Hushållet** – Marc och Ada. Varje händelse sparas med vem som gjorde den (valet minns per telefon).
  Uppgifter kan tilldelas, och **⚖️ Rättvis fördelning** föreslår att den som gjort minst i veckan tar nästa.
- **Statistik** – vecka/månad/allt per person, vem gjorde mest, per objekt och per uppgiftstyp.
- **Galleri** – alla bilder som följt med en händelse, senast först.
- **Bildbedömning som lär sig** – TensorFlow.js + MobileNet (feature extractor) + KNN per objekt, helt i
  webbläsaren (cdn.jsdelivr.net). Märk exempel (ren/smutsig; för maskiner tom/fylld/startad/ren disk – plocka ur),
  rätta med "Fel – det var …". Säkerhet visas i procent; för få exempel → sätt status manuellt.
- **Timer** som överlever omladdning (sluttiden sparas). När den går ut blir maskinen REN eller så kommer en påminnelse.

## Inloggning och valvet 🔒
Hela sajten kräver inloggning (e-post + lösenord) vid varje besök. Repot är publikt, så den delade datan
ligger **krypterad** i `data/valv/` – utan rätt uppgifter går den inte att läsa, varken på sajten eller i repot.
- Nyckel: PBKDF2-SHA256 (iterationer + salt i `data/valv/meta.json`, nu 2 000 000; min 600 000) av `epost (gemener) + "
" + lösenord`.
- Filer: AES-256-GCM, `[0x01][IV 12 byte][chiffertext + tagg]`, AAD = logiskt filnamn.
- Webbläsaren (`js/valv.js`, WebCrypto) dekrypterar i minnet; lösenordet sparas aldrig (inte i localStorage/sessionStorage).
  Appens skript laddas först efter upplåsning.
- Node (`verktyg/valv.js`) läser lösenord/e-post ur `~/.husvakten/losen.txt` och `epost.txt` – **utanför repot**.
  `node verktyg/valv.js las` skriver ut loggen; `node verktyg/valv.js foto <namn> <utfil>` dekrypterar en bild (utanför repot).
- Byt lösenord / höj iterationer: lägg ev. nytt lösenord i `~/.husvakten/losen-nytt.txt`, kör
  `node verktyg/valv.js byt-losen --iter 2000000`. Allt krypteras om med nytt salt, verifieras innan filerna byts,
  gamla filer kopieras till `~/.husvakten/valv-backup-<tid>/` och `losen-nytt.txt` blir `losen.txt` först när allt är klart.
  Sajten läser iterationerna ur `meta.json`. Commita sedan `data/valv/`.
- Sajten har `noindex, nofollow` + `robots.txt` som stänger ute sökmotorer.
- Gamla okrypterade `data/events.json` och `data/foton/` togs bort 2026-09-26 men finns kvar i git-historiken.

## Data
| Var | Vad |
|-----|-----|
| `data/valv/events.json.enc` (repo, krypterad) | Delad händelselogg, tilldelningar, delade träningsbilder. Dekrypteras vid varje laddning. |
| `data/valv/foton/<namn>.jpg.enc` (repo, krypterad) | Nedskalade JPEG (max 1280 px, q75) **utan EXIF/GPS**. I loggen heter de `data/foton/<namn>.jpg`. |
| `data/valv/meta.json` (repo, publik) | Salt, iterationer, format – inga hemligheter. |
| localStorage | Objekt, lokala händelser, tilldelningar, vald person. |
| IndexedDB | Träningsexempel (embeddings + miniatyrer) och lokala foton. |

Lokala händelser syns bara på telefonen där de gjordes tills de loggas i den delade (krypterade) loggen.
**Meny → Exportera** sparar allt lokalt som JSON; **Importera** läser tillbaka det.

## Logga en händelse (vakthunden / för hand)
```bash
npm install          # en gång – installerar sharp
node verktyg/logga.js --objekt tvattmaskin --status pagar --person Marc \
  --timer 43 --notis "30° Mörk tvätt" --bild foto.jpg
node verktyg/logga.js --objekt diskmaskin --status ren --person Marc \
  --uppgift "Plocka ur disken" --lar-in renfull --bild foto.jpg
git add data && git commit -m "Husvakten: ny händelse" && git push
```
Loggen och bilden skrivs krypterat i `data/valv/` (kräver `~/.husvakten/losen.txt`). `--dry-run` skriver inget.
Tid = `--tid` → bildens EXIF-tid (Europe/Stockholm) → nu. Skriptet vägrar om metadata finns kvar i bilden.

## Köra lokalt
Statisk sajt, inget byggsteg: `npx serve .` och öppna http://localhost:3000 (WebCrypto kräver localhost/https).

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

## Data
| Var | Vad |
|-----|-----|
| `data/events.json` (repo, publikt) | Delad händelselogg, tilldelningar, delade träningsbilder. Läses vid varje laddning. |
| `data/foton/` (repo, publikt) | Nedskalade JPEG (max 1280 px, q75) **utan EXIF/GPS**. |
| localStorage | Objekt, lokala händelser, tilldelningar, vald person. |
| IndexedDB | Träningsexempel (embeddings + miniatyrer) och lokala foton. |

Lokala händelser syns bara på telefonen där de gjordes tills de loggas i `data/events.json`.
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
Tid = `--tid` → bildens EXIF-tid (Europe/Stockholm) → nu. Skriptet vägrar om metadata finns kvar i bilden.

## Köra lokalt
Statisk sajt, inget byggsteg: `npx serve .` och öppna http://localhost:3000.

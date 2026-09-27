#!/usr/bin/env node
/* Husvakten – lägg till en händelse i den delade loggen (krypterad: data/valv/events.json.enc).
 *
 * Används av Hushållsvakthunden (Vakthund 10) och för hand:
 *   node verktyg/logga.js --objekt tvattmaskin --status pagar --person Marc \
 *        [--bild foto.jpg] [--timer 43] [--tid 2026-09-26T08:51:51+02:00] [--notis "30° Mörk tvätt"] \
 *        [--uppgift "Plocka ur disken"] [--lar-in renfull] [--tilldela Ada] [--vakt vakt.json] [--dry-run]
 *
 * --person: Marc | Ada | Robot (Robot = golvvakten; räknas inte i statistik/rättvis fördelning).
 *
 * --status: smutsig | pagar (pågår) | ren, eller etiketterna tom/fylld/startad.
 * --tid:    utelämnad → bildens EXIF-tid (tolkas som Europe/Stockholm) → annars nu.
 * --bild:   skalas till max 1280 px lång sida, JPEG kvalitet 75, ALL metadata (EXIF/GPS/XMP/ICC) tas bort.
 *           Resultatet kontrolleras efteråt – skriptet vägrar om metadata finns kvar.
 * --vakt:   JSON-fil från verktyg/roborock/patrull.py (vaktrundans AI-klassning av ett robotfoto) → handelse.vakt.
 *           Bara kända fält sparas (runda, etikett, typ, rum, robotEtikett, objekt, kategori, atgard, sakerhet,
 *           overens, sammanfattning, minuter, dockad, besok).
 * --uppgift: uppgiftstyp som räknas som egen rad i statistiken.
 * --lar-in:  lägg även bilden som delad träningsbild med denna etikett
 *            (ren | smutsig | tom | fylld | startad | renfull). Webbläsaren räknar fram embeddingen.
 * Valvet: loggen och bilderna skrivs KRYPTERADE via verktyg/valv.js (lösenord i ~/.husvakten/losen.txt,
 *         aldrig i repot). Ingen okrypterad bild eller logg hamnar i data/.
 * Pushar INTE – det gör den som anropar (git add data && git commit && git push).
 */
'use strict';
const fs = require('fs');
const path = require('path');
const vm = require('vm');
const valv = require('./valv');

const ROT = path.resolve(__dirname, '..');
const PERSONER = ['Marc', 'Ada', 'Robot']; // Robot = robotdammsugarens golvvakt (verktyg/roborock/live.py)
const TILLDELBARA = ['Marc', 'Ada'];
const ETIKETTER = ['ren', 'smutsig', 'tom', 'fylld', 'startad', 'renfull'];
const STATUSALIAS = {
  smutsig: 'smutsig', fylld: 'smutsig', dirty: 'smutsig',
  pagar: 'pagar', 'pågår': 'pagar', startad: 'pagar', igang: 'pagar', 'igång': 'pagar',
  ren: 'ren', tom: 'ren', klar: 'ren', klart: 'ren',
};

function fel(msg) {
  console.error('logga.js: ' + msg);
  process.exit(1);
}

function lasArgs(argv) {
  const a = {};
  for (let i = 0; i < argv.length; i++) {
    const k = argv[i];
    if (!k.startsWith('--')) fel('okänt argument: ' + k);
    const namn = k.slice(2);
    if (namn === 'dry-run') {
      a.dryRun = true;
      continue;
    }
    const v = argv[i + 1];
    if (v === undefined || v.startsWith('--')) fel('saknar värde för ' + k);
    a[namn] = v;
    i++;
  }
  return a;
}

/** Standardobjekten hämtas ur js/karta.js så sajt och verktyg aldrig glider isär. */
function lasObjekt(data) {
  const kod = fs.readFileSync(path.join(ROT, 'js', 'karta.js'), 'utf8');
  const sandbox = { window: {} };
  vm.runInNewContext(kod, sandbox, { filename: 'karta.js' });
  const std = sandbox.window.HV.karta.STANDARDOBJEKT;
  const extra = Array.isArray(data.objekt) ? data.objekt : [];
  return [...std, ...extra.filter((e) => !std.some((s) => s.id === e.id))];
}

function hittaObjekt(lista, q) {
  const n = String(q).toLowerCase().trim();
  const norm = (s) => s.toLowerCase().normalize('NFD').replace(/[̀-ͯ]/g, '');
  return (
    lista.find((o) => o.id === n) ||
    lista.find((o) => o.namn.toLowerCase() === n) ||
    lista.find((o) => norm(o.namn).includes(norm(n)) || norm(o.id).includes(norm(n)))
  );
}

/** Offset (ms) för Europe/Stockholm vid ett visst UTC-ögonblick. */
function stockholmOffset(utcMs) {
  const f = new Intl.DateTimeFormat('en-US', {
    timeZone: 'Europe/Stockholm', hourCycle: 'h23',
    year: 'numeric', month: '2-digit', day: '2-digit', hour: '2-digit', minute: '2-digit', second: '2-digit',
  });
  const p = Object.fromEntries(f.formatToParts(new Date(utcMs)).map((x) => [x.type, x.value]));
  const lokal = Date.UTC(+p.year, +p.month - 1, +p.day, +p.hour, +p.minute, +p.second);
  return lokal - Math.floor(utcMs / 1000) * 1000;
}

function stockholmTillUtc(y, mo, d, h, mi, s) {
  const gissning = Date.UTC(y, mo - 1, d, h, mi, s);
  let utc = gissning - stockholmOffset(gissning);
  utc = gissning - stockholmOffset(utc); // justera runt sommartidsskiftet
  return utc;
}

/** Läs fototid ur EXIF (DateTimeOriginal/DateTime). Returnerar ms eller null. */
function exifTid(exifBuf) {
  if (!exifBuf) return null;
  const txt = exifBuf.toString('latin1');
  const m = txt.match(/(\d{4}):(\d{2}):(\d{2}) (\d{2}):(\d{2}):(\d{2})/);
  if (!m) return null;
  const [, y, mo, d, h, mi, s] = m.map(Number);
  if (y < 2000 || mo < 1 || mo > 12) return null;
  return stockholmTillUtc(y, mo, d, h, mi, s);
}

function stamp(ms) {
  const d = new Date(ms + stockholmOffset(ms));
  const p = (n) => String(n).padStart(2, '0');
  return d.getUTCFullYear() + p(d.getUTCMonth() + 1) + p(d.getUTCDate()) + '-' + p(d.getUTCHours()) + p(d.getUTCMinutes()) + p(d.getUTCSeconds());
}

function isoStockholm(ms) {
  const off = stockholmOffset(ms);
  const d = new Date(ms + off);
  const p = (n) => String(n).padStart(2, '0');
  const tecken = off >= 0 ? '+' : '-';
  const oh = Math.floor(Math.abs(off) / 3600000);
  const om = Math.floor((Math.abs(off) % 3600000) / 60000);
  return d.toISOString().slice(0, 19) + tecken + p(oh) + ':' + p(om);
}

/** Skala + strippa bilden i minnet. Returnerar { buf, bredd, hojd, bytes } – skrivs sedan krypterad. */
async function behandlaBild(sharp, fil, mal) {
  const buf = await sharp(fil)
    .rotate() // använd EXIF-orienteringen innan metadata kastas
    .resize({ width: 1280, height: 1280, fit: 'inside', withoutEnlargement: true })
    .jpeg({ quality: 75, mozjpeg: true })
    .toBuffer(); // sharp skriver ingen metadata om inte withMetadata() anges
  const meta = await sharp(buf).metadata();
  const rester = [];
  if (meta.exif) rester.push('EXIF');
  if (meta.xmp) rester.push('XMP');
  if (meta.iptc) rester.push('IPTC');
  if (meta.icc) rester.push('ICC');
  if (buf.includes(Buffer.from('Exif\0\0'))) rester.push('Exif-segment');
  if (buf.includes(Buffer.from('GPS'))) rester.push('GPS-sträng');
  if (rester.length) {
    fel('metadata fanns kvar i ' + mal + ' (' + rester.join(', ') + ') – inget loggades');
  }
  return { buf, bredd: meta.width, hojd: meta.height, bytes: buf.length };
}

/** Vaktrundans metadata (patrull.py) – bara kända fält, korta strängar. */
function lasVakt(fil) {
  let d;
  try {
    d = JSON.parse(fs.readFileSync(fil, 'utf8'));
  } catch (e) {
    fel('--vakt: kunde inte läsa ' + fil + ': ' + e.message);
  }
  const str = (v, n) => (v === undefined || v === null ? undefined : String(v).slice(0, n));
  const KAT = ['plocka_upp', 'smutsigt', 'rent', 'annat'];
  const ut = {
    runda: str(d.runda, 40),
    etikett: str(d.etikett, 80),
    typ: ['foto', 'rum', 'karta'].includes(d.typ) ? d.typ : 'foto',
    rum: str(d.rum, 40),
    robotEtikett: str(d.robotEtikett, 60),
    objekt: str(d.objekt, 80),
    kategori: KAT.includes(d.kategori) ? d.kategori : undefined,
    atgard: str(d.atgard, 100),
    sakerhet: Number.isFinite(Number(d.sakerhet)) ? Math.max(0, Math.min(1, Number(d.sakerhet))) : undefined,
    overens: typeof d.overens === 'boolean' ? d.overens : undefined,
    minuter: Number.isFinite(Number(d.minuter)) ? Number(d.minuter) : undefined,
    dockad: typeof d.dockad === 'boolean' ? d.dockad : undefined,
  };
  if (d.sammanfattning && typeof d.sammanfattning === 'object') {
    ut.sammanfattning = {};
    for (const [rum, s] of Object.entries(d.sammanfattning).slice(0, 12)) {
      ut.sammanfattning[String(rum).slice(0, 40)] = {
        plocka_upp: Number(s.plocka_upp) || 0, smutsigt: Number(s.smutsigt) || 0,
        foton: Number(s.foton) || 0, besokt: !!s.besokt,
      };
    }
  }
  if (Array.isArray(d.besok)) ut.besok = d.besok.slice(0, 20).map((b) => ({ rum: str(b.rum, 40), resultat: str(b.resultat, 40) }));
  for (const k of Object.keys(ut)) if (ut[k] === undefined) delete ut[k];
  return ut;
}

async function main() {
  const a = lasArgs(process.argv.slice(2));
  if (!a.objekt || !a.status || !a.person) {
    fel('kräver --objekt, --status och --person (se kommentaren överst i filen)');
  }
  const status = STATUSALIAS[String(a.status).toLowerCase()];
  if (!status) fel('okänd status "' + a.status + '" (smutsig | pagar | ren | tom | fylld | startad)');
  const person = PERSONER.find((p) => p.toLowerCase() === String(a.person).toLowerCase());
  if (!person) fel('okänd person "' + a.person + '" (' + PERSONER.join(' | ') + ')');

  let nyckel;
  let data = { version: 1, handelser: [], tilldelningar: {}, objekt: [] };
  try {
    nyckel = valv.oppna().nyckel;
    const las = valv.lasEvents(nyckel);
    if (las) data = las;
    else if (!a.dryRun) fel('data/valv/events.json.enc saknas – vägrar börja om med en tom logg');
  } catch (e) {
    fel('valvet: ' + e.message);
  }
  data.handelser = Array.isArray(data.handelser) ? data.handelser : [];
  data.tilldelningar = data.tilldelningar && typeof data.tilldelningar === 'object' ? data.tilldelningar : {};
  data.objekt = Array.isArray(data.objekt) ? data.objekt : [];
  data.traning = Array.isArray(data.traning) ? data.traning : [];

  const objekt = hittaObjekt(lasObjekt(data), a.objekt);
  if (!objekt) fel('hittar inget objekt som matchar "' + a.objekt + '"');

  let timer = null;
  if (a.timer !== undefined) {
    timer = Number(a.timer);
    if (!Number.isFinite(timer) || timer <= 0 || timer > 1440) fel('--timer måste vara 1–1440 minuter');
  }
  if (timer && status !== 'pagar') fel('--timer kräver status pagar');

  // Tid: --tid > EXIF > nu
  let tid = null;
  let tidKalla = 'nu';
  let sharp = null;
  if (a.bild) {
    if (!fs.existsSync(a.bild)) fel('bilden finns inte: ' + a.bild);
    try {
      sharp = require('sharp');
    } catch (e) {
      fel('sharp saknas – kör "npm install" i husvakten/ först');
    }
  }
  if (a.tid) {
    tid = Date.parse(a.tid);
    if (!Number.isFinite(tid)) fel('ogiltig --tid: ' + a.tid);
    tidKalla = '--tid';
  } else if (a.bild) {
    const meta = await sharp(a.bild).metadata();
    const t = exifTid(meta.exif);
    if (t) {
      tid = t;
      tidKalla = 'EXIF';
    }
  }
  if (tid === null) tid = Date.now();

  const id = 'e-' + stamp(tid) + '-' + Math.random().toString(36).slice(2, 6);
  const handelse = {
    id,
    tid: isoStockholm(tid),
    objektId: objekt.id,
    status,
    person,
  };
  if (timer) {
    handelse.timerMin = timer;
    handelse.timerSlut = isoStockholm(tid + timer * 60000);
  }
  if (a.notis) handelse.notis = String(a.notis).slice(0, 120);
  if (a.uppgift) handelse.uppgift = String(a.uppgift).slice(0, 60);
  if (a.vakt) handelse.vakt = lasVakt(a.vakt);
  if (a['lar-in'] && !ETIKETTER.includes(a['lar-in'])) fel('okänd --lar-in: ' + a['lar-in'] + ' (' + ETIKETTER.join(' | ') + ')');
  if (a['lar-in'] && !a.bild) fel('--lar-in kräver --bild');

  let bildInfo = null;
  if (a.bild) {
    // Logisk sökväg data/foton/<namn> – filen ligger krypterad i data/valv/foton/<namn>.enc
    const namn = stamp(tid) + '-' + objekt.id + '.jpg';
    bildInfo = await behandlaBild(sharp, a.bild, namn);
    handelse.bild = 'data/foton/' + namn;
  }

  if (a.tilldela) {
    const p = TILLDELBARA.find((x) => x.toLowerCase() === String(a.tilldela).toLowerCase());
    if (!p && a.tilldela.toLowerCase() !== 'ingen') fel('okänd --tilldela: ' + a.tilldela);
    data.tilldelningar[objekt.id] = { person: p || null, tid: new Date().toISOString() };
  }

  if (a['lar-in']) {
    data.traning.push({ id: 't-' + id.slice(2), objektId: objekt.id, etikett: a['lar-in'], bild: handelse.bild, tid: handelse.tid });
  }

  data.version = 1;
  data.uppdaterad = new Date().toISOString();
  data.handelser.push(handelse);
  data.handelser.sort((x, y) => Date.parse(x.tid) - Date.parse(y.tid));

  const bildUt = bildInfo ? { bredd: bildInfo.bredd, hojd: bildInfo.hojd, bytes: bildInfo.bytes } : null;
  if (a.dryRun) {
    console.log(JSON.stringify({ dryRun: true, handelse, tidKalla, bild: bildUt, handelserTotalt: data.handelser.length }, null, 2));
    return;
  }
  if (bildInfo) valv.skrivFoto(nyckel, handelse.bild.slice('data/foton/'.length), bildInfo.buf);
  valv.skrivEvents(nyckel, data);
  console.log(JSON.stringify({ ok: true, handelse, tidKalla, bild: bildUt, krypterad: true }, null, 2));
}

main().catch((e) => fel(e.stack || e.message));

#!/usr/bin/env node
/* Husvakten – valvet (krypterad delad data i det publika repot).
 *
 * Format (samma i webbläsaren, js/valv.js, via WebCrypto):
 *   data/valv/meta.json          publik: salt, iterationer, format – inga hemligheter
 *   data/valv/events.json.enc    händelseloggen
 *   data/valv/foton/<namn>.enc   bilderna (<namn> = t.ex. 20260926-085151-tvattmaskin.jpg)
 *   Nyckel:  PBKDF2-SHA256(epost.trim().toLowerCase() + "\n" + lösenord, salt, iterationer) → 256 bit
 *   Fil:     [0x01][IV 12 byte][AES-256-GCM-chiffertext + 16 byte tagg]
 *   AAD:     filens logiska namn ("events.json" eller "foton/<namn>") – filer kan inte bytas ut mot varandra.
 *
 * Lösenordet läses från ~/.husvakten/losen.txt och e-posten från ~/.husvakten/epost.txt
 * (UTANFÖR repot). Skriv aldrig lösenordet i en fil i repot.
 *
 *   node verktyg/valv.js las        skriv ut dekrypterad events.json på stdout
 *   node verktyg/valv.js migrera    kryptera data/events.json + data/foton/*.jpg in i valvet (en gång)
 *   node verktyg/valv.js foto <namn> <utfil>   dekryptera en bild till en lokal fil (utanför repot!)
 *   node verktyg/valv.js skriv <logiskt-namn> <fil>   kryptera en fil in i valvet, t.ex. robot/karta.png
 *        → data/valv/robot/karta.png.enc (AAD = "robot/karta.png"). Källfilen får inte ligga i repot.
 *   node verktyg/valv.js lasfil <logiskt-namn> [<utfil>]   dekryptera en valvfil (utfil utanför repot;
 *        utan utfil skrivs bara storlek + sha256 ut)
 *   node verktyg/valv.js byt-losen [--iter N] [--gammalt-fil <sökväg>]
 *        kryptera om HELA valvet med nytt salt (+ nya iterationer, standard 2 000 000).
 *        Gammalt lösenord: ~/.husvakten/losen.txt (eller --gammalt-fil). Nytt: ~/.husvakten/losen-nytt.txt
 *        om den finns (flyttas till losen.txt när allt verifierats), annars samma lösenord.
 *        Gamla krypterade filer säkerhetskopieras till ~/.husvakten/valv-backup-<tid>/ först.
 */
'use strict';
const fs = require('fs');
const os = require('os');
const path = require('path');
const crypto = require('crypto');

const ROT = path.resolve(__dirname, '..');
const VALV = path.join(ROT, 'data', 'valv');
const META = path.join(VALV, 'meta.json');
const EVENTS_ENC = path.join(VALV, 'events.json.enc');
const FOTON_ENC = path.join(VALV, 'foton');
const HEMLIG_KATALOG = process.env.HUSVAKTEN_HEMLIG || path.join(os.homedir(), '.husvakten');
const ITERATIONER = 600000;        // minsta tillåtna (OWASP 2023 för PBKDF2-SHA256)
const ITERATIONER_MAX = 10000000;  // övre gräns så en trasig meta.json inte låser webbläsaren
const ITERATIONER_STANDARD = 2000000;
const FORMAT_VERSION = 1;
const NAMN_RE = /^[\w.-]+\.jpe?g$/i;
// Generiska valvfiler (robotfliken m.m.): <katalog>/<namn>.<ändelse>, bara kända kataloger.
const GENERISKA_KATALOGER = ['robot'];
const GENERISK_RE = /^robot\/(foton\/)?[\w-]+\.(png|json|jpg)$/;

function lasLosenFil(losenFil) {
  if (!fs.existsSync(losenFil)) throw new Error('saknar ' + losenFil);
  const losen = fs.readFileSync(losenFil, 'utf8').replace(/^﻿/, '').replace(/[\r\n]+$/, '');
  if (!losen) throw new Error(path.basename(losenFil) + ' är tom');
  return losen;
}

function lasHemligheter(losenFil = path.join(HEMLIG_KATALOG, 'losen.txt')) {
  const epostFil = path.join(HEMLIG_KATALOG, 'epost.txt');
  if (!fs.existsSync(epostFil)) throw new Error('saknar ' + epostFil);
  const losen = lasLosenFil(losenFil);
  const epost = fs.readFileSync(epostFil, 'utf8').replace(/^﻿/, '').trim();
  if (!epost.includes('@')) throw new Error('epost.txt ser inte ut som en e-postadress');
  return { epost, losen };
}

function lasMeta() {
  if (!fs.existsSync(META)) return null;
  const m = JSON.parse(fs.readFileSync(META, 'utf8'));
  if (m.version !== FORMAT_VERSION || !m.kdf || !m.kdf.salt || !Number.isInteger(m.kdf.iterationer) ||
      m.kdf.iterationer < ITERATIONER || m.kdf.iterationer > ITERATIONER_MAX) {
    throw new Error('data/valv/meta.json har okänt format');
  }
  return m;
}

function skapaMeta() {
  const m = {
    version: FORMAT_VERSION,
    beskrivning: 'Husvaktens valv. Data är krypterad med AES-256-GCM; nyckeln härleds ur e-post + lösenord. Inga hemligheter i denna fil.',
    kdf: { namn: 'PBKDF2-SHA256', iterationer: ITERATIONER_STANDARD, salt: crypto.randomBytes(16).toString('base64'), indata: 'epost.trim().toLowerCase() + "\\n" + losenord' },
    chiffer: { namn: 'AES-256-GCM', iv: 12, tagg: 16, layout: '[0x01][iv][chiffertext+tagg]', aad: 'logiskt filnamn' },
    filer: { events: 'events.json.enc', foton: 'foton/<namn>.enc' },
  };
  fs.mkdirSync(VALV, { recursive: true });
  fs.writeFileSync(META, JSON.stringify(m, null, 2) + '\n');
  return m;
}

function harledNyckel(epost, losen, meta) {
  const indata = Buffer.from(String(epost).trim().toLowerCase() + '\n' + String(losen), 'utf8');
  return crypto.pbkdf2Sync(indata, Buffer.from(meta.kdf.salt, 'base64'), meta.kdf.iterationer, 32, 'sha256');
}

function kryptera(nyckel, klartext, namn) {
  const iv = crypto.randomBytes(12);
  const c = crypto.createCipheriv('aes-256-gcm', nyckel, iv);
  c.setAAD(Buffer.from(namn, 'utf8'));
  const ct = Buffer.concat([c.update(klartext), c.final()]);
  return Buffer.concat([Buffer.from([FORMAT_VERSION]), iv, ct, c.getAuthTag()]);
}

function dekryptera(nyckel, buf, namn) {
  if (buf.length < 1 + 12 + 16 || buf[0] !== FORMAT_VERSION) throw new Error('okänt valvformat för ' + namn);
  const iv = buf.subarray(1, 13);
  const tagg = buf.subarray(buf.length - 16);
  const d = crypto.createDecipheriv('aes-256-gcm', nyckel, iv);
  d.setAAD(Buffer.from(namn, 'utf8'));
  d.setAuthTag(tagg);
  return Buffer.concat([d.update(buf.subarray(13, buf.length - 16)), d.final()]);
}

function skrivAtomiskt(fil, buf) {
  fs.mkdirSync(path.dirname(fil), { recursive: true });
  const tmp = fil + '.tmp';
  fs.writeFileSync(tmp, buf);
  fs.renameSync(tmp, fil);
}

/** Öppna valvet: returnerar { nyckel, meta }. Skapar meta.json om skapa=true och den saknas. */
function oppna({ skapa = false } = {}) {
  const { epost, losen } = lasHemligheter();
  let meta = lasMeta();
  if (!meta) {
    if (!skapa) throw new Error('data/valv/meta.json saknas – kör "node verktyg/valv.js migrera" först');
    meta = skapaMeta();
  }
  return { nyckel: harledNyckel(epost, losen, meta), meta };
}

function lasEvents(nyckel) {
  if (!fs.existsSync(EVENTS_ENC)) return null;
  try {
    return JSON.parse(dekryptera(nyckel, fs.readFileSync(EVENTS_ENC), 'events.json').toString('utf8'));
  } catch (e) {
    throw new Error('kunde inte dekryptera events.json.enc (fel lösenord/e-post eller trasig fil): ' + e.message);
  }
}

function skrivEvents(nyckel, data) {
  const klar = Buffer.from(JSON.stringify(data, null, 2) + '\n', 'utf8');
  const enc = kryptera(nyckel, klar, 'events.json');
  // Kontrollera att det går att läsa tillbaka innan filen ersätts
  if (!dekryptera(nyckel, enc, 'events.json').equals(klar)) throw new Error('återläsning av events misslyckades');
  skrivAtomiskt(EVENTS_ENC, enc);
}

function fotoFil(namn) {
  if (!NAMN_RE.test(namn)) throw new Error('ogiltigt fotonamn: ' + namn);
  return path.join(FOTON_ENC, namn + '.enc');
}

function skrivFoto(nyckel, namn, buf) {
  const enc = kryptera(nyckel, buf, 'foton/' + namn);
  if (!dekryptera(nyckel, enc, 'foton/' + namn).equals(buf)) throw new Error('återläsning av foto misslyckades');
  skrivAtomiskt(fotoFil(namn), enc);
}

function lasFoto(nyckel, namn) {
  return dekryptera(nyckel, fs.readFileSync(fotoFil(namn)), 'foton/' + namn);
}

/** Sökväg till en generisk valvfil, t.ex. "robot/karta.png" → data/valv/robot/karta.png.enc */
function generiskFil(namn) {
  if (!GENERISK_RE.test(namn)) throw new Error('ogiltigt logiskt namn: ' + namn + ' (tillåtet: robot/<namn>.png|json, robot/foton/<id>.jpg)');
  return path.join(VALV, ...namn.split('/')) + '.enc';
}

function skrivFil(nyckel, namn, buf) {
  const enc = kryptera(nyckel, buf, namn);
  if (!dekryptera(nyckel, enc, namn).equals(buf)) throw new Error('återläsning misslyckades: ' + namn);
  skrivAtomiskt(generiskFil(namn), enc);
}

function lasFil(nyckel, namn) {
  return dekryptera(nyckel, fs.readFileSync(generiskFil(namn)), namn);
}

function iRepot(fil) {
  const p = path.resolve(fil).toLowerCase();
  return p === ROT.toLowerCase() || p.startsWith(ROT.toLowerCase() + path.sep);
}

/** Engångsmigrering: plaintext → valv. Tar inte bort plaintext (gör det med git rm efter kontroll). */
function migrera() {
  const plainEvents = path.join(ROT, 'data', 'events.json');
  const plainFoton = path.join(ROT, 'data', 'foton');
  if (!fs.existsSync(plainEvents)) throw new Error('data/events.json saknas – inget att migrera');
  if (fs.existsSync(EVENTS_ENC)) throw new Error('data/valv/events.json.enc finns redan – vägrar skriva över');
  const { nyckel } = oppna({ skapa: true });
  const data = JSON.parse(fs.readFileSync(plainEvents, 'utf8'));
  const foton = fs.existsSync(plainFoton) ? fs.readdirSync(plainFoton).filter((f) => NAMN_RE.test(f)) : [];
  for (const f of foton) skrivFoto(nyckel, f, fs.readFileSync(path.join(plainFoton, f)));
  skrivEvents(nyckel, data);
  // Verifiera: allt ska gå att läsa tillbaka och vara identiskt
  const tillbaka = lasEvents(nyckel);
  if (JSON.stringify(tillbaka) !== JSON.stringify(data)) throw new Error('events skiljer sig efter migrering');
  for (const f of foton) {
    if (!lasFoto(nyckel, f).equals(fs.readFileSync(path.join(plainFoton, f)))) throw new Error('foto skiljer sig: ' + f);
  }
  const refs = new Set();
  for (const h of [...(data.handelser || []), ...(data.traning || [])]) if (h && h.bild) refs.add(h.bild);
  const saknas = [...refs].filter((b) => b.startsWith('data/foton/') && !foton.includes(b.slice('data/foton/'.length)));
  return { handelser: (data.handelser || []).length, traning: (data.traning || []).length, foton: foton.length, saknadeFoton: saknas };
}

/** Alla krypterade filer i valvet: [{ fil, namn }] där namn = logiskt namn (AAD). */
function valvFiler() {
  const filer = [];
  for (const f of fs.readdirSync(VALV)) {
    const full = path.join(VALV, f);
    if (fs.statSync(full).isDirectory()) {
      if (GENERISKA_KATALOGER.includes(f)) {
        const poster = [];
        for (const g of fs.readdirSync(full)) {
          const under = path.join(full, g);
          if (g === 'foton' && fs.statSync(under).isDirectory()) poster.push(...fs.readdirSync(under).map((x) => 'foton/' + x));
          else poster.push(g);
        }
        for (const g of poster) {
          const namn = f + '/' + g.replace(/\.enc$/, '');
          if (!g.endsWith('.enc') || !GENERISK_RE.test(namn)) throw new Error('okänd fil i valvet: ' + f + '/' + g + ' – vägrar fortsätta');
          filer.push({ fil: path.join(full, g), namn });
        }
        continue;
      }
      if (f !== 'foton') throw new Error('okänd katalog i valvet: ' + f + ' – vägrar fortsätta');
      continue;
    }
    if (f === 'meta.json') continue;
    if (f === 'events.json.enc') filer.push({ fil: full, namn: 'events.json' });
    else throw new Error('okänd fil i valvet: ' + f + ' – vägrar fortsätta');
  }
  if (fs.existsSync(FOTON_ENC)) {
    for (const f of fs.readdirSync(FOTON_ENC)) {
      const namn = f.replace(/\.enc$/, '');
      if (!f.endsWith('.enc') || !NAMN_RE.test(namn)) throw new Error('okänd fil i valvet: foton/' + f + ' – vägrar fortsätta');
      filer.push({ fil: path.join(FOTON_ENC, f), namn: 'foton/' + namn });
    }
  }
  return filer;
}

/** Kryptera om hela valvet med nytt salt/iterationer (och ev. nytt lösenord). */
function bytLosen({ iter = ITERATIONER_STANDARD, gammaltFil } = {}) {
  if (!Number.isInteger(iter) || iter < ITERATIONER || iter > ITERATIONER_MAX) {
    throw new Error('--iter måste vara ett heltal mellan ' + ITERATIONER + ' och ' + ITERATIONER_MAX);
  }
  const losenFil = path.join(HEMLIG_KATALOG, 'losen.txt');
  const nyttFil = path.join(HEMLIG_KATALOG, 'losen-nytt.txt');
  const gammal = lasHemligheter(gammaltFil ? path.resolve(gammaltFil) : losenFil);
  const nyttLosen = fs.existsSync(nyttFil) ? lasLosenFil(nyttFil) : null;
  const gammalMeta = lasMeta();
  if (!gammalMeta) throw new Error('data/valv/meta.json saknas');
  const gammalNyckel = harledNyckel(gammal.epost, gammal.losen, gammalMeta);

  // 1. Dekryptera allt med gamla nyckeln (i minnet)
  const filer = valvFiler();
  if (!filer.some((f) => f.namn === 'events.json')) throw new Error('events.json.enc saknas');
  const klart = filer.map((f) => {
    const gammalBuf = fs.readFileSync(f.fil);
    try {
      return { ...f, gammalBuf, klar: dekryptera(gammalNyckel, gammalBuf, f.namn) };
    } catch (e) {
      throw new Error('kunde inte dekryptera ' + f.namn + ' med gamla lösenordet: ' + e.message);
    }
  });

  // 2. Ny meta + ny nyckel, kryptera om och verifiera i minnet
  const nyMeta = JSON.parse(JSON.stringify(gammalMeta));
  nyMeta.kdf.iterationer = iter;
  nyMeta.kdf.salt = crypto.randomBytes(16).toString('base64');
  const nyNyckel = harledNyckel(gammal.epost, nyttLosen === null ? gammal.losen : nyttLosen, nyMeta);
  for (const f of klart) {
    f.nyBuf = kryptera(nyNyckel, f.klar, f.namn);
    if (!dekryptera(nyNyckel, f.nyBuf, f.namn).equals(f.klar)) throw new Error('återläsning misslyckades: ' + f.namn);
  }
  const metaText = JSON.stringify(nyMeta, null, 2) + '\n';

  // 3. Säkerhetskopia av gamla krypterade filer UTANFÖR repot
  const stampel = new Date().toISOString().replace(/[:.]/g, '-');
  const backup = path.join(HEMLIG_KATALOG, 'valv-backup-' + stampel);
  fs.mkdirSync(path.join(backup, 'foton'), { recursive: true });
  fs.copyFileSync(META, path.join(backup, 'meta.json'));
  for (const f of klart) {
    const ut = path.join(backup, ...(f.namn === 'events.json' ? 'events.json.enc' : f.namn + '.enc').split('/'));
    fs.mkdirSync(path.dirname(ut), { recursive: true });
    fs.writeFileSync(ut, f.gammalBuf);
  }

  // 4. Skriv allt till .tmp, byt sedan (meta sist)
  for (const f of klart) fs.writeFileSync(f.fil + '.tmp', f.nyBuf);
  fs.writeFileSync(META + '.tmp', metaText);
  for (const f of klart) fs.renameSync(f.fil + '.tmp', f.fil);
  fs.renameSync(META + '.tmp', META);

  // 5. Verifiera från disk med nyckel härledd ur den skrivna meta.json
  const diskMeta = lasMeta();
  const diskNyckel = harledNyckel(gammal.epost, nyttLosen === null ? gammal.losen : nyttLosen, diskMeta);
  for (const f of klart) {
    if (!dekryptera(diskNyckel, fs.readFileSync(f.fil), f.namn).equals(f.klar)) {
      throw new Error('verifiering från disk misslyckades: ' + f.namn + ' – återställ från ' + backup);
    }
  }

  // 6. Nytt lösenord verifierat → losen-nytt.txt ersätter losen.txt
  if (nyttLosen !== null) fs.renameSync(nyttFil, losenFil);
  const events = JSON.parse(klart.find((f) => f.namn === 'events.json').klar.toString('utf8'));
  return {
    filer: klart.length,
    foton: klart.filter((f) => f.namn.startsWith('foton/')).length,
    handelser: (events.handelser || []).length,
    iterationer: iter,
    nyttLosen: nyttLosen !== null,
    backup,
  };
}

function flagga(args, namn) {
  const i = args.indexOf(namn);
  if (i === -1) return undefined;
  if (i + 1 >= args.length) throw new Error(namn + ' saknar värde');
  return args[i + 1];
}

module.exports = { ROT, VALV, oppna, bytLosen, lasEvents, skrivEvents, skrivFoto, lasFoto, skrivFil, lasFil, valvFiler, kryptera, dekryptera, harledNyckel, NAMN_RE, GENERISK_RE };

if (require.main === module) {
  try {
    const [cmd, ...rest] = process.argv.slice(2);
    if (cmd === 'migrera') {
      console.log(JSON.stringify({ ok: true, ...migrera() }, null, 2));
    } else if (cmd === 'las') {
      const { nyckel } = oppna();
      process.stdout.write(JSON.stringify(lasEvents(nyckel), null, 2) + '\n');
    } else if (cmd === 'foto' && rest.length === 2) {
      const { nyckel } = oppna();
      const ut = path.resolve(rest[1]);
      if (ut.startsWith(ROT + path.sep)) throw new Error('skriv inte dekrypterade bilder i repot');
      fs.writeFileSync(ut, lasFoto(nyckel, rest[0]));
      console.log('skrev ' + ut);
    } else if (cmd === 'skriv' && rest.length === 2) {
      const [namn, kalla] = rest;
      if (iRepot(kalla)) throw new Error('källfilen ligger i repot – lägg okrypterade filer utanför repot');
      const { nyckel } = oppna();
      const buf = fs.readFileSync(path.resolve(kalla));
      skrivFil(nyckel, namn, buf);
      if (!lasFil(nyckel, namn).equals(buf)) throw new Error('verifiering från disk misslyckades: ' + namn);
      console.log('krypterade ' + namn + ' (' + buf.length + ' byte) → ' + path.relative(ROT, generiskFil(namn)).split(path.sep).join('/'));
    } else if (cmd === 'lasfil' && (rest.length === 1 || rest.length === 2)) {
      const { nyckel } = oppna();
      const buf = lasFil(nyckel, rest[0]);
      if (rest[1]) {
        if (iRepot(rest[1])) throw new Error('skriv inte dekrypterade filer i repot');
        fs.writeFileSync(path.resolve(rest[1]), buf);
        console.log('skrev ' + path.resolve(rest[1]));
      } else {
        console.log(JSON.stringify({ namn: rest[0], byte: buf.length, sha256: crypto.createHash('sha256').update(buf).digest('hex') }));
      }
    } else if (cmd === 'byt-losen') {
      const iterText = flagga(rest, '--iter');
      const iter = iterText === undefined ? ITERATIONER_STANDARD : Number(iterText);
      console.log(JSON.stringify({ ok: true, ...bytLosen({ iter, gammaltFil: flagga(rest, '--gammalt-fil') }) }, null, 2));
    } else {
      console.error('användning: node verktyg/valv.js las | migrera | foto <namn> <utfil> | skriv <logiskt-namn> <fil> | lasfil <logiskt-namn> [<utfil>] | byt-losen [--iter N] [--gammalt-fil <sökväg>]');
      process.exit(2);
    }
  } catch (e) {
    console.error('valv.js: ' + e.message);
    process.exit(1);
  }
}

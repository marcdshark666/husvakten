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
const ITERATIONER = 600000;
const FORMAT_VERSION = 1;
const NAMN_RE = /^[\w.-]+\.jpe?g$/i;

function lasHemligheter() {
  const losenFil = path.join(HEMLIG_KATALOG, 'losen.txt');
  const epostFil = path.join(HEMLIG_KATALOG, 'epost.txt');
  if (!fs.existsSync(losenFil) || !fs.existsSync(epostFil)) {
    throw new Error('saknar ' + losenFil + ' eller ' + epostFil);
  }
  const losen = fs.readFileSync(losenFil, 'utf8').replace(/^﻿/, '').replace(/[\r\n]+$/, '');
  const epost = fs.readFileSync(epostFil, 'utf8').replace(/^﻿/, '').trim();
  if (!losen) throw new Error('losen.txt är tom');
  if (!epost.includes('@')) throw new Error('epost.txt ser inte ut som en e-postadress');
  return { epost, losen };
}

function lasMeta() {
  if (!fs.existsSync(META)) return null;
  const m = JSON.parse(fs.readFileSync(META, 'utf8'));
  if (m.version !== FORMAT_VERSION || !m.kdf || !m.kdf.salt || !(m.kdf.iterationer >= ITERATIONER)) {
    throw new Error('data/valv/meta.json har okänt format');
  }
  return m;
}

function skapaMeta() {
  const m = {
    version: FORMAT_VERSION,
    beskrivning: 'Husvaktens valv. Data är krypterad med AES-256-GCM; nyckeln härleds ur e-post + lösenord. Inga hemligheter i denna fil.',
    kdf: { namn: 'PBKDF2-SHA256', iterationer: ITERATIONER, salt: crypto.randomBytes(16).toString('base64'), indata: 'epost.trim().toLowerCase() + "\\n" + losenord' },
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

module.exports = { ROT, VALV, oppna, lasEvents, skrivEvents, skrivFoto, lasFoto, kryptera, dekryptera, harledNyckel, NAMN_RE };

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
    } else {
      console.error('användning: node verktyg/valv.js las | migrera | foto <namn> <utfil>');
      process.exit(2);
    }
  } catch (e) {
    console.error('valv.js: ' + e.message);
    process.exit(1);
  }
}

/* Husvakten – valvet i webbläsaren (WebCrypto).
 * Delad data ligger krypterad i det publika repot (data/valv/). Format: se verktyg/valv.js.
 * Inloggningen härleder nyckeln ur e-post + lösenord (PBKDF2-SHA256) och försöker dekryptera
 * events.json.enc – går det inte är uppgifterna fel. Nyckeln hålls bara i minnet (icke-exporterbar
 * CryptoKey); lösenordet sparas aldrig, varken i localStorage eller sessionStorage.
 * Efter lyckad inloggning laddas appens skript (karta, ml, hushall, app) – förut finns ingen app.
 */
(function () {
  'use strict';
  const HV = (window.HV = window.HV || {});
  const BAS = 'data/valv/';
  const FOTO_RE = /^data\/foton\/([\w.-]+\.jpe?g)$/i;
  const GENERISK_RE = /^robot\/(foton\/)?[\w-]+\.(png|json|jpg)$/; // samma som verktyg/valv.js
  const APPSKRIPT = ['js/karta.js', 'js/ml.js', 'js/hushall.js', 'js/robot.js', 'js/app.js'];

  let nyckel = null;
  const bildCache = new Map(); // logisk sökväg → Promise<objectURL>

  function b64TillBytes(b64) {
    const bin = atob(b64);
    const u = new Uint8Array(bin.length);
    for (let i = 0; i < bin.length; i++) u[i] = bin.charCodeAt(i);
    return u;
  }

  async function hamta(url, typ) {
    const svar = await fetch(url + '?t=' + Date.now(), { cache: 'no-store' });
    if (!svar.ok) throw new Error('HTTP ' + svar.status + ' för ' + url);
    return typ === 'json' ? svar.json() : svar.arrayBuffer();
  }

  async function harledNyckel(epost, losen) {
    const meta = await hamta(BAS + 'meta.json', 'json');
    // Iterationerna läses ur meta.json (byts med `node verktyg/valv.js byt-losen --iter N`), aldrig hårdkodat.
    const iter = meta && meta.kdf && meta.kdf.iterationer;
    if (!meta || meta.version !== 1 || !meta.kdf || !meta.kdf.salt || !Number.isInteger(iter) || iter < 600000 || iter > 10000000) {
      throw new Error('Valvets meta.json har okänt format');
    }
    const indata = new TextEncoder().encode(String(epost).trim().toLowerCase() + '\n' + String(losen));
    const bas = await crypto.subtle.importKey('raw', indata, 'PBKDF2', false, ['deriveKey']);
    return crypto.subtle.deriveKey(
      { name: 'PBKDF2', hash: 'SHA-256', salt: b64TillBytes(meta.kdf.salt), iterations: meta.kdf.iterationer },
      bas,
      { name: 'AES-GCM', length: 256 },
      false,
      ['decrypt']
    );
  }

  async function dekryptera(k, buf, namn) {
    const u = new Uint8Array(buf);
    if (u.length < 29 || u[0] !== 1) throw new Error('Okänt valvformat för ' + namn);
    return crypto.subtle.decrypt(
      { name: 'AES-GCM', iv: u.subarray(1, 13), additionalData: new TextEncoder().encode(namn), tagLength: 128 },
      k,
      u.subarray(13)
    );
  }

  /** Dekrypterad delad logg (samma innehåll som gamla data/events.json). */
  async function lasEvents() {
    if (!nyckel) throw new Error('Valvet är låst');
    const klar = await dekryptera(nyckel, await hamta(BAS + 'events.json.enc'), 'events.json');
    return JSON.parse(new TextDecoder().decode(klar));
  }

  /** Dekrypterad bild som Blob. `bild` = logisk sökväg data/foton/<namn>.jpg */
  async function hamtaBlob(bild) {
    const m = FOTO_RE.exec(String(bild || ''));
    if (!m) throw new Error('Ogiltig bildsökväg');
    if (!nyckel) throw new Error('Valvet är låst');
    const klar = await dekryptera(nyckel, await hamta(BAS + 'foton/' + m[1] + '.enc'), 'foton/' + m[1]);
    return new Blob([klar], { type: 'image/jpeg' });
  }

  /** Dekrypterad generisk valvfil (t.ex. "robot/robot.json") som ArrayBuffer. */
  async function lasFil(namn) {
    if (!GENERISK_RE.test(String(namn || ''))) throw new Error('Ogiltigt valvnamn');
    if (!nyckel) throw new Error('Valvet är låst');
    return dekryptera(nyckel, await hamta(BAS + namn + '.enc'), namn);
  }

  /** Object-URL till dekrypterad bild (cachas under sessionen). null vid fel. */
  function bildUrl(bild) {
    if (!bildCache.has(bild)) {
      bildCache.set(bild, hamtaBlob(bild).then(
        (b) => URL.createObjectURL(b),
        (e) => {
          console.warn('Husvakten: kunde inte dekryptera bild', bild, e);
          bildCache.delete(bild);
          return null;
        }
      ));
    }
    return bildCache.get(bild);
  }

  function laddaSkript(src) {
    return new Promise((resolve, reject) => {
      const s = document.createElement('script');
      s.src = src;
      s.async = false;
      s.onload = resolve;
      s.onerror = () => reject(new Error('Kunde inte ladda ' + src));
      document.body.appendChild(s);
    });
  }

  /** Försök låsa upp. Kastar Error('fel-uppgifter') om e-post/lösenord inte dekrypterar. */
  async function lasUpp(epost, losen) {
    if (!window.crypto || !crypto.subtle) throw new Error('Webbläsaren saknar WebCrypto (kräver https)');
    const k = await harledNyckel(epost, losen);
    const enc = await hamta(BAS + 'events.json.enc');
    try {
      await dekryptera(k, enc, 'events.json');
    } catch (e) {
      throw new Error('fel-uppgifter');
    }
    nyckel = k;
  }

  HV.valv = { lasEvents, hamtaBlob, bildUrl, lasFil, get upplast() { return !!nyckel; } };

  // ---------- Inloggningsrutan ----------
  function startaInloggning() {
    const form = document.getElementById('inloggning-form');
    const epostF = document.getElementById('inloggning-epost');
    const losenF = document.getElementById('inloggning-losen');
    const knapp = document.getElementById('inloggning-knapp');
    const felRuta = document.getElementById('inloggning-fel');
    if (!form) return;
    form.addEventListener('submit', async (ev) => {
      ev.preventDefault();
      const epost = epostF.value;
      const losen = losenF.value;
      felRuta.hidden = true;
      if (!epost.trim() || !losen) {
        felRuta.textContent = 'Fyll i både e-post och lösenord.';
        felRuta.hidden = false;
        return;
      }
      knapp.disabled = true;
      knapp.textContent = 'Låser upp …';
      try {
        await lasUpp(epost, losen);
        losenF.value = '';
        document.getElementById('inloggning').remove();
        document.body.classList.remove('last');
        for (const src of APPSKRIPT) await laddaSkript(src);
      } catch (e) {
        losenF.value = '';
        felRuta.textContent = e.message === 'fel-uppgifter'
          ? 'Fel e-post eller lösenord.'
          : 'Kunde inte låsa upp: ' + e.message;
        felRuta.hidden = false;
        knapp.disabled = false;
        knapp.textContent = 'Logga in';
        losenF.focus();
      }
    });
  }

  if (document.readyState === 'loading') document.addEventListener('DOMContentLoaded', startaInloggning);
  else startaInloggning();
})();

/* Husvakten – lagring.
 * localStorage: objekt + status (litet, synkront).
 * IndexedDB: träningsexempel (embedding + liten miniatyr).
 * Allt är inlindat i try/catch – appen ska fungera även i privat läge.
 */
(function () {
  'use strict';
  const HV = (window.HV = window.HV || {});

  const LS_KEY = 'husvakten.v1';
  const DB_NAME = 'husvakten';
  const DB_VER = 2;
  const FOTON = 'foton';
  const STORE = 'exempel';

  // ---------- localStorage ----------
  function lasTillstand() {
    try {
      const raw = localStorage.getItem(LS_KEY);
      if (!raw) return null;
      const data = JSON.parse(raw);
      if (!data || !Array.isArray(data.objekt)) return null;
      return data;
    } catch (e) {
      console.warn('Husvakten: kunde inte läsa localStorage', e);
      return null;
    }
  }

  function sparaTillstand(tillstand) {
    try {
      localStorage.setItem(LS_KEY, JSON.stringify(tillstand));
      return true;
    } catch (e) {
      console.warn('Husvakten: kunde inte spara till localStorage', e);
      return false;
    }
  }

  // ---------- IndexedDB (med minnesreserv) ----------
  let dbPromise = null;
  let minnesReserv = null; // används om IndexedDB saknas/blockeras
  let nastaMinnesId = 1;

  function oppnaDb() {
    if (dbPromise) return dbPromise;
    dbPromise = new Promise((resolve) => {
      try {
        if (!('indexedDB' in window)) throw new Error('IndexedDB saknas');
        const req = indexedDB.open(DB_NAME, DB_VER);
        req.onupgradeneeded = () => {
          const db = req.result;
          if (!db.objectStoreNames.contains(STORE)) {
            const s = db.createObjectStore(STORE, { keyPath: 'id', autoIncrement: true });
            s.createIndex('objektId', 'objektId', { unique: false });
          }
          if (!db.objectStoreNames.contains(FOTON)) {
            db.createObjectStore(FOTON, { keyPath: 'id' });
          }
        };
        req.onsuccess = () => resolve(req.result);
        req.onerror = () => {
          console.warn('Husvakten: IndexedDB kunde inte öppnas – sparar i minnet', req.error);
          minnesReserv = minnesReserv || [];
          resolve(null);
        };
        req.onblocked = () => console.warn('Husvakten: IndexedDB blockerad av annan flik');
      } catch (e) {
        console.warn('Husvakten: IndexedDB ej tillgängligt – sparar i minnet', e);
        minnesReserv = minnesReserv || [];
        resolve(null);
      }
    });
    return dbPromise;
  }

  function reqTillPromise(req) {
    return new Promise((resolve, reject) => {
      req.onsuccess = () => resolve(req.result);
      req.onerror = () => reject(req.error);
    });
  }

  async function allaExempel() {
    const db = await oppnaDb();
    if (!db) return (minnesReserv || []).slice();
    try {
      const tx = db.transaction(STORE, 'readonly');
      return await reqTillPromise(tx.objectStore(STORE).getAll());
    } catch (e) {
      console.warn('Husvakten: kunde inte läsa exempel', e);
      return [];
    }
  }

  async function exempelFor(objektId) {
    const alla = await allaExempel();
    return alla.filter((x) => x.objektId === objektId);
  }

  async function laggTillExempel(ex) {
    const post = {
      objektId: String(ex.objektId),
      etikett: String(ex.etikett),
      emb: Array.from(ex.emb || []),
      thumb: typeof ex.thumb === 'string' ? ex.thumb : '',
      t: ex.t || Date.now(),
      modell: ex.modell || '',
      seedId: ex.seedId ? String(ex.seedId) : null,
    };
    const db = await oppnaDb();
    if (!db) {
      post.id = nastaMinnesId++;
      minnesReserv.push(post);
      return post.id;
    }
    const tx = db.transaction(STORE, 'readwrite');
    const id = await reqTillPromise(tx.objectStore(STORE).add(post));
    return id;
  }

  async function taBortExempel(id) {
    const db = await oppnaDb();
    if (!db) {
      minnesReserv = minnesReserv.filter((x) => x.id !== id);
      return;
    }
    const tx = db.transaction(STORE, 'readwrite');
    await reqTillPromise(tx.objectStore(STORE).delete(id));
  }

  async function taBortExempelFor(objektId) {
    const alla = await exempelFor(objektId);
    for (const ex of alla) await taBortExempel(ex.id);
  }

  async function rensaExempel() {
    const db = await oppnaDb();
    if (!db) {
      minnesReserv = [];
      return;
    }
    const tx = db.transaction(STORE, 'readwrite');
    await reqTillPromise(tx.objectStore(STORE).clear());
  }

  // ---------- Foton till händelser (lokala, i IndexedDB) ----------
  const minnesFoton = new Map();

  async function sparaFoto(id, dataUrl) {
    const db = await oppnaDb();
    if (!db) {
      minnesFoton.set(id, dataUrl);
      return;
    }
    const tx = db.transaction(FOTON, 'readwrite');
    await reqTillPromise(tx.objectStore(FOTON).put({ id, data: dataUrl }));
  }

  async function lasFoto(id) {
    const db = await oppnaDb();
    if (!db) return minnesFoton.get(id) || null;
    try {
      const tx = db.transaction(FOTON, 'readonly');
      const r = await reqTillPromise(tx.objectStore(FOTON).get(id));
      return r ? r.data : null;
    } catch (e) {
      console.warn('Husvakten: kunde inte läsa foto', e);
      return null;
    }
  }

  // ---------- Små nycklar i localStorage (person, lokala händelser, tilldelningar) ----------
  function lasJson(nyckel, std) {
    try {
      const raw = localStorage.getItem(nyckel);
      return raw ? JSON.parse(raw) : std;
    } catch (e) {
      console.warn('Husvakten: kunde inte läsa ' + nyckel, e);
      return std;
    }
  }

  function sparaJson(nyckel, varde) {
    try {
      localStorage.setItem(nyckel, JSON.stringify(varde));
      return true;
    } catch (e) {
      console.warn('Husvakten: kunde inte spara ' + nyckel, e);
      return false;
    }
  }

  HV.lagring = {
    sparaFoto,
    lasFoto,
    lasJson,
    sparaJson,
    lasTillstand,
    sparaTillstand,
    allaExempel,
    exempelFor,
    laggTillExempel,
    taBortExempel,
    taBortExempelFor,
    rensaExempel,
  };
})();

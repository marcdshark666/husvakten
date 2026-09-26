/* Husvakten – hushållet: händelselogg (delad krypterad logg i data/valv/ + lokala händelser),
 * status härledd ur loggen, tilldelningar, statistik och rättvis fördelning.
 */
(function () {
  'use strict';
  const HV = (window.HV = window.HV || {});
  const { lagring } = HV;

  const PERSONER = ['Marc', 'Ada'];
  // Robot = robotdammsugarens golvvakt (verktyg/roborock/live.py). Visas som 🤖 Robot men räknas
  // aldrig i statistik, tilldelning eller rättvis fördelning.
  const ROBOT = 'Robot';
  const KANDA = [...PERSONER, ROBOT];
  const STATUSAR = ['smutsig', 'pagar', 'ren'];
  const LS_HANDELSER = 'husvakten.handelser';
  const LS_TILLDELNINGAR = 'husvakten.tilldelningar';
  const LS_PERSON = 'husvakten.person';

  let repo = { handelser: [], tilldelningar: {}, objekt: [], traning: [], laddad: false, fel: null };
  let lokala = lagring.lasJson(LS_HANDELSER, []);
  let lokalaTill = lagring.lasJson(LS_TILLDELNINGAR, {});
  if (!Array.isArray(lokala)) lokala = [];
  if (!lokalaTill || typeof lokalaTill !== 'object') lokalaTill = {};

  // ---------- Validering ----------
  function tidMs(v) {
    const t = typeof v === 'number' ? v : Date.parse(v);
    return Number.isFinite(t) ? t : null;
  }

  function stadaHandelse(h, kalla) {
    if (!h || typeof h !== 'object') return null;
    const t = tidMs(h.tid);
    if (t === null || !h.objektId || !STATUSAR.includes(h.status)) return null;
    const person = KANDA.includes(h.person) ? h.person : null;
    let bild = null;
    if (typeof h.bild === 'string') {
      if (/^data\/foton\/[\w.-]+\.jpe?g$/i.test(h.bild) || /^idb:[\w-]+$/.test(h.bild)) bild = h.bild;
    }
    const slut = tidMs(h.timerSlut);
    return {
      id: String(h.id || 'x' + t).slice(0, 60),
      tid: new Date(t).toISOString(),
      t,
      objektId: String(h.objektId).slice(0, 40),
      status: h.status,
      person,
      bild,
      timerMin: Number.isFinite(Number(h.timerMin)) ? Number(h.timerMin) : null,
      timerSlut: h.status === 'pagar' && slut !== null ? slut : null,
      notis: h.notis ? String(h.notis).slice(0, 120) : '',
      uppgift: h.uppgift ? String(h.uppgift).slice(0, 60) : '',
      auto: !!h.auto,
      ersatter: h.ersatter ? String(h.ersatter).slice(0, 60) : null,
      kalla,
    };
  }

  // ---------- Delad logg ----------
  async function laddaRepo() {
    try {
      // Delad logg ligger krypterad i data/valv/ – dekrypteras i minnet (js/valv.js)
      const data = await HV.valv.lasEvents();
      const handelser = (Array.isArray(data.handelser) ? data.handelser : [])
        .map((h) => stadaHandelse(h, 'delad'))
        .filter(Boolean);
      const till = {};
      if (data.tilldelningar && typeof data.tilldelningar === 'object') {
        for (const [id, v] of Object.entries(data.tilldelningar)) {
          const t = v && tidMs(v.tid);
          if (t !== null && (v.person === null || PERSONER.includes(v.person))) till[id] = { person: v.person, t };
        }
      }
      repo = {
        handelser,
        tilldelningar: till,
        objekt: Array.isArray(data.objekt) ? data.objekt : [],
        // Delade träningsbilder (t.ex. inlagda av vakthunden) – embeddings räknas fram i webbläsaren
        traning: (Array.isArray(data.traning) ? data.traning : []).filter((x) =>
          x && typeof x.id === 'string' && x.objektId && typeof x.etikett === 'string' &&
          typeof x.bild === 'string' && /^data\/foton\/[\w.-]+\.jpe?g$/i.test(x.bild)
        ),
        laddad: true,
        fel: null,
      };
    } catch (e) {
      console.warn('Husvakten: kunde inte läsa den delade loggen (valvet)', e);
      repo.fel = e.message;
    }
    return repo;
  }

  function allaHandelser() {
    const karta = new Map();
    for (const h of repo.handelser) karta.set(h.id, h);
    for (const raw of lokala) {
      const h = stadaHandelse(raw, 'lokal');
      if (h && !karta.has(h.id)) karta.set(h.id, h);
    }
    // En rättelse ("Fel – det var …") ersätter den felaktiga händelsen
    const ersatta = new Set();
    for (const h of karta.values()) if (h.ersatter) ersatta.add(h.ersatter);
    return Array.from(karta.values())
      .filter((h) => !ersatta.has(h.id))
      .sort((a, b) => a.t - b.t);
  }

  function senasteFor(objektId, alla) {
    const lista = alla || allaHandelser();
    for (let i = lista.length - 1; i >= 0; i--) if (lista[i].objektId === objektId) return lista[i];
    return null;
  }

  /** Härledd status: senaste händelsen; en utgången timer ger efterTimer-utfallet. */
  function statusFor(o, alla, nu) {
    const h = senasteFor(o.id, alla);
    if (!h) return { status: o.status || 'smutsig', handelse: null, timerSlut: null };
    if (h.status === 'pagar' && h.timerSlut && h.timerSlut <= (nu || Date.now())) {
      return { status: o.efterTimer === 'ren' ? 'ren' : 'smutsig', handelse: h, timerSlut: null, utgangen: true };
    }
    const dagar = HV.karta && HV.karta.VATTNA ? HV.karta.VATTNA[o.id] : 0;
    if (dagar && h.status === 'ren') {
      const t = Date.parse(h.tid);
      if (Number.isFinite(t)) {
        const nasta = t + dagar * 864e5;
        return { status: (nu || Date.now()) >= nasta ? 'smutsig' : 'ren', handelse: h, timerSlut: null, nastaVattning: nasta };
      }
    }
    return { status: h.status, handelse: h, timerSlut: h.status === 'pagar' ? h.timerSlut : null };
  }

  function laggTill(h) {
    const post = {
      id: 'L-' + Date.now().toString(36) + Math.random().toString(36).slice(2, 6),
      tid: new Date().toISOString(),
      ...h,
    };
    lokala.push(post);
    if (lokala.length > 2000) lokala = lokala.slice(-2000);
    lagring.sparaJson(LS_HANDELSER, lokala);
    return post;
  }

  // ---------- Tilldelning ----------
  function tilldelad(objektId) {
    const a = repo.tilldelningar[objektId];
    const b = lokalaTill[objektId];
    const v = !a ? b : !b ? a : a.t >= b.t ? a : b;
    return v ? v.person : null;
  }

  function tilldela(objektId, person) {
    lokalaTill[objektId] = { person: PERSONER.includes(person) ? person : null, t: Date.now() };
    lagring.sparaJson(LS_TILLDELNINGAR, lokalaTill);
  }

  // ---------- Person på den här enheten ----------
  function aktuellPerson() {
    const p = lagring.lasJson(LS_PERSON, null);
    return PERSONER.includes(p) ? p : null;
  }
  function valjPerson(p) {
    if (PERSONER.includes(p)) lagring.sparaJson(LS_PERSON, p);
  }

  // ---------- Statistik ----------
  function periodStart(period, nu) {
    const d = new Date(nu || Date.now());
    d.setHours(0, 0, 0, 0);
    if (period === 'vecka') {
      const dag = (d.getDay() + 6) % 7; // måndag = 0
      d.setDate(d.getDate() - dag);
    } else if (period === 'manad') {
      d.setDate(1);
    } else {
      return 0;
    }
    return d.getTime();
  }

  /** En "insats" = någon startade (pågår) eller gjorde rent. */
  function arInsats(h) {
    return !h.auto && PERSONER.includes(h.person) && (h.status === 'ren' || h.status === 'pagar');
  }

  function statistik(period, nu) {
    const fran = periodStart(period, nu);
    const perPerson = {};
    const perObjekt = {};
    PERSONER.forEach((p) => (perPerson[p] = 0));
    for (const h of allaHandelser()) {
      if (h.t < fran || !arInsats(h)) continue;
      perPerson[h.person]++;
      // Uppgiftstyp (t.ex. "Plocka ur disken") räknas som egen rad, annars objektet
      const nyckel = h.uppgift ? 'uppgift:' + h.uppgift : h.objektId;
      perObjekt[nyckel] = perObjekt[nyckel] || {};
      perObjekt[nyckel][h.person] = (perObjekt[nyckel][h.person] || 0) + 1;
    }
    const topp = PERSONER.slice().sort((a, b) => perPerson[b] - perPerson[a]);
    const mest = perPerson[topp[0]] > perPerson[topp[1]] ? topp[0] : null;
    return { perPerson, perObjekt, mest, fran };
  }

  /** Föreslå vem som tar varje smutsig uppgift så att veckans antal jämnas ut. */
  function rattvisFordelning(uppgifter) {
    const { perPerson } = statistik('vecka');
    const last = { ...perPerson };
    const forslag = [];
    for (const o of uppgifter) {
      const person = PERSONER.slice().sort((a, b) => last[a] - last[b] || PERSONER.indexOf(a) - PERSONER.indexOf(b))[0];
      forslag.push({ objekt: o, person });
      last[person]++;
    }
    return { forslag, bas: perPerson };
  }

  // ---------- Export/import av lokala delar ----------
  function lokalaData() {
    return { handelser: lokala.slice(), tilldelningar: { ...lokalaTill } };
  }
  function ersattLokala(data) {
    lokala = Array.isArray(data.handelser) ? data.handelser.filter((h) => stadaHandelse(h, 'lokal')) : [];
    lokalaTill = {};
    if (data.tilldelningar && typeof data.tilldelningar === 'object') {
      for (const [id, v] of Object.entries(data.tilldelningar)) {
        if (v && Number.isFinite(v.t) && (v.person === null || PERSONER.includes(v.person))) lokalaTill[id] = v;
      }
    }
    lagring.sparaJson(LS_HANDELSER, lokala);
    lagring.sparaJson(LS_TILLDELNINGAR, lokalaTill);
  }

  /** Visningsnamn: Robot → 🤖 Robot. */
  function personText(p, reserv) {
    return p === ROBOT ? '🤖 Robot' : p || (reserv === undefined ? '–' : reserv);
  }

  HV.hushall = {
    PERSONER,
    ROBOT,
    personText,
    laddaRepo,
    repo: () => repo,
    allaHandelser,
    senasteFor,
    statusFor,
    laggTill,
    tilldelad,
    tilldela,
    aktuellPerson,
    valjPerson,
    statistik,
    rattvisFordelning,
    arInsats,
    lokalaData,
    ersattLokala,
  };
})();

/* Husvakten – huvudlogik: objekt, status (härledd ur händelseloggen), lista, objektblad,
 * timer, bildbedömning, person, statistik, galleri, rättvis fördelning, export/import.
 */
(function () {
  'use strict';
  const HV = window.HV;
  const { lagring, karta, ml, hushall } = HV;

  // ---------- Konstanter ----------
  const STATUSTEXT = { smutsig: 'Smutsig', pagar: 'Pågår', ren: 'Ren' };
  const HANDLINGSTEXT = { smutsig: 'markerade smutsig', pagar: 'startade', ren: 'gjorde rent/klart' };
  const ETIKETTER = {
    vanlig: [
      { id: 'ren', text: 'Ren', status: 'ren' },
      { id: 'smutsig', text: 'Smutsig', status: 'smutsig' },
    ],
    disk: [
      { id: 'tom', text: 'Tom', status: 'ren' },
      { id: 'fylld', text: 'Fylld', status: 'smutsig' },
      { id: 'startad', text: 'Startad', status: 'pagar' },
      { id: 'renfull', text: 'Ren disk – plocka ur', status: 'ren' },
    ],
  };
  const ALLA_ETIKETTER = ['ren', 'smutsig', 'tom', 'fylld', 'startad', 'renfull'];
  const RANG = { smutsig: 0, pagar: 1, ren: 2 };
  const LS_NOTIFIERADE = 'husvakten.notifierade';

  // ---------- Hjälpare ----------
  const $ = (s, r) => (r || document).querySelector(s);

  function h(tag, attr, ...barn) {
    const e = document.createElement(tag);
    if (attr) {
      for (const [k, v] of Object.entries(attr)) {
        if (v === null || v === undefined || v === false) continue;
        if (k === 'class') e.className = v;
        else if (k.startsWith('on') && typeof v === 'function') e.addEventListener(k.slice(2), v);
        else e.setAttribute(k, v === true ? '' : v);
      }
    }
    for (const b of barn.flat()) {
      if (b === null || b === undefined || b === false) continue;
      e.appendChild(typeof b === 'string' || typeof b === 'number' ? document.createTextNode(String(b)) : b);
    }
    return e;
  }

  function nyttId() {
    return 'o' + Date.now().toString(36) + Math.random().toString(36).slice(2, 6);
  }

  function etiketterFor(o) {
    return ETIKETTER[o.typ === 'disk' ? 'disk' : 'vanlig'];
  }

  function etikettInfo(o, id) {
    return etiketterFor(o).find((e) => e.id === id) || { id, text: id, status: 'smutsig' };
  }

  function formatTid(ms) {
    const s = Math.max(0, Math.round(ms / 1000));
    const hh = Math.floor(s / 3600);
    const mm = Math.floor((s % 3600) / 60);
    const ss = s % 60;
    const p = (n) => String(n).padStart(2, '0');
    return hh > 0 ? hh + ':' + p(mm) + ':' + p(ss) : p(mm) + ':' + p(ss);
  }

  const datumFmt = new Intl.DateTimeFormat('sv-SE', { weekday: 'short', day: 'numeric', month: 'short', hour: '2-digit', minute: '2-digit' });
  function formatDatum(t) {
    try {
      return datumFmt.format(new Date(t));
    } catch (e) {
      return new Date(t).toLocaleString();
    }
  }

  let toastTimer = null;
  function toast(msg, ms) {
    const t = $('#toast');
    t.textContent = msg;
    t.hidden = false;
    clearTimeout(toastTimer);
    toastTimer = setTimeout(() => (t.hidden = true), ms || 3200);
  }

  // ---------- Tillstånd (objektlistan) ----------
  function standardTillstand() {
    return {
      version: 1,
      objekt: karta.STANDARDOBJEKT.map((o) => stadaObjekt({ efterTimer: 'paminn', ...o, status: 'smutsig' })),
    };
  }

  function stadaObjekt(o) {
    if (!o || typeof o !== 'object') return null;
    const namn = String(o.namn || '').trim().slice(0, 40);
    if (!namn) return null;
    const tal = (v, min, max, std) => {
      const n = Number(v);
      return Number.isFinite(n) ? Math.min(max, Math.max(min, n)) : std;
    };
    return {
      id: String(o.id || nyttId()).slice(0, 40),
      namn,
      emoji: String(o.emoji || '📍').slice(0, 4),
      rum: o.rum ? String(o.rum).slice(0, 30) : null,
      x: tal(o.x, 280, 1010, 600),
      y: tal(o.y, 20, 870, 400),
      zon: o.zon && karta.ZONER[o.zon] ? o.zon : null,
      typ: o.typ === 'disk' ? 'disk' : 'vanlig',
      timerMin: tal(o.timerMin, 1, 1440, 60),
      efterTimer: o.efterTimer === 'ren' ? 'ren' : 'paminn',
      status: ['smutsig', 'pagar', 'ren'].includes(o.status) ? o.status : 'smutsig', // grundläge utan händelser
      andrad: Number(o.andrad) || Date.now(),
    };
  }

  let S = (() => {
    const las = lagring.lasTillstand();
    const bas = las ? { version: 1, objekt: las.objekt.map(stadaObjekt).filter(Boolean) } : standardTillstand();
    // Nya standardobjekt (t.ex. Tvättmaskinen) läggs till hos befintliga användare
    for (const std of karta.STANDARDOBJEKT) {
      if (!bas.objekt.some((o) => o.id === std.id) && !(las && las.borttagna && las.borttagna.includes(std.id))) {
        bas.objekt.push(stadaObjekt({ efterTimer: 'paminn', ...std, status: 'smutsig' }));
      }
    }
    bas.borttagna = (las && Array.isArray(las.borttagna)) ? las.borttagna : [];
    return bas;
  })();

  function spara() {
    if (!lagring.sparaTillstand(S)) toast('⚠️ Kunde inte spara – är lagringen full eller avstängd?');
  }

  function hitta(id) {
    return S.objekt.find((o) => o.id === id);
  }

  /** Aktuell status för ett objekt (härledd ur loggen). */
  function aktuell(o, alla) {
    return hushall.statusFor(o, alla || hushall.allaHandelser());
  }

  // ---------- Person ----------
  function kravPerson() {
    const p = hushall.aktuellPerson();
    if (p) return Promise.resolve(p);
    return new Promise((resolve) => {
      const d = $('#vem');
      let valt = null;
      $('#vem-knappar').replaceChildren(
        ...hushall.PERSONER.map((namn) => h('button', { class: 'knapp primar', onclick: () => { valt = namn; hushall.valjPerson(namn); stangDialog(d); } }, namn))
      );
      const onClose = () => {
        d.removeEventListener('close', onClose);
        ritaPersonvaljare();
        resolve(valt);
      };
      d.addEventListener('close', onClose);
      oppnaDialog(d);
    });
  }

  function ritaPersonvaljare() {
    const nu = hushall.aktuellPerson();
    $('#personvaljare').replaceChildren(
      ...hushall.PERSONER.map((namn) =>
        h('button', { class: namn === nu ? 'aktiv' : '', 'aria-pressed': String(namn === nu), onclick: () => { hushall.valjPerson(namn); ritaPersonvaljare(); toast('Hej ' + namn + '!'); } }, namn)
      )
    );
  }

  /** Registrera en händelse (status + vem + ev. foto/timer). */
  async function registrera(o, status, opts) {
    const { timerMin, foto, ersatter } = opts || {};
    const person = await kravPerson();
    if (!person) {
      toast('Välj vem du är först');
      return null;
    }
    const post = {
      objektId: o.id,
      status,
      person,
      timerMin: status === 'pagar' && timerMin ? timerMin : null,
      timerSlut: status === 'pagar' && timerMin ? new Date(Date.now() + timerMin * 60000).toISOString() : null,
      ersatter: ersatter || null,
    };
    const h0 = hushall.laggTill(post);
    if (foto) {
      try {
        await lagring.sparaFoto(h0.id, foto);
        h0.bild = 'idb:' + h0.id;
        // uppdatera posten i localStorage med bildreferensen
        const data = hushall.lokalaData();
        const i = data.handelser.findIndex((x) => x.id === h0.id);
        if (i >= 0) {
          data.handelser[i].bild = h0.bild;
          hushall.ersattLokala(data);
        }
      } catch (e) {
        console.warn(e);
        toast('Bilden kunde inte sparas i galleriet');
      }
    }
    o.status = status;
    o.andrad = Date.now();
    spara();
    ritaAllt();
    return h0;
  }

  // ---------- Rendering ----------
  const svg = $('#karta');
  let valtId = null;
  let placeraId = null;
  let flik = 'hem';

  function vyObjekt() {
    const alla = hushall.allaHandelser();
    const nu = Date.now();
    return S.objekt.map((o) => {
      const a = aktuell(o, alla);
      return { ...o, status: a.status, timerSlut: a.timerSlut, nastaVattning: a.nastaVattning, senast: a.handelse, tilldelad: hushall.tilldelad(o.id), vattning: vattningFor(o, alla, nu) };
    });
  }

  /** Nedräkning till nästa vattning: "Vattna om 3 d 4 h" / "Vattna idag!" / "Försenad 2 d". */
  function nedrakningText(nasta, nu) {
    const kvar = nasta - nu;
    if (kvar <= 0) {
      const dagar = Math.floor(-kvar / 864e5);
      return dagar >= 1 ? { text: 'Försenad ' + dagar + ' d', klass: 'sen' } : { text: 'Vattna idag!', klass: 'idag' };
    }
    const slutIdag = new Date(nu); slutIdag.setHours(23, 59, 59, 999);
    const d = Math.floor(kvar / 864e5);
    const tim = Math.floor((kvar % 864e5) / 36e5);
    const min = Math.max(1, Math.floor((kvar % 36e5) / 6e4));
    if (nasta <= slutIdag.getTime()) return { text: 'Vattna idag! (om ' + (tim ? tim + ' h' : min + ' min') + ')', klass: 'idag' };
    return { text: 'Vattna om ' + (d ? d + ' d ' + tim + ' h' : tim ? tim + ' h' : min + ' min'), klass: 'ok' };
  }

  /** Vattningsläge för en växt (null för allt som inte vattnas). Utgår från senaste "ren" = vattnad. */
  function vattningFor(o, alla, nu) {
    const dagar = karta.VATTNA[o.id];
    if (!dagar) return null;
    const art = (karta.VAXTART[o.id] || {}).art || o.namn;
    let senast = null;
    for (let i = alla.length - 1; i >= 0; i--) {
      const hh = alla[i];
      if (hh.objektId === o.id && hh.status === 'ren') {
        const t = Date.parse(hh.tid);
        if (Number.isFinite(t)) { senast = t; break; }
      }
    }
    if (senast === null) return { art, dagar, senast: null, nasta: null, text: 'Aldrig vattnad – vattna!', klass: 'sen' };
    const nasta = senast + dagar * 864e5;
    return { art, dagar, senast, nasta, ...nedrakningText(nasta, nu) };
  }

  /** Kortet "🪴 Växterna" på startsidan. */
  function ritaVaxter(vy) {
    const vaxter = vy.filter((o) => o.vattning);
    const kort = $('#vaxter-kort');
    kort.hidden = !vaxter.length;
    const dagFmt = (ms) => new Date(ms).toLocaleDateString('sv-SE', { weekday: 'short', day: 'numeric', month: 'short' });
    $('#vaxter').replaceChildren(
      ...vaxter
        .sort((a, b) => (a.vattning.nasta ?? -Infinity) - (b.vattning.nasta ?? -Infinity))
        .map((o) =>
          h('li', null,
            h('button', { class: 'vaxt-rad st-' + o.status, onclick: () => oppnaBlad(o.id) },
              h('span', { class: 'rad-emoji' }, o.emoji),
              h('span', { class: 'vaxt-info' },
                h('strong', null, o.namn),
                h('span', { class: 'vaxt-art-text' }, o.vattning.art),
                h('span', { class: 'fin blockrad' },
                  'Var ' + o.vattning.dagar + ':e dag · ' + (o.vattning.senast ? 'senast ' + dagFmt(o.vattning.senast) : 'aldrig vattnad')),
                karta.KULA[o.id] ? h('span', { class: 'fin blockrad' }, '🫧 ' + karta.KULA[o.id].mangd) : null
              ),
              h('span', { class: 'vaxt-nedrakning-text ' + o.vattning.klass }, o.vattning.text)
            )
          )
        )
    );
  }

  function ritaAllt() {
    const vy = vyObjekt();
    ritaOversikt(vy);
    karta.rita(svg, vy, valtId, (id) => {
      if (placeraId) return;
      oppnaBlad(id);
    });
    ritaLista(vy);
    ritaVaxter(vy);
    if (bladId) ritaBladHuvud();
    if (flik === 'statistik') ritaStatistik();
    if (flik === 'galleri') ritaGalleri();
  }

  function ritaOversikt(vy) {
    const n = { smutsig: 0, pagar: 0, ren: 0 };
    for (const o of vy) n[o.status]++;
    const ov = $('#oversikt');
    if (n.smutsig === 0) {
      ov.textContent = n.pagar ? 'Inget smutsigt – ' + n.pagar + ' pågår ⏳' : 'Allt är rent ✨';
      ov.className = 'oversikt klar';
    } else {
      ov.textContent = n.smutsig === 1 ? '1 sak behöver göras' : n.smutsig + ' saker behöver göras';
      ov.className = 'oversikt atgard';
    }
    $('#chips').replaceChildren(
      h('span', { class: 'chip smutsig' }, n.smutsig + ' smutsiga'),
      h('span', { class: 'chip pagar' }, n.pagar + ' pågår'),
      h('span', { class: 'chip ren' }, n.ren + ' rena')
    );
    const r = hushall.repo();
    $('#synk').textContent = r.laddad ? '☁️ delad logg' : r.fel ? '⚠️ bara lokalt' : '';
    $('#synk').title = r.laddad ? 'Delad logg inläst ur valvet (' + r.handelser.length + ' händelser)' : r.fel || '';
  }

  /** "💧 Vattna lör 3 okt" / "💧 Dags att vattna" (+ senast vattnad i objektbladet). */
  function vattnaText(nasta, senastIso) {
    const dag = (ms) => new Date(ms).toLocaleDateString('sv-SE', { weekday: 'short', day: 'numeric', month: 'short' });
    const idag = new Date(); idag.setHours(0, 0, 0, 0);
    const txt = nasta <= Date.now() ? '💧 Dags att vattna' : '💧 Vattna ' + (nasta - idag.getTime() < 864e5 ? 'idag' : dag(nasta));
    return senastIso ? txt + ' (senast ' + dag(Date.parse(senastIso)) + ')' : txt;
  }

  function ritaLista(vy) {
    const lista = $('#lista');
    const prio = (o) => karta.PRIO[o.id] || 3;
    // Ej rena först (P1 → P3), därefter rena
    const sorterade = vy.slice().sort((a, b) =>
      (a.status === 'ren') - (b.status === 'ren') || prio(a) - prio(b) || RANG[a.status] - RANG[b.status] || a.namn.localeCompare(b.namn, 'sv'));
    lista.replaceChildren(
      ...sorterade.map((o) =>
        h('li', null,
          h('button', { class: 'rad st-' + o.status, onclick: () => oppnaBlad(o.id) },
            h('span', { class: 'rad-emoji' }, o.emoji),
            h('span', { class: 'prio prio-' + prio(o), title: 'Prioritet inför gäster' }, 'P' + prio(o)),
            h('span', { class: 'rad-namn' }, o.namn,
              o.tilldelad ? h('span', { class: 'tilldelad' }, ' → ' + o.tilldelad) : null,
              o.vattning ? h('span', { class: 'vattna ' + o.vattning.klass }, ' · 💧 ' + o.vattning.text) : null
            ),
            o.status === 'pagar' && o.timerSlut
              ? h('span', { class: 'nedrakning', 'data-slut': String(o.timerSlut) }, formatTid(o.timerSlut - Date.now()))
              : null,
            h('span', { class: 'badge st-' + o.status }, STATUSTEXT[o.status])
          )
        )
      )
    );
    if (!sorterade.length) lista.appendChild(h('li', { class: 'tom-lista' }, 'Inga objekt ännu – lägg till ett!'));
  }

  // ---------- Flikar ----------
  document.querySelectorAll('.flik').forEach((b) =>
    b.addEventListener('click', () => {
      flik = b.dataset.flik;
      document.querySelectorAll('.flik').forEach((x) => {
        x.classList.toggle('aktiv', x === b);
        x.setAttribute('aria-selected', String(x === b));
      });
      document.querySelectorAll('[data-vy]').forEach((v) => (v.hidden = v.dataset.vy !== flik));
      ritaAllt();
    })
  );

  // ---------- Dialoger ----------
  function oppnaDialog(d) {
    try {
      if (!d.open) d.showModal();
    } catch (e) {
      d.setAttribute('open', '');
    }
  }
  function stangDialog(d) {
    try {
      d.close();
    } catch (e) {
      d.removeAttribute('open');
    }
  }
  document.querySelectorAll('dialog').forEach((d) => {
    d.addEventListener('click', (e) => {
      if (e.target === d) stangDialog(d); // klick på bakgrunden
      if (e.target.closest('[data-stang]')) stangDialog(d);
    });
  });

  // ---------- Objektblad ----------
  let bladId = null;
  let senasteBild = null; // { objektId, emb, thumb, foto, handelseId }

  $('#blad').addEventListener('close', () => {
    bladId = null;
    valtId = null;
    senasteBild = null;
    ritaAllt();
  });

  function oppnaBlad(id) {
    const o = hitta(id);
    if (!o) return;
    bladId = id;
    valtId = id;
    senasteBild = null;
    const valjFil = (e) => {
      const f = e.target.files && e.target.files[0];
      e.target.value = '';
      if (f) hanteraFoto(o.id, f);
    };
    $('#blad-inne').replaceChildren(
      h('div', { id: 'blad-huvud' }),
      h('section', { class: 'sektion' },
        h('h3', null, '📷 Fota och bedöm'),
        h('label', { class: 'knapp primar bred fota' }, 'Ta en bild',
          h('input', { type: 'file', accept: 'image/*', capture: 'environment', hidden: true, onchange: valjFil })
        ),
        h('label', { class: 'knapp bred' }, 'Välj bild från galleriet',
          h('input', { type: 'file', accept: 'image/*', hidden: true, onchange: valjFil })
        ),
        h('div', { id: 'bedomning', class: 'bedomning', 'aria-live': 'polite' })
      ),
      h('section', { class: 'sektion' }, h('h3', null, '🕓 Senaste händelser'), h('div', { id: 'historik' })),
      h('section', { class: 'sektion' }, h('h3', null, '🧠 Träning'), h('div', { id: 'traning' }, 'Laddar …')),
      h('section', { class: 'sektion knapprad' },
        h('button', { class: 'knapp', onclick: () => startaPlacering(o.id) }, '📍 Flytta på kartan'),
        h('button', { class: 'knapp', onclick: () => oppnaRedigera(o.id) }, '✏️ Ändra'),
        h('button', { class: 'knapp fara', onclick: () => taBortObjekt(o.id) }, '🗑 Ta bort')
      ),
      h('button', { class: 'knapp bred', 'data-stang': true }, 'Stäng')
    );
    ritaBladHuvud();
    ritaTraning(o.id);
    oppnaDialog($('#blad'));
    ritaAllt();
  }

  function ritaBladHuvud() {
    const o = hitta(bladId);
    const hv = $('#blad-huvud');
    if (!o || !hv) return;
    const alla = hushall.allaHandelser();
    const a = aktuell(o, alla);
    const till = hushall.tilldelad(o.id);
    const knappar = [
      h('button', { class: 'knapp st-knapp smutsig', onclick: () => registrera(o, 'smutsig') }, 'Smutsig'),
      h('button', { class: 'knapp st-knapp ren', onclick: () => registrera(o, 'ren') }, 'Ren'),
    ];
    if (a.status === 'pagar') {
      knappar.push(h('button', { class: 'knapp st-knapp pagar', onclick: () => registrera(o, 'ren') }, 'Klar nu'));
    } else {
      knappar.push(h('button', { class: 'knapp st-knapp pagar', onclick: async () => {
        const min = await fragaTimer(o);
        if (min) registrera(o, 'pagar', { timerMin: min });
      } }, '⏱ Starta'));
    }
    const s = a.handelse;
    hv.replaceChildren(
      h('div', { class: 'blad-titel' },
        h('span', { class: 'blad-emoji' }, o.emoji),
        h('div', null,
          h('h2', null, o.namn),
          h('span', { class: 'badge st-' + a.status }, STATUSTEXT[a.status]),
          a.nastaVattning ? h('div', { class: 'vattna' }, vattnaText(a.nastaVattning, s && s.tid)) : null,
          karta.KULA[o.id] ? h('div', { class: 'vattna' }, '🫧 Fyll kulan: ' + karta.KULA[o.id].mangd + ' var ' + karta.VATTNA[o.id] + ':e dag. ' + karta.KULA[o.id].rad) : null,
          a.status === 'pagar' && a.timerSlut
            ? h('span', { class: 'nedrakning stor', 'data-slut': String(a.timerSlut) }, formatTid(a.timerSlut - Date.now()))
            : null,
          s ? h('p', { class: 'fin' }, (s.person || 'Någon') + ' ' + HANDLINGSTEXT[s.status] + ' ' + formatDatum(s.t) + (s.notis ? ' · ' + s.notis : '') + (a.utgangen ? ' · timern har gått ut' : '')) : null
        )
      ),
      h('p', { class: 'fin' }, 'Sätt status själv:'),
      h('div', { class: 'knapprad tre' }, knappar),
      h('p', { class: 'fin' }, 'Ansvarig:'),
      h('div', { class: 'segment' },
        [...hushall.PERSONER, null].map((p) =>
          h('button', { class: p === till ? 'aktiv' : '', onclick: () => { hushall.tilldela(o.id, p); ritaAllt(); } }, p || 'Ingen')
        )
      )
    );
    ritaHistorik(o, alla);
  }

  function ritaHistorik(o, alla) {
    const ruta = $('#historik');
    if (!ruta) return;
    const egna = alla.filter((x) => x.objektId === o.id).slice(-6).reverse();
    if (!egna.length) {
      ruta.replaceChildren(h('p', { class: 'fin' }, 'Inga händelser ännu.'));
      return;
    }
    ruta.replaceChildren(
      h('ul', { class: 'historik' },
        egna.map((x) =>
          h('li', null,
            h('span', { class: 'badge st-' + x.status }, STATUSTEXT[x.status]), ' ',
            h('strong', null, x.person || '–'), ' ', formatDatum(x.t),
            x.timerMin ? ' · ' + x.timerMin + ' min' : '',
            x.bild ? ' · 📷' : '',
            x.kalla === 'delad' ? ' ☁️' : ''
          )
        )
      )
    );
  }

  async function ritaTraning(objektId) {
    const o = hitta(objektId);
    const ruta = $('#traning');
    if (!o || !ruta) return;
    let exempel = [];
    try {
      exempel = await lagring.exempelFor(objektId);
    } catch (e) {
      ruta.textContent = 'Kunde inte läsa träningsdata: ' + e.message;
      return;
    }
    if (bladId !== objektId) return;
    const antal = ml.raknaPerEtikett(exempel);
    const redo = ml.tillrackligt(exempel);
    ruta.replaceChildren(
      h('p', { class: 'fin' },
        redo
          ? 'Husvakten kan bedöma ' + o.namn.toLowerCase() + ' (' + exempel.length + ' exempel). Ju fler, desto säkrare.'
          : 'För få exempel för att bedöma. Behövs minst ' + ml.MIN_PER_KLASS + ' bilder i minst två kategorier – fota och märk bilderna.'
      ),
      h('div', { class: 'etikett-rader' },
        etiketterFor(o).map((et) => {
          const bilder = exempel.filter((x) => x.etikett === et.id);
          return h('div', { class: 'etikett-rad' },
            h('div', { class: 'etikett-namn' }, h('span', { class: 'badge st-' + et.status }, et.text), ' ', (antal[et.id] || 0) + ' st'),
            h('div', { class: 'miniatyrer' },
              bilder.slice(-12).map((b) =>
                h('div', { class: 'miniatyr' },
                  b.thumb ? h('img', { src: b.thumb, alt: et.text + '-exempel' }) : h('span', null, '🖼'),
                  h('button', { class: 'miniatyr-bort', 'aria-label': 'Ta bort exempel', onclick: async () => {
                    try {
                      await lagring.taBortExempel(b.id);
                      ml.glom(objektId);
                      ritaTraning(objektId);
                    } catch (e) {
                      toast('Kunde inte ta bort: ' + e.message);
                    }
                  } }, '✕')
                )
              )
            )
          );
        })
      )
    );
  }

  // ---------- Bildbedömning ----------
  async function hanteraFoto(objektId, fil) {
    const o = hitta(objektId);
    const ruta = $('#bedomning');
    if (!o || !ruta) return;
    let bild;
    try {
      bild = await ml.filTillBild(fil);
    } catch (e) {
      ruta.replaceChildren(h('p', { class: 'fel' }, e.message));
      return;
    }
    const { canvas, thumb, foto } = ml.forbered(bild.img);
    URL.revokeObjectURL(bild.url);
    const status = h('p', { class: 'fin' }, 'Analyserar …');
    ruta.replaceChildren(h('div', { class: 'bedomning-rad' }, h('img', { class: 'forhand', src: thumb, alt: 'Din bild' }), status));

    let emb = null;
    try {
      await ml.ladda((t) => (status.textContent = t));
      await synkaDeladTraning(objektId, (t) => (status.textContent = t));
      status.textContent = 'Analyserar bilden …';
      emb = await ml.embedding(canvas);
    } catch (e) {
      console.error(e);
      status.textContent = 'Bildmodellen kunde inte laddas (' + e.message + '). Sätt status för bilden själv – den sparas i galleriet:';
      senasteBild = { objektId, emb: null, thumb, foto };
      ruta.appendChild(etikettKnappar(o));
      return;
    }
    if (bladId !== objektId) return;
    senasteBild = { objektId, emb, thumb, foto };

    let exempel = [];
    try {
      exempel = await lagring.exempelFor(objektId);
    } catch (e) {
      console.warn(e);
    }
    let res = null;
    try {
      res = await ml.bedom(objektId, emb, exempel);
    } catch (e) {
      console.error(e);
      ruta.appendChild(h('p', { class: 'fel' }, 'Bedömningen misslyckades: ' + e.message));
    }

    if (!res) {
      status.textContent = 'För få exempel för att bedöma ' + o.namn.toLowerCase() + ' än. Vad visar bilden? Märk den så lär sig Husvakten (och status sätts):';
      ruta.appendChild(etikettKnappar(o));
      return;
    }

    const info = etikettInfo(o, res.etikett);
    const procent = Math.round(res.sakerhet * 100);
    status.replaceChildren('Ser ', h('strong', { class: 'st-text ' + info.status }, info.text.toUpperCase()), ' ut – ', h('strong', null, procent + ' %'), ' säker.');
    if (procent < 60) status.appendChild(h('span', { class: 'fin blockrad' }, 'Osäkert – rätta gärna om det är fel.'));

    // Tillämpa bedömningen direkt (händelse med foto)
    const hand = await tillampa(o, info, foto);
    if (senasteBild) senasteBild.handelseId = hand ? hand.id : null;

    const rad = h('div', { class: 'knapprad' },
      h('button', { class: 'knapp primar', onclick: () => larIn(o, info.id, rad, true) }, '✓ Rätt – lär in'),
      etiketterFor(o).filter((et) => et.id !== info.id).map((et) =>
        h('button', { class: 'knapp', onclick: () => larIn(o, et.id, rad) }, 'Fel – det var ' + et.text.toLowerCase())
      )
    );
    ruta.appendChild(rad);
  }

  function etikettKnappar(o) {
    const rad = h('div', { class: 'knapprad tre' },
      etiketterFor(o).map((et) => h('button', { class: 'knapp st-knapp ' + et.status, onclick: () => larIn(o, et.id, rad) }, et.text))
    );
    return rad;
  }

  async function tillampa(o, info, foto, ersatter) {
    if (info.status === 'pagar') {
      const min = await fragaTimer(o);
      if (!min) return null;
      return registrera(o, 'pagar', { timerMin: min, foto, ersatter });
    }
    return registrera(o, info.status, { foto, ersatter });
  }

  async function larIn(o, etikettId, knapprad, redanTillampad) {
    if (!senasteBild || senasteBild.objektId !== o.id) {
      toast('Ta en ny bild först.');
      return;
    }
    const bild = senasteBild;
    senasteBild = null;
    if (knapprad) knapprad.querySelectorAll('button').forEach((b) => (b.disabled = true));
    try {
      const info = etikettInfo(o, etikettId);
      if (bild.emb) {
        await lagring.laggTillExempel({ objektId: o.id, etikett: etikettId, emb: bild.emb, thumb: bild.thumb, modell: ml.MODELL_ID });
        ml.glom(o.id);
      }
      if (!redanTillampad) await tillampa(o, info, bild.foto, bild.handelseId || null);
      if (knapprad) knapprad.replaceWith(h('p', { class: 'ok' }, bild.emb ? '✓ Inlärt som "' + info.text + '". Tack!' : '✓ Sparat som "' + info.text + '".'));
      ritaTraning(o.id);
    } catch (e) {
      console.error(e);
      toast('Kunde inte spara exemplet: ' + e.message);
      if (knapprad) knapprad.querySelectorAll('button').forEach((b) => (b.disabled = false));
      senasteBild = bild;
    }
  }

  /** Delade träningsbilder från den krypterade loggen (data/valv/) → embeddings i IndexedDB (en gång per bild). */
  async function synkaDeladTraning(objektId, onStatus) {
    const seeds = hushall.repo().traning.filter((x) => !objektId || x.objektId === objektId);
    if (!seeds.length) return 0;
    const finns = new Set((await lagring.allaExempel()).map((x) => x.seedId).filter(Boolean));
    let n = 0;
    for (const s of seeds) {
      if (finns.has(s.id)) continue;
      try {
        onStatus && onStatus('Läser in delad träningsbild …');
        const blob = await HV.valv.hamtaBlob(s.bild);
        const bild = await ml.filTillBild(new File([blob], 'seed.jpg', { type: 'image/jpeg' }));
        const { canvas, thumb } = ml.forbered(bild.img);
        URL.revokeObjectURL(bild.url);
        const emb = await ml.embedding(canvas);
        await lagring.laggTillExempel({ objektId: s.objektId, etikett: s.etikett, emb, thumb, modell: ml.MODELL_ID, seedId: s.id });
        ml.glom(s.objektId);
        n++;
      } catch (e) {
        console.warn('Husvakten: delad träningsbild kunde inte läsas', s.bild, e);
      }
    }
    return n;
  }

  // ---------- Timer ----------
  function fragaTimer(o) {
    return new Promise((resolve) => {
      const d = $('#timer-dialog');
      const form = $('#timer-form');
      const falt = form.elements.min;
      falt.value = o.timerMin || 60;
      $('#timer-fraga').textContent = o.namn + ' – nedräkning. När den går ut ' + (o.efterTimer === 'ren' ? 'markeras den som ren.' : 'får du en påminnelse.');
      const snabb = o.typ === 'disk' ? [45, 60, 90, 150] : [15, 30, 60, 120];
      $('#timer-snabb').replaceChildren(
        ...snabb.map((m) => h('button', { type: 'button', class: 'knapp liten', onclick: () => (falt.value = m) }, m + ' min'))
      );
      let svar = null;
      const onSubmit = (e) => {
        e.preventDefault();
        const m = Math.round(Number(falt.value));
        if (!Number.isFinite(m) || m < 1 || m > 1440) {
          falt.setCustomValidity('Ange 1–1440 minuter');
          falt.reportValidity();
          return;
        }
        falt.setCustomValidity('');
        svar = m;
        stangDialog(d);
      };
      const onClose = () => {
        form.removeEventListener('submit', onSubmit);
        d.removeEventListener('close', onClose);
        resolve(svar);
      };
      form.addEventListener('submit', onSubmit);
      d.addEventListener('close', onClose);
      oppnaDialog(d);
      setTimeout(() => falt.focus(), 50);
    });
  }

  let notifierade = new Set(lagring.lasJson(LS_NOTIFIERADE, []));
  function kontrolleraTimrar(vidStart) {
    const alla = hushall.allaHandelser();
    const nu = Date.now();
    let nya = false;
    for (const o of S.objekt) {
      const a = aktuell(o, alla);
      if (!a.utgangen || notifierade.has(a.handelse.id)) continue;
      notifierade.add(a.handelse.id);
      nya = true;
      const gammal = nu - a.handelse.timerSlut > 60 * 60000; // mer än en timme sedan: ingen notis
      if (gammal) continue;
      const msg = o.efterTimer === 'ren' ? o.namn + ' är klar ✓' : 'Påminnelse: dags att kolla ' + o.namn.toLowerCase();
      meddela(msg + (vidStart ? ' (medan du var borta)' : ''));
    }
    if (nya) {
      lagring.sparaJson(LS_NOTIFIERADE, Array.from(notifierade).slice(-500));
      ritaAllt();
    }
  }

  function meddela(msg) {
    toast('⏰ ' + msg, 6000);
    try {
      if (navigator.vibrate) navigator.vibrate([200, 100, 200]);
    } catch (e) {
      /* vibration stöds inte – ofarligt */
    }
    try {
      if ('Notification' in window && Notification.permission === 'granted') {
        new Notification('Husvakten', { body: msg, tag: 'husvakten-' + msg });
      }
    } catch (e) {
      console.warn('Husvakten: notis misslyckades', e);
    }
  }

  function tick() {
    const nu = Date.now();
    document.querySelectorAll('.nedrakning[data-slut]').forEach((el) => {
      el.textContent = formatTid(Number(el.dataset.slut) - nu);
    });
    kontrolleraTimrar(false);
  }

  // ---------- Placering ----------
  function startaPlacering(id) {
    const o = hitta(id);
    if (!o) return;
    placeraId = id;
    stangDialog($('#blad'));
    $('#placera-text').textContent = 'Tryck på kartan där "' + o.namn + '" ska stå';
    $('#placera-banner').hidden = false;
    svg.classList.add('placerar');
    svg.scrollIntoView({ behavior: 'smooth', block: 'center' });
  }

  function avslutaPlacering() {
    placeraId = null;
    $('#placera-banner').hidden = true;
    svg.classList.remove('placerar');
  }

  svg.addEventListener('click', (e) => {
    if (!placeraId) return;
    const o = hitta(placeraId);
    if (!o) return avslutaPlacering();
    const p = karta.tillSvg(svg, e.clientX, e.clientY);
    o.x = p.x;
    o.y = p.y;
    const rum = karta.rumVid(svg, p.x, p.y);
    if (rum) o.rum = rum;
    o.andrad = Date.now();
    avslutaPlacering();
    spara();
    ritaAllt();
    toast('📍 ' + o.namn + ' placerad');
  });
  $('#placera-avbryt').addEventListener('click', avslutaPlacering);

  // ---------- Nytt / ändra ----------
  let redigeraId = null;
  function oppnaRedigera(id) {
    redigeraId = id || null;
    const o = id ? hitta(id) : null;
    const f = $('#redigera-form');
    f.reset();
    $('#redigera-titel').textContent = o ? 'Ändra ' + o.namn : 'Nytt objekt';
    f.querySelector('button[type=submit]').textContent = o ? 'Spara' : 'Spara och placera';
    if (o) {
      f.elements.namn.value = o.namn;
      f.elements.emoji.value = o.emoji;
      f.elements.typ.value = o.typ;
      f.elements.timerMin.value = o.timerMin;
      f.elements.efterTimer.value = o.efterTimer;
      stangDialog($('#blad'));
    } else {
      f.elements.efterTimer.value = 'paminn';
    }
    oppnaDialog($('#redigera'));
  }

  $('#redigera-form').addEventListener('submit', (e) => {
    e.preventDefault();
    const f = e.target;
    const namn = f.elements.namn.value.trim().slice(0, 40);
    if (!namn) {
      f.elements.namn.reportValidity();
      return;
    }
    const data = {
      namn,
      emoji: (f.elements.emoji.value.trim() || '📍').slice(0, 4),
      typ: f.elements.typ.value === 'disk' ? 'disk' : 'vanlig',
      timerMin: Math.min(1440, Math.max(1, Math.round(Number(f.elements.timerMin.value) || 60))),
      efterTimer: f.elements.efterTimer.value === 'ren' ? 'ren' : 'paminn',
    };
    stangDialog($('#redigera'));
    if (redigeraId) {
      const o = hitta(redigeraId);
      if (o) {
        const bytteTyp = o.typ !== data.typ;
        Object.assign(o, data, { andrad: Date.now() });
        spara();
        ritaAllt();
        if (bytteTyp) toast('Sorten ändrades – gamla exempel med andra etiketter räknas inte längre.');
      }
    } else {
      const o = stadaObjekt({ id: nyttId(), ...data, x: 640, y: 560, rum: 'vardagsrum', status: 'smutsig' });
      S.objekt.push(o);
      spara();
      ritaAllt();
      startaPlacering(o.id);
    }
  });
  $('#knapp-ny').addEventListener('click', () => oppnaRedigera(null));

  async function taBortObjekt(id) {
    const o = hitta(id);
    if (!o) return;
    if (!confirm('Ta bort "' + o.namn + '" och dess träningsbilder?')) return;
    try {
      await lagring.taBortExempelFor(id);
    } catch (e) {
      console.warn(e);
    }
    ml.glom(id);
    S.objekt = S.objekt.filter((x) => x.id !== id);
    if (!S.borttagna.includes(id)) S.borttagna.push(id);
    spara();
    stangDialog($('#blad'));
    ritaAllt();
  }

  // ---------- Rättvis fördelning ----------
  $('#knapp-rattvis').addEventListener('click', () => {
    const smutsiga = vyObjekt().filter((o) => o.status === 'smutsig');
    const { forslag, bas } = hushall.rattvisFordelning(smutsiga);
    const inne = $('#fordelning-inne');
    inne.replaceChildren(
      h('h2', null, '⚖️ Rättvis fördelning'),
      h('p', { class: 'fin' }, 'Hittills i veckan: ' + hushall.PERSONER.map((p) => p + ' ' + bas[p]).join(', ') + '. Den som gjort minst får nästa uppgift.'),
      forslag.length
        ? h('ul', { class: 'historik' }, forslag.map((f) => h('li', null, f.objekt.emoji + ' ' + f.objekt.namn + ' → ', h('strong', null, f.person))))
        : h('p', null, 'Inget smutsigt just nu – inget att fördela ✨'),
      h('div', { class: 'knapprad' },
        h('button', { class: 'knapp', 'data-stang': true }, 'Stäng'),
        forslag.length
          ? h('button', { class: 'knapp primar', onclick: () => {
              forslag.forEach((f) => hushall.tilldela(f.objekt.id, f.person));
              stangDialog($('#fordelning'));
              ritaAllt();
              toast('Uppgifterna är fördelade');
            } }, 'Tilldela så här')
          : null
      )
    );
    oppnaDialog($('#fordelning'));
  });

  // ---------- Statistik ----------
  let period = 'vecka';
  $('#period').addEventListener('click', (e) => {
    const b = e.target.closest('[data-period]');
    if (!b) return;
    period = b.dataset.period;
    $('#period').querySelectorAll('button').forEach((x) => x.classList.toggle('aktiv', x === b));
    ritaStatistik();
  });

  function stapel(varde, max, klass) {
    const pct = max ? Math.round((varde / max) * 100) : 0;
    return h('div', { class: 'stapel-spar' }, h('div', { class: 'stapel ' + klass, style: 'width:' + pct + '%' }), h('span', { class: 'stapel-tal' }, String(varde)));
  }

  function ritaStatistik() {
    const st = hushall.statistik(period);
    const max = Math.max(1, ...Object.values(st.perPerson));
    const namnFor = (id) => {
      if (id.startsWith('uppgift:')) return '✅ ' + id.slice(8);
      const o = hitta(id);
      return o ? o.emoji + ' ' + o.namn : id;
    };
    const perObjekt = Object.entries(st.perObjekt).sort((a, b) => {
      const sa = Object.values(a[1]).reduce((x, y) => x + y, 0);
      const sb = Object.values(b[1]).reduce((x, y) => x + y, 0);
      return sb - sa;
    });
    const maxObj = Math.max(1, ...perObjekt.flatMap(([, v]) => Object.values(v)));
    const senaste = hushall.allaHandelser().filter((x) => x.t >= st.fran && x.person).slice(-15).reverse();
    const periodText = { vecka: 'den här veckan', manad: 'den här månaden', allt: 'totalt' }[period];
    $('#statistik').replaceChildren(
      h('p', { class: 'mest' }, st.mest ? '🏆 ' + st.mest + ' har gjort mest ' + periodText + '!' : 'Jämnt ' + periodText + ' ⚖️'),
      h('div', { class: 'staplar' },
        hushall.PERSONER.map((p, i) => h('div', { class: 'stapel-rad' }, h('span', { class: 'stapel-namn' }, p), stapel(st.perPerson[p], max, 'p' + i)))
      ),
      h('p', { class: 'fin' }, 'Räknas: startat (pågår) och rent/klart.'),
      h('h3', null, 'Per sak'),
      perObjekt.length
        ? h('div', { class: 'staplar' },
            perObjekt.map(([id, v]) =>
              h('div', { class: 'objekt-stat' },
                h('div', { class: 'objekt-stat-namn' }, namnFor(id)),
                hushall.PERSONER.map((p, i) => h('div', { class: 'stapel-rad liten' }, h('span', { class: 'stapel-namn' }, p), stapel(v[p] || 0, maxObj, 'p' + i)))
              )
            )
          )
        : h('p', { class: 'fin' }, 'Inga insatser registrerade ' + periodText + '.'),
      h('h3', null, 'Vem gjorde vad'),
      senaste.length
        ? h('ul', { class: 'historik' },
            senaste.map((x) => h('li', null, h('span', { class: 'badge st-' + x.status }, STATUSTEXT[x.status]), ' ', h('strong', null, x.person), ' ' + (x.uppgift ? x.uppgift.toLowerCase() + ' –' : HANDLINGSTEXT[x.status]) + ' ', namnFor(x.objektId), h('span', { class: 'fin' }, ' · ' + formatDatum(x.t))))
          )
        : h('p', { class: 'fin' }, 'Inget ännu.')
    );
  }

  // ---------- Galleri ----------
  async function bildUrl(x) {
    if (!x.bild) return null;
    if (x.bild.startsWith('idb:')) return lagring.lasFoto(x.bild.slice(4));
    return HV.valv.bildUrl(x.bild); // krypterad i data/valv/ → object-URL
  }

  async function ritaGalleri() {
    const ruta = $('#galleri');
    const med = hushall.allaHandelser().filter((x) => x.bild).reverse();
    if (!med.length) {
      ruta.replaceChildren(h('p', { class: 'fin' }, 'Inga bilder ännu. Fota ett objekt så hamnar bilden här.'));
      return;
    }
    const kort = [];
    const urls = await Promise.all(med.map(bildUrl)); // dekrypteras parallellt
    for (const [i, x] of med.entries()) {
      const o = hitta(x.objektId);
      const url = urls[i];
      if (!url) continue;
      kort.push(
        h('button', { class: 'galleri-kort', onclick: () => visaBild(x, url, o) },
          h('img', { src: url, alt: (o ? o.namn : x.objektId) + ' ' + formatDatum(x.t), loading: 'lazy' }),
          h('span', { class: 'galleri-text' },
            h('span', { class: 'badge st-' + x.status }, STATUSTEXT[x.status]),
            h('span', null, (o ? o.emoji + ' ' + o.namn : x.objektId)),
            h('span', { class: 'fin' }, (x.person || '–') + ' · ' + formatDatum(x.t))
          )
        )
      );
    }
    if (flik === 'galleri') ruta.replaceChildren(...kort);
  }

  function visaBild(x, url, o) {
    $('#visare-inne').replaceChildren(
      h('img', { class: 'visare-bild', src: url, alt: 'Bild' }),
      h('p', null, h('span', { class: 'badge st-' + x.status }, STATUSTEXT[x.status]), ' ', h('strong', null, o ? o.namn : x.objektId)),
      h('p', { class: 'fin' }, (x.person || '–') + ' ' + HANDLINGSTEXT[x.status] + ' ' + formatDatum(x.t) + (x.timerMin ? ' · timer ' + x.timerMin + ' min' : '') + (x.notis ? ' · ' + x.notis : '')),
      h('button', { class: 'knapp bred', 'data-stang': true }, 'Stäng')
    );
    oppnaDialog($('#visare'));
  }

  // ---------- Meny: export / import / notiser ----------
  $('#knapp-meny').addEventListener('click', () => oppnaDialog($('#meny')));

  $('#meny').addEventListener('click', async (e) => {
    const b = e.target.closest('[data-meny]');
    if (!b) return;
    const val = b.dataset.meny;
    if (val === 'export') await exportera();
    else if (val === 'notiser') await tillatNotiser();
    else if (val === 'forladda') {
      stangDialog($('#meny'));
      toast('Laddar bildmodellen …', 20000);
      try {
        await ml.ladda((t) => toast(t, 20000));
        const n = await synkaDeladTraning(null);
        toast('🧠 Bildmodellen är redo' + (n ? ' (' + n + ' delade träningsbilder inlästa)' : ''));
      } catch (err) {
        toast('Kunde inte ladda modellen: ' + err.message, 6000);
      }
    } else if (val === 'aterstall') {
      if (!confirm('Radera ALLA objekt, lokala händelser och träningsbilder på den här telefonen? Den delade loggen påverkas inte. Exportera först om du vill spara dem.')) return;
      try {
        await lagring.rensaExempel();
      } catch (err) {
        console.warn(err);
      }
      hushall.ersattLokala({ handelser: [], tilldelningar: {} });
      S = standardTillstand();
      S.borttagna = [];
      spara();
      stangDialog($('#meny'));
      ritaAllt();
      toast('Återställt');
    }
  });

  async function exportera() {
    try {
      const exempel = await lagring.allaExempel();
      const lok = hushall.lokalaData();
      const foton = {};
      for (const x of lok.handelser) {
        if (x.bild && x.bild.startsWith('idb:')) {
          const d = await lagring.lasFoto(x.bild.slice(4));
          if (d) foton[x.bild] = d;
        }
      }
      const data = {
        app: 'husvakten',
        version: 2,
        exporterad: new Date().toISOString(),
        modell: ml.MODELL_ID,
        tillstand: S,
        lokalt: lok,
        foton,
        exempel: exempel.map(({ objektId, etikett, emb, thumb, t, modell }) => ({ objektId, etikett, emb, thumb, t, modell })),
      };
      const blob = new Blob([JSON.stringify(data)], { type: 'application/json' });
      const url = URL.createObjectURL(blob);
      const a = h('a', { href: url, download: 'husvakten-' + new Date().toISOString().slice(0, 10) + '.json' });
      document.body.appendChild(a);
      a.click();
      a.remove();
      setTimeout(() => URL.revokeObjectURL(url), 5000);
      toast('⬇️ Exporterade ' + S.objekt.length + ' objekt, ' + lok.handelser.length + ' händelser och ' + exempel.length + ' exempel');
    } catch (e) {
      console.error(e);
      toast('Exporten misslyckades: ' + e.message, 6000);
    }
  }

  $('#import-fil').addEventListener('change', async (e) => {
    const fil = e.target.files && e.target.files[0];
    e.target.value = '';
    if (!fil) return;
    try {
      if (fil.size > 80 * 1024 * 1024) throw new Error('Filen är för stor (max 80 MB)');
      const data = JSON.parse(await fil.text());
      if (!data || data.app !== 'husvakten' || !data.tillstand || !Array.isArray(data.tillstand.objekt) || !Array.isArray(data.exempel)) {
        throw new Error('Det här ser inte ut som en Husvakten-export');
      }
      const objekt = data.tillstand.objekt.map(stadaObjekt).filter(Boolean);
      const ids = new Set(objekt.map((o) => o.id));
      const exempel = data.exempel.filter((x) =>
        x && ids.has(String(x.objektId)) && ALLA_ETIKETTER.includes(x.etikett) &&
        Array.isArray(x.emb) && x.emb.length > 0 && x.emb.length <= 4096 && x.emb.every(Number.isFinite) &&
        (!x.thumb || (typeof x.thumb === 'string' && x.thumb.startsWith('data:image/') && x.thumb.length < 300000))
      );
      if (!confirm('Importera ' + objekt.length + ' objekt och ' + exempel.length + ' exempel? Det ersätter allt lokalt som finns nu.')) return;
      await lagring.rensaExempel();
      for (const x of exempel) await lagring.laggTillExempel({ ...x, thumb: x.thumb || '' });
      if (data.lokalt) hushall.ersattLokala(data.lokalt);
      if (data.foton && typeof data.foton === 'object') {
        for (const [nyckel, d] of Object.entries(data.foton)) {
          if (/^idb:[\w-]+$/.test(nyckel) && typeof d === 'string' && d.startsWith('data:image/jpeg') && d.length < 5e6) {
            await lagring.sparaFoto(nyckel.slice(4), d);
          }
        }
      }
      S = { version: 1, objekt, borttagna: Array.isArray(data.tillstand.borttagna) ? data.tillstand.borttagna.map(String) : [] };
      spara();
      S.objekt.forEach((o) => ml.glom(o.id));
      stangDialog($('#meny'));
      ritaAllt();
      const skippade = data.exempel.length - exempel.length;
      toast('⬆️ Importerat' + (skippade ? ' (' + skippade + ' ogiltiga exempel hoppades över)' : ''), 5000);
    } catch (err) {
      console.error(err);
      toast('Importen misslyckades: ' + err.message, 6000);
    }
  });

  async function tillatNotiser() {
    try {
      if (!('Notification' in window)) throw new Error('Webbläsaren stöder inte notiser');
      const svar = await Notification.requestPermission();
      toast(svar === 'granted' ? '🔔 Påminnelser på (medan sidan är öppen)' : 'Notiser nekades – du får fortfarande påminnelser i appen');
    } catch (e) {
      toast(e.message);
    }
  }

  // ---------- Start ----------
  karta.byggGrund(svg);
  ritaPersonvaljare();
  ritaAllt();
  setInterval(tick, 1000);
  // Växternas nedräkning uppdateras varje minut (bara karta, växtkort och lista – inte galleriet).
  setInterval(() => {
    if (document.hidden || placeraId || flik !== 'hem') return;
    const vy = vyObjekt();
    karta.rita(svg, vy, valtId, (id) => {
      if (placeraId) return;
      oppnaBlad(id);
    });
    ritaVaxter(vy);
    ritaLista(vy);
  }, 60000);
  document.addEventListener('visibilitychange', () => {
    if (!document.hidden) {
      hushall.laddaRepo().then(ritaAllt);
      tick();
    }
  });
  hushall.laddaRepo().then(() => {
    // Objekt som vakthunden lagt till i den delade loggen
    for (const raw of hushall.repo().objekt) {
      const o = stadaObjekt(raw);
      if (o && !hitta(o.id) && !S.borttagna.includes(o.id)) S.objekt.push(o);
    }
    spara();
    kontrolleraTimrar(true);
    ritaAllt();
    if (!hushall.aktuellPerson()) kravPerson();
  });

  // Exponera för felsökning/röktest
  window.HV_APP = { get S() { return S; }, oppnaBlad, registrera, hitta, aktuell, vyObjekt };
})();

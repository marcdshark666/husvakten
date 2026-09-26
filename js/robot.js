/* Husvakten – robotfliken (Roborock S7 MaxV).
 * Data: data/valv/robot/robot.json.enc + karta.png.enc (krypterade, byggs av
 * `python verktyg/roborock/robo.py publicera`). Allt dekrypteras i minnet via HV.valv.lasFil.
 * Visar status, förbrukningsdelar, 2D-karta med SVG-överlägg och en lat laddad 3D-vy (three.js).
 */
(function () {
  'use strict';
  const HV = (window.HV = window.HV || {});
  const SVGNS = 'http://www.w3.org/2000/svg';
  const THREE_URL = 'https://cdn.jsdelivr.net/npm/three@0.160.0/+esm';
  const ORBIT_URL = 'https://cdn.jsdelivr.net/npm/three@0.160.0/examples/jsm/controls/OrbitControls.js/+esm';
  const VARNA_PROCENT = 15;
  const VAGGHOJD_M = 0.28;
  const HISTORIK_STEG = 10; // städposter per "Visa fler"

  const HINDERIKON = {
    clothes: '👕', shoes: '👟', sock: '🧦', cable: '🔌', 'power strip': '🔌', poop: '💩', 'pet waste': '💩',
    'weighing scale': '⚖️', 'weighting scale': '⚖️', 'furniture with a crossbar': '🪑', pedestal: '🪑',
    dustpan: '🧹', fabric: '🧣', pet: '🐾', bed: '🛏️', sofa: '🛋️',
  };

  let data = null;       // robot.json
  let bildUrl = null;    // object-URL till kartbilden
  let laddning = null;   // Promise
  let ritad = false;
  const val = { vag: false, hinder: true, tre: false };
  let tre = null;        // { renderer, stang }
  let vakt = null;       // robot/logg.json (Vaktloggen från verktyg/roborock/live.py)
  let vaktFel = null;
  let vaktAldre = false; // "Visa äldre händelser" utfälld
  let vaktTimer = 0;
  const VAKT_POLL_MS = 60000;
  const PAGAR_MAX_MIN = 15; // "pågår nu" bara om loggen uppdaterats nyligen
  const fotoCache = new Map(); // robot/foton/<id>.jpg -> Promise<objectURL|null>

  // ---------- Hjälpare ----------
  function h(tag, attr, ...barn) {
    const e = document.createElement(tag);
    for (const [k, v] of Object.entries(attr || {})) {
      if (v === null || v === undefined || v === false) continue;
      if (k === 'class') e.className = v;
      else if (k.startsWith('on') && typeof v === 'function') e.addEventListener(k.slice(2), v);
      else e.setAttribute(k, v === true ? '' : v);
    }
    for (const b of barn.flat(Infinity)) {
      if (b === null || b === undefined || b === false) continue;
      e.appendChild(typeof b === 'string' || typeof b === 'number' ? document.createTextNode(String(b)) : b);
    }
    return e;
  }

  function s(tag, attr, text) {
    const e = document.createElementNS(SVGNS, tag);
    for (const [k, v] of Object.entries(attr || {})) if (v !== null && v !== undefined) e.setAttribute(k, v);
    if (text !== undefined) e.textContent = text;
    return e;
  }

  const datumFmt = new Intl.DateTimeFormat('sv-SE', { weekday: 'short', day: 'numeric', month: 'short', hour: '2-digit', minute: '2-digit' });
  function datum(iso) {
    const t = Date.parse(iso || '');
    return Number.isFinite(t) ? datumFmt.format(new Date(t)) : '–';
  }
  function sedan(iso) {
    const t = Date.parse(iso || '');
    if (!Number.isFinite(t)) return '';
    const min = Math.round((Date.now() - t) / 6e4);
    if (min < 1) return 'nyss';
    if (min < 60) return 'för ' + min + ' min sedan';
    const tim = Math.round(min / 60);
    if (tim < 48) return 'för ' + tim + ' h sedan';
    return 'för ' + Math.round(tim / 24) + ' d sedan';
  }
  const tal = (n) => (typeof n === 'number' ? n.toLocaleString('sv-SE') : '–');
  const pts = (arr) => arr.map((p) => p[0] + ',' + p[1]).join(' ');

  // ---------- Laddning ----------
  function ladda() {
    if (!laddning) {
      laddning = (async () => {
        const [json, png] = await Promise.all([HV.valv.lasFil('robot/robot.json'), HV.valv.lasFil('robot/karta.png')]);
        const d = JSON.parse(new TextDecoder().decode(json));
        if (!d || d.version !== 1 || !d.karta) throw new Error('Okänt format på robot.json');
        data = d;
        bildUrl = URL.createObjectURL(new Blob([png], { type: 'image/png' }));
      })().catch((e) => {
        laddning = null; // försök igen nästa gång fliken öppnas
        throw e;
      });
    }
    return laddning;
  }

  /** Visa robotfliken i `el`. Idempotent – ritar bara en gång per session. */
  async function visa(el) {
    if (!el || ritad) return;
    if (!data) el.replaceChildren(h('section', { class: 'kort' }, h('p', { class: 'fin' }, '🤖 Dekrypterar robotdatan …')));
    try {
      await Promise.all([ladda(), laddaVakt()]);
    } catch (e) {
      el.replaceChildren(h('section', { class: 'kort' },
        h('h2', null, '🤖 Robot'),
        h('p', { class: 'fin' }, 'Kunde inte läsa robotdatan: ' + e.message),
        h('p', { class: 'fin' }, 'Den publiceras med python verktyg/roborock/robo.py publicera.')));
      return;
    }
    try {
      el.replaceChildren(vaktKort(), skanningsKort(), statusKort(), kartKort(), stadningsKort(), installningsKort() || '', hinderfotoKort() || '');
      ritad = true;
      tickaUppdaterad(el);
      bevakaVakt(el);
    } catch (e) {
      console.error('Husvakten: robotfliken kunde inte ritas', e);
      el.replaceChildren(h('section', { class: 'kort' }, h('h2', null, '🤖 Robot'),
        h('p', { class: 'fin' }, 'Robotfliken kunde inte visas: ' + e.message)));
    }
  }

  /** Håll "Uppdaterad för X min sedan" färsk medan fliken är öppen. */
  let tickare = 0;
  function tickaUppdaterad(el) {
    clearInterval(tickare);
    tickare = setInterval(() => {
      if (!el.isConnected) return clearInterval(tickare);
      for (const p of el.querySelectorAll('.robot-uppdaterad')) p.textContent = uppdateradText();
    }, 60000);
  }

  function uppdateradText() {
    const t = (data.status && data.status.hamtad) || data.uppdaterad || data.publicerad;
    return t ? '🔄 Uppdaterad ' + sedan(t) + ' (' + datum(t) + ')' : '🔄 Okänd uppdateringstid';
  }

  // ---------- Vaktloggen (📡 live-tidslinje från verktyg/roborock/live.py) ----------
  async function laddaVakt() {
    try {
      const buf = await HV.valv.lasFil('robot/logg.json');
      const d = JSON.parse(new TextDecoder().decode(buf));
      if (!d || d.version !== 1 || !Array.isArray(d.handelser)) throw new Error('Okänt format på vaktloggen');
      vakt = d;
      vaktFel = null;
    } catch (e) {
      // 404 = ingen logg ännu (inget fel att visa); annat fel visas diskret, gammal data behålls
      vaktFel = /HTTP 404/.test(e.message) ? null : e.message;
    }
  }

  /** Hämta om loggen var 60:e s så länge robotfliken är öppen och synlig. */
  function bevakaVakt(el) {
    clearInterval(vaktTimer);
    vaktTimer = setInterval(async () => {
      if (!el.isConnected) return clearInterval(vaktTimer);
      if (el.hidden || document.hidden) return;
      const fore = vakt && vakt.uppdaterad;
      await laddaVakt();
      if (vakt && vakt.uppdaterad === fore && !vaktFel) {
        for (const p of el.querySelectorAll('.vakt-uppdaterad')) p.textContent = vaktUppdateradText();
        return;
      }
      const a = el.querySelector('.robot-vakt');
      const b = el.querySelector('.robot-skanning');
      if (a) a.replaceWith(vaktKort());
      if (b) b.replaceWith(skanningsKort());
    }, VAKT_POLL_MS);
  }

  function pagarNu() {
    if (!vakt || !vakt.pagar) return false;
    const t = Date.parse(vakt.uppdaterad || '');
    return Number.isFinite(t) && Date.now() - t < PAGAR_MAX_MIN * 6e4;
  }

  const klockFmt = new Intl.DateTimeFormat('sv-SE', { hour: '2-digit', minute: '2-digit' });
  function klocka(iso) {
    const t = Date.parse(iso || '');
    return Number.isFinite(t) ? klockFmt.format(new Date(t)) : '–';
  }

  function vaktUppdateradText() {
    return vakt && vakt.uppdaterad ? '🔄 Loggen uppdaterad ' + sedan(vakt.uppdaterad) + ' · hämtas om var 60:e s medan fliken är öppen' : '';
  }

  /** Robotens hinderfoto (krypterat i valvet) – dekrypteras en gång per session. */
  function robotFoto(fil, alt) {
    const fig = h('div', { class: 'vakt-foto' }, h('span', { class: 'robot-foto-laddar' }, '📷'));
    if (!fotoCache.has(fil)) {
      fotoCache.set(fil, HV.valv.lasFil(fil).then(
        (buf) => URL.createObjectURL(new Blob([buf], { type: 'image/jpeg' })),
        (e) => {
          console.warn('Husvakten: robotfoto kunde inte dekrypteras', fil, e);
          fotoCache.delete(fil);
          return null;
        }));
    }
    fotoCache.get(fil).then((url) => {
      if (url) fig.replaceChildren(h('img', { src: url, alt, loading: 'lazy' }));
      else fig.firstChild.textContent = '⚠️';
    });
    return fig;
  }

  const BEDOMNINGSTEXT = { smutsigt: 'smutsigt', stokigt: 'stökigt', rent: 'rent', misstankt: 'misstänkt', oklart: 'oklart' };
  function bedomningsNyckel(b) {
    const n = String(b || 'oklart').normalize('NFD').replace(/[̀-ͯ]/g, '');
    return BEDOMNINGSTEXT[n] ? n : 'oklart';
  }
  function aiRad(ai) {
    if (!ai) return null;
    const n = bedomningsNyckel(ai.bedomning);
    return h('div', { class: 'vakt-ai ai-' + n },
      h('span', { class: 'vakt-ai-tag' }, '🧠 AI: ' + BEDOMNINGSTEXT[n]),
      h('span', null, ai.text || ''));
  }

  function vaktRad(x) {
    return h('li', { class: 'vakt-rad typ-' + String(x.typ || 'info').replace(/[^\w-]/g, '') + (x.misstankt ? ' misstankt' : '') },
      h('span', { class: 'vakt-ikon', 'aria-hidden': 'true' }, x.ikon || 'ℹ️'),
      h('div', { class: 'vakt-innehall' },
        h('div', null, h('span', { class: 'vakt-tid' }, klocka(x.tid)), ' ', x.text || ''),
        x.misstankt && x.typ !== 'fel' ? h('div', { class: 'vakt-indikation' }, 'Misstänkt – bara en indikation') : null,
        x.foto ? robotFoto(x.foto, 'Robotens foto: ' + (x.text || 'hinder')) : null,
        aiRad(x.ai)));
  }

  function vaktKort() {
    const rubrik = h('div', { class: 'lista-huvud' }, h('h2', null, '📡 Vaktlogg'));
    if (!vakt) {
      return h('section', { class: 'kort robot-vakt', 'aria-label': 'Vaktlogg' }, rubrik,
        h('p', { class: 'fin' }, vaktFel ? 'Vaktloggen kunde inte läsas: ' + vaktFel
          : 'Ingen vaktlogg ännu. Den startar automatiskt när roboten börjar städa och visar steg för steg vad som händer.'));
    }
    const pagar = pagarNu();
    const k = pagar ? vakt.korning : vakt.senaste_korning;
    rubrik.appendChild(h('span', { class: 'vakt-chip' + (pagar ? ' pagar' : '') },
      pagar ? '🟢 Pågår nu' : k ? '⚪ Senaste körning' : '⚪ Ingen körning ännu'));
    const alla = vakt.handelser.slice().sort((a, b) => (Date.parse(b.tid) || 0) - (Date.parse(a.tid) || 0));
    const kid = k && k.id;
    const denna = kid ? alla.filter((x) => x.korning === kid) : alla.slice(0, 12);
    const ovriga = alla.filter((x) => !denna.includes(x));
    const misstankta = denna.filter((x) => x.misstankt);
    let sammanfattning = null;
    if (pagar && k) {
      sammanfattning = 'Startade ' + klocka(k.start) + ' via ' + (k.via || '?') + ' · ' + (k.lage || '') +
        (k.rum_nu ? ' i ' + k.rum_nu : '') + ' · ' + (k.fynd || 0) + ' fynd hittills';
    } else if (k) {
      sammanfattning = datum(k.start) + '–' + klocka(k.slut) + ' · ' + (k.minuter || 0) + ' min · ' + tal(k.yta_m2) + ' m² · ' +
        (k.fynd || 0) + ' fynd' + (k.klar ? '' : ' · avbruten');
    }
    const ul = h('ol', { class: 'vakt-lista' }, denna.map(vaktRad));
    const aldre = h('ol', { class: 'vakt-lista aldre', hidden: !vaktAldre }, ovriga.map(vaktRad));
    const etikett = () => (vaktAldre ? 'Dölj' : 'Visa') + ' äldre händelser (' + ovriga.length + ')';
    const knapp = ovriga.length ? h('button', {
      class: 'knapp liten', type: 'button',
      onclick: (ev) => {
        vaktAldre = !vaktAldre;
        aldre.hidden = !vaktAldre;
        ev.currentTarget.textContent = etikett();
      },
    }, etikett()) : null;
    return h('section', { class: 'kort robot-vakt' + (pagar ? ' pagar' : ''), 'aria-label': 'Vaktlogg' },
      rubrik,
      vakt.simulerad ? h('p', { class: 'robot-fel' }, '🧪 Simulerad testdata') : null,
      sammanfattning ? h('p', { class: 'vakt-sammanfattning' }, sammanfattning) : null,
      misstankta.length ? h('p', { class: 'vakt-varning' }, '⚠️ ' + misstankta.length + (misstankta.length === 1 ? ' sak' : ' saker') +
        ' att titta på – indikationer, inte säkra larm.') : null,
      denna.length ? ul : h('p', { class: 'fin' }, 'Inga händelser ännu.'),
      knapp, aldre,
      vaktFel ? h('p', { class: 'fin' }, '⚠️ Senaste hämtningen misslyckades: ' + vaktFel) : null,
      h('p', { class: 'fin vakt-uppdaterad' }, vaktUppdateradText()),
      h('p', { class: 'fin' }, 'Roboten läses bara – Husvakten styr den aldrig. "Misstänkt" är indikationer (t.ex. start utan schema, fel, ovanliga fynd), inte säkra larm.'));
  }

  // ---------- Senaste skanningen ----------
  function skanningsKort() {
    const sk = vakt && vakt.skanning;
    const rubrik = h('h2', null, '🔎 Senaste skanningen');
    const utanFoto = h('p', { class: 'fin' }, '📷 Inga foton ännu – roboten har inte hittat/fotograferat något ännu. ' +
      'Foton kommer efter körningar där den stöter på hinder (kläder, skor, kablar …).');
    if (!sk) {
      return h('section', { class: 'kort robot-skanning', 'aria-label': 'Senaste skanningen' }, rubrik,
        h('p', { class: 'fin' }, 'Ingen skanning ännu – roboten har inte städat sedan vaktloggen startade.'), utanFoto);
    }
    const rum = sk.rum || [];
    return h('section', { class: 'kort robot-skanning', 'aria-label': 'Senaste skanningen' }, rubrik,
      h('p', { class: 'fin' }, (sk.pagar ? 'Pågår – startade ' : 'Körningen ') + datum(sk.start) + ' · roboten täckte ' +
        (rum.length ? rum.map((r) => r.namn).join(', ') : 'okända rum') + '.'),
      rum.length ? h('ul', { class: 'skanning-lista' }, rum.map((r) => h('li', { class: r.fritt ? 'fritt' : 'fynd' },
        h('div', { class: 'skanning-rum' }, h('strong', null, r.namn), ' ',
          r.fritt ? h('span', { class: 'skanning-fritt' }, 'golvet fritt ✅' + ((r.fynd || []).length ? ' (' + r.fynd.length + ' hinder, inget skräp)' : ''))
            : h('span', { class: 'skanning-antal' }, (r.fynd || []).filter((f) => f.smuts !== false).length + ' fynd att plocka')),
        (r.fynd || []).map((f) => h('div', { class: 'skanning-fynd' },
          h('div', null, (f.ikon || '❓') + ' ' + (f.namn || 'Hinder') + (f.tid ? ' · ' + klocka(f.tid) : '')),
          f.foto ? robotFoto(f.foto, 'Robotens foto: ' + (f.namn || 'hinder')) : null,
          aiRad(f.ai)))))) : null,
      sk.foton ? null : utanFoto);
  }

  // ---------- Status ----------
  function statusKort() {
    const st = data.status || {};
    const tot = data.totalt || {};
    const senast = (data.stadningar || [])[0];
    const batt = typeof st.batteri === 'number' ? st.batteri : null;
    const lageKlass = st.felkod ? 'fel' : st.stadar ? 'stadar' : st.laddar ? 'laddar' : '';
    const delar = (st.delar || []).slice().sort((a, b) => a.kvar_procent - b.kvar_procent);
    const varningar = delar.filter((d) => d.kvar_procent < VARNA_PROCENT).length;
    return h('section', { class: 'kort robot-status', 'aria-label': 'Robotens status' },
      h('div', { class: 'lista-huvud' },
        h('h2', null, '🤖 ' + (data.kalla || 'Roboten')),
        h('span', { class: 'robot-lage ' + lageKlass }, (st.laddar && !st.stadar ? '🔌 ' : st.stadar ? '🧹 ' : '') + (st.lage || 'Okänt'))
      ),
      h('div', { class: 'robot-batteri', title: 'Batteri' },
        h('span', { class: 'robot-batteri-ikon' }, '🔋'),
        h('div', { class: 'stapel-spar' },
          h('div', { class: 'stapel ' + (batt !== null && batt < 20 ? 'lag' : 'bra'), style: 'width:' + (batt || 0) + '%' }),
          h('span', { class: 'stapel-tal' }, batt === null ? '–' : batt + ' %'))
      ),
      h('p', { class: 'fin robot-uppdaterad' }, uppdateradText()),
      st.felkod ? h('p', { class: 'robot-fel' }, '⚠️ Felkod ' + st.felkod) : null,
      h('p', { class: 'fin' }, senast
        ? 'Senaste städning: ' + datum(senast.start) + ' · ' + senast.minuter + ' min · ' + tal(senast.yta_m2) + ' m²' + (senast.klar ? '' : ' (avbruten)')
        : 'Ingen städning registrerad.'),
      h('div', { class: 'robot-siffror' },
        siffra(tal(tot.stadningar), 'städningar'),
        siffra(tal(tot.timmar) + ' h', 'total tid'),
        siffra(tal(tot.yta_m2) + ' m²', 'total yta')
      ),
      h('h3', { class: 'robot-delar-rubrik' }, 'Förbrukningsdelar' + (varningar ? ' – ⚠️ ' + varningar + ' behöver ses över' : '')),
      h('div', { class: 'staplar robot-delar' }, delar.map((d) => {
        const varna = d.kvar_procent < VARNA_PROCENT;
        return h('div', { class: 'robot-del' + (varna ? ' varna' : '') },
          h('div', { class: 'robot-del-namn' },
            h('span', null, (varna ? '⚠️ ' : '') + d.namn),
            h('span', { class: 'fin' }, tal(d.anvant) + ' / ' + tal(d.livslangd) + ' ' + d.enhet)),
          h('div', { class: 'stapel-spar' },
            h('div', { class: 'stapel ' + (varna ? 'lag' : d.kvar_procent < 40 ? 'mellan' : 'bra'), style: 'width:' + Math.max(0, Math.min(100, d.kvar_procent)) + '%' }),
            h('span', { class: 'stapel-tal' }, d.kvar_procent + ' % kvar')));
      }))
    );
  }

  function siffra(v, text) {
    return h('div', { class: 'robot-siffra' }, h('strong', null, v), h('span', { class: 'fin' }, text));
  }

  // ---------- Karta (2D) ----------
  function kartKort() {
    const k = data.karta;
    const ruta = h('div', { class: 'robot-karta-ruta', style: 'aspect-ratio:' + k.bredd + '/' + k.hojd });
    const img = h('img', { class: 'robot-karta-bild', src: bildUrl, alt: 'Robotens karta över bostaden', draggable: 'false' });
    const svg = s('svg', { class: 'robot-overlagg', viewBox: '0 0 ' + k.bredd + ' ' + k.hojd, 'aria-hidden': 'true' });
    ritaOverlagg(svg);
    ruta.append(img, svg);
    const treRuta = h('div', { class: 'robot-3d', hidden: true });

    const knapp = (id, text) => h('button', {
      class: 'knapp liten robot-vaxel' + (val[id] ? ' aktiv' : ''), 'aria-pressed': String(!!val[id]), 'data-val': id,
      onclick: (ev) => {
        val[id] = !val[id];
        const b = ev.currentTarget;
        b.classList.toggle('aktiv', val[id]);
        b.setAttribute('aria-pressed', String(val[id]));
        if (id === 'tre') vaxla3d(ruta, treRuta, b);
        else svg.classList.toggle('dolj-' + id, !val[id]);
      },
    }, text);
    svg.classList.toggle('dolj-vag', !val.vag);
    svg.classList.toggle('dolj-hinder', !val.hinder);

    return h('section', { class: 'kort robot-karta-kort', 'aria-label': 'Robotens karta' },
      h('div', { class: 'lista-huvud' },
        h('h2', null, '🗺️ Karta'),
        h('div', { class: 'robot-knappar' }, knapp('vag', '〰️ Städväg'), knapp('hinder', '👟 Hinder'), knapp('tre', '🧊 3D'))
      ),
      ruta, treRuta,
      h('div', { class: 'teckenforklaring' },
        h('span', null, h('i', { class: 'prick zon' }), 'Robotfri zon'),
        h('span', null, '⚡ Laddstation'),
        h('span', null, '🤖 Roboten'),
        h('span', null, '〰️ Senaste städvägen')
      ),
      h('p', { class: 'fin' }, 'Kartan kommer direkt från roboten (' + (data.kalla || 'Roborock') + ') och uppdaterades ' +
        datum(data.uppdaterad) + ' (' + sedan(data.uppdaterad) + '). Den ligger krypterad i valvet och visas bara efter inloggning.')
    );
  }

  function ritaOverlagg(svg) {
    const k = data.karta;
    const m = Math.max(k.bredd, k.hojd) / 800; // storlek på ikoner/text oberoende av bildens upplösning
    const gRum = s('g', { class: 'r-rum' });
    for (const r of k.rum || []) {
      for (const p of r.polygoner || []) if (p.length > 2) gRum.appendChild(s('polygon', { points: pts(p), stroke: r.farg }));
    }
    const gZon = s('g', { class: 'r-zoner' });
    for (const z of k.no_go || []) gZon.appendChild(s('polygon', { class: 'r-nogo', points: pts(z), 'stroke-width': 3 * m }));
    for (const z of k.no_mop || []) gZon.appendChild(s('polygon', { class: 'r-nomop', points: pts(z), 'stroke-width': 3 * m }));
    for (const w of k.virtuella_vaggar || []) gZon.appendChild(s('line', { class: 'r-vvagg', x1: w[0], y1: w[1], x2: w[2], y2: w[3], 'stroke-width': 5 * m }));
    const gVag = s('g', { class: 'r-vag' });
    for (const v of k.stadvag || []) if (v.length > 1) gVag.appendChild(s('polyline', { points: pts(v), 'stroke-width': 2.5 * m }));
    const gEtikett = s('g', { class: 'r-etiketter' });
    for (const r of k.rum || []) {
      if (!r.etikett) continue;
      gEtikett.appendChild(s('text', { x: r.etikett[0], y: r.etikett[1], 'font-size': 26 * m, 'stroke-width': 6 * m }, r.namn));
    }
    const gHinder = s('g', { class: 'r-hinder' });
    for (const o of k.hinder || []) {
      const g = s('g', { transform: 'translate(' + o.px[0] + ' ' + o.px[1] + ')' });
      g.appendChild(s('title', null, o.namn + (o.sakerhet ? ' (' + o.sakerhet + ' % säker)' : '')));
      g.appendChild(s('circle', { r: 17 * m, 'stroke-width': 2 * m }));
      g.appendChild(s('text', { 'font-size': 20 * m, dy: '0.35em' }, HINDERIKON[o.beskrivning] || '⚠️'));
      gHinder.appendChild(g);
    }
    const gPunkter = s('g', { class: 'r-punkter' });
    if (k.laddstation) {
      const [x, y] = k.laddstation.px;
      const g = s('g', { class: 'r-ladd', transform: 'translate(' + x + ' ' + y + ')' });
      g.appendChild(s('title', null, 'Laddstation'));
      g.appendChild(s('circle', { r: 16 * m, 'stroke-width': 2 * m }));
      g.appendChild(s('text', { 'font-size': 20 * m, dy: '0.35em' }, '⚡'));
      gPunkter.appendChild(g);
    }
    if (k.robot) {
      const [x, y] = k.robot.px;
      const a = ((k.robot.vinkel || 0) * Math.PI) / 180;
      const g = s('g', { class: 'r-robot', transform: 'translate(' + x + ' ' + y + ')' });
      g.appendChild(s('title', null, 'Roboten'));
      g.appendChild(s('line', { x1: 0, y1: 0, x2: Math.cos(a) * 30 * m, y2: -Math.sin(a) * 30 * m, 'stroke-width': 4 * m }));
      g.appendChild(s('circle', { r: 17 * m, 'stroke-width': 3 * m }));
      g.appendChild(s('text', { 'font-size': 18 * m, dy: '0.35em' }, '🤖'));
      gPunkter.appendChild(g);
    }
    svg.append(gRum, gZon, gVag, gEtikett, gHinder, gPunkter);
  }

  // ---------- 3D ----------
  function harWebGL() {
    try {
      const c = document.createElement('canvas');
      return !!(window.WebGLRenderingContext && (c.getContext('webgl2') || c.getContext('webgl')));
    } catch (e) {
      return false;
    }
  }

  async function vaxla3d(ruta, treRuta, knapp) {
    if (!val.tre) {
      if (tre) tre.stang();
      tre = null;
      treRuta.hidden = true;
      treRuta.replaceChildren();
      ruta.hidden = false;
      return;
    }
    ruta.hidden = true;
    treRuta.hidden = false;
    if (!harWebGL()) {
      treRuta.replaceChildren(h('p', { class: 'robot-3d-info' }, '3D kräver WebGL, som saknas i den här webbläsaren. Tryck på 3D igen för 2D-kartan.'));
      return;
    }
    treRuta.replaceChildren(h('p', { class: 'robot-3d-info' }, '🧊 Laddar 3D …'));
    try {
      const [THREE, orbit] = await Promise.all([import(THREE_URL), import(ORBIT_URL)]);
      if (!val.tre) return; // hann stängas under laddningen
      tre = bygg3d(THREE, orbit.OrbitControls, treRuta);
    } catch (e) {
      console.warn('Husvakten: 3D kunde inte starta', e);
      treRuta.replaceChildren(h('p', { class: 'robot-3d-info' }, '3D kunde inte laddas (' + e.message + '). Tryck på 3D igen för 2D-kartan.'));
      knapp.classList.remove('aktiv');
      val.tre = false;
      knapp.setAttribute('aria-pressed', 'false');
      setTimeout(() => { if (!val.tre) { treRuta.hidden = true; ruta.hidden = false; } }, 2500);
    }
  }

  function bygg3d(THREE, OrbitControls, behallare) {
    const k = data.karta;
    const mPerPx = k.cell_mm / 1000 / k.cell_px;
    const B = k.bredd * mPerPx;
    const D = k.hojd * mPerPx;
    const tillVarld = (px, py) => [px * mPerPx - B / 2, py * mPerPx - D / 2]; // [x, z]

    const canvas = h('canvas', { class: 'robot-3d-canvas', 'aria-label': '3D-vy av robotens karta' });
    const hjalp = h('p', { class: 'robot-3d-info liten' }, 'Dra för att snurra · nyp för att zooma · två fingrar för att flytta');
    behallare.replaceChildren(canvas, hjalp);

    const renderer = new THREE.WebGLRenderer({ canvas, antialias: true, alpha: true });
    renderer.setPixelRatio(Math.min(window.devicePixelRatio || 1, 2));
    const scen = new THREE.Scene();
    const kamera = new THREE.PerspectiveCamera(45, 1, 0.1, 200);
    kamera.position.set(0, Math.max(B, D) * 1.25, D * 0.95);

    scen.add(new THREE.HemisphereLight(0xdde8ff, 0x1a2233, 1.1));
    const sol = new THREE.DirectionalLight(0xffffff, 1.2);
    sol.position.set(B * 0.4, Math.max(B, D), D * 0.6);
    scen.add(sol);

    // Golv: kartbilden (rumsfärger) som textur
    const tex = new THREE.TextureLoader().load(bildUrl, () => rendera());
    tex.colorSpace = THREE.SRGBColorSpace;
    tex.magFilter = THREE.NearestFilter;
    const golv = new THREE.Mesh(new THREE.PlaneGeometry(B, D), new THREE.MeshLambertMaterial({ map: tex, transparent: true }));
    golv.rotation.x = -Math.PI / 2;
    scen.add(golv);

    // Väggar: sammanslagna rektanglar → en InstancedMesh (ett ritanrop)
    const rekt = k.vaggar || [];
    const gemensam = [];
    const box = new THREE.BoxGeometry(1, 1, 1);
    const vaggar = new THREE.InstancedMesh(box, new THREE.MeshLambertMaterial({ color: 0xd6deee }), Math.max(1, rekt.length));
    const mat = new THREE.Matrix4();
    const cm = k.cell_mm / 1000;
    rekt.forEach(([x, y, w, hh], i) => {
      const [cx, cz] = tillVarld((x + w / 2) * k.cell_px, (y + hh / 2) * k.cell_px);
      mat.makeScale(w * cm, VAGGHOJD_M, hh * cm);
      mat.setPosition(cx, VAGGHOJD_M / 2, cz);
      vaggar.setMatrixAt(i, mat);
    });
    vaggar.count = rekt.length;
    scen.add(vaggar);
    gemensam.push(box, vaggar.material, golv.geometry, golv.material, tex);

    // Robotfria zoner: halvgenomskinliga röda plattor
    const zonMat = new THREE.MeshBasicMaterial({ color: 0xff5a4f, transparent: true, opacity: 0.28, depthWrite: false });
    gemensam.push(zonMat);
    for (const z of k.no_go || []) {
      const xs = z.map((p) => p[0]);
      const ys = z.map((p) => p[1]);
      const x0 = Math.min(...xs), x1 = Math.max(...xs), y0 = Math.min(...ys), y1 = Math.max(...ys);
      const g = new THREE.PlaneGeometry((x1 - x0) * mPerPx, (y1 - y0) * mPerPx);
      gemensam.push(g);
      const p = new THREE.Mesh(g, zonMat);
      p.rotation.x = -Math.PI / 2;
      const [cx, cz] = tillVarld((x0 + x1) / 2, (y0 + y1) / 2);
      p.position.set(cx, 0.01, cz);
      scen.add(p);
    }

    // Laddstation, robot, hinder
    const punkt = (px, geo, farg, y) => {
      const mat2 = new THREE.MeshLambertMaterial({ color: farg });
      gemensam.push(geo, mat2);
      const m = new THREE.Mesh(geo, mat2);
      const [x, z] = tillVarld(px[0], px[1]);
      m.position.set(x, y, z);
      scen.add(m);
      return m;
    };
    if (k.laddstation) punkt(k.laddstation.px, new THREE.BoxGeometry(0.3, 0.12, 0.3), 0x3ddc84, 0.06);
    if (k.robot) punkt(k.robot.px, new THREE.CylinderGeometry(0.175, 0.175, 0.1, 32), 0xf2f5fb, 0.05);
    for (const o of k.hinder || []) punkt(o.px, new THREE.ConeGeometry(0.09, 0.22, 12), 0xffa53d, 0.11);

    const kontroll = new OrbitControls(kamera, canvas);
    kontroll.target.set(0, 0, 0);
    kontroll.maxPolarAngle = Math.PI * 0.47;
    kontroll.minDistance = 1.5;
    kontroll.maxDistance = Math.max(B, D) * 2.5;
    kontroll.update();

    let ram = 0;
    function rendera() {
      if (ram) return;
      ram = requestAnimationFrame(() => {
        ram = 0;
        renderer.render(scen, kamera);
      });
    }
    kontroll.addEventListener('change', rendera);

    function anpassa() {
      const b = behallare.clientWidth || 320;
      const hojd = Math.round(Math.min(b * (D / B), window.innerHeight * 0.7, b * 1.3));
      renderer.setSize(b, hojd, false);
      canvas.style.width = b + 'px';
      canvas.style.height = hojd + 'px';
      kamera.aspect = b / hojd;
      kamera.updateProjectionMatrix();
      rendera();
    }
    const ro = window.ResizeObserver ? new ResizeObserver(anpassa) : null;
    if (ro) ro.observe(behallare);
    anpassa();

    return {
      renderer,
      stang() {
        if (ro) ro.disconnect();
        if (ram) cancelAnimationFrame(ram);
        kontroll.dispose();
        for (const x of gemensam) try { x.dispose(); } catch (e) { /* redan frigjord */ }
        renderer.dispose();
        try { renderer.forceContextLoss(); } catch (e) { /* ignoreras – kontexten är redan borta */ }
      },
    };
  }

  // ---------- Städhistorik ----------
  function stadningsRad(r) {
    const extra = [];
    if (r.undvek) extra.push('undvek ' + r.undvek + ' hinder');
    if (r.startad_via) extra.push('startad via ' + r.startad_via);
    if (r.tomd) extra.push('dockan tömde');
    if (r.felkod) extra.push('⚠️ fel ' + r.felkod);
    return h('li', null,
      h('div', { class: 'robot-hist-rad' },
        h('strong', null, datum(r.start)),
        h('span', { class: 'robot-hist-tag ' + (r.klar ? 'klar' : 'avbruten') }, r.klar ? '✅ klar' : '⏹️ avbruten')),
      h('div', null, r.minuter + ' min · ' + tal(r.yta_m2) + ' m²'),
      extra.length ? h('div', { class: 'fin robot-hist-extra' }, extra.join(' · ')) : null);
  }

  function stadningsKort() {
    const alla = (data.stadningar || []).slice().sort((a, b) => (Date.parse(b.start) || 0) - (Date.parse(a.start) || 0));
    let visade = 0;
    const ul = h('ul', { class: 'historik robot-historik' });
    const fler = h('button', { class: 'knapp liten robot-fler', type: 'button' });
    function visaFler() {
      const nasta = alla.slice(visade, visade + HISTORIK_STEG);
      ul.append(...nasta.map(stadningsRad));
      visade += nasta.length;
      const kvar = alla.length - visade;
      fler.hidden = kvar <= 0;
      fler.textContent = 'Visa fler (' + kvar + ' kvar)';
    }
    fler.addEventListener('click', visaFler);
    visaFler();
    const klara = alla.filter((r) => r.klar).length;
    return h('section', { class: 'kort robot-historik-kort', 'aria-label': 'Städhistorik' },
      h('h2', null, '🧹 Städhistorik' + (alla.length ? ' (' + alla.length + ')' : '')),
      alla.length
        ? [h('p', { class: 'fin' }, klara + ' klara, ' + (alla.length - klara) + ' avbrutna av de ' + alla.length + ' senaste som roboten sparar.'), ul, fler]
        : h('p', { class: 'fin' }, 'Inga städningar ännu.')
    );
  }

  // ---------- Inställningar ----------
  function installningsKort() {
    const grupper = data.installningar || [];
    if (!grupper.length) return null;
    return h('section', { class: 'kort robot-installningar', 'aria-label': 'Robotens inställningar' },
      h('h2', null, '⚙️ Inställningar'),
      grupper.map((g) => h('div', { class: 'robot-inst-grupp' },
        h('h3', null, g.grupp),
        h('dl', null, (g.poster || []).map((p) => [h('dt', null, p.namn), h('dd', null, String(p.varde))])))),
      h('p', { class: 'fin' }, 'Avläst direkt ur roboten – ändras i Roborock-appen. Husvakten skickar aldrig ändringar till roboten.')
    );
  }

  // ---------- Hinderfoton ----------
  function hinderfotoKort() {
    const foton = data.hinderfoton || [];
    if (!foton.length) return null;
    const rutnat = h('div', { class: 'robot-foton' });
    for (const f of foton) {
      const fig = h('figure', { class: 'robot-foto' }, h('div', { class: 'robot-foto-laddar' }, '…'), h('figcaption', null, f.namn || 'Hinder'));
      rutnat.appendChild(fig);
      HV.valv.lasFil(f.fil).then((buf) => {
        const url = URL.createObjectURL(new Blob([buf], { type: 'image/jpeg' }));
        fig.firstChild.replaceWith(h('img', { src: url, alt: 'Hinderfoto: ' + (f.namn || 'hinder'), loading: 'lazy' }));
      }).catch((e) => {
        console.warn('Husvakten: hinderfoto kunde inte dekrypteras', f.fil, e);
        fig.firstChild.textContent = '⚠️';
      });
    }
    return h('section', { class: 'kort', 'aria-label': 'Hinderfoton' },
      h('h2', null, '📷 Hinderfoton (' + foton.length + ')'), rutnat,
      h('p', { class: 'fin' }, 'Tagna av robotens kamera vid hinder. Ligger krypterade i valvet.'));
  }

  HV.robot = {
    visa,
    ladda,
    laddaVakt,
    get vakt() { return vakt; },
    get data() { return data; },
    get tre() { return tre; },
  };
})();

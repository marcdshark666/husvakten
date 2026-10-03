/* Husvakten – 🎛 Styr-fliken: iPadens knappar för lampor, projektor (SwitchBot) och Roborock.
 * Allt går via hemservern (hem/server.py) på Marcs dator – nås bara via Tailscale (https://…ts.net/hem).
 * Den publika GitHub-sidan fungerar utan servern: då visas "Inte ansluten".
 * Serveradressen ligger krypterad i valvet (hem/konfig.json) eller i localStorage – aldrig i repot.
 * Inloggning: samma e-post/lösenord som Husvakten; servern ger en token som sparas i localStorage
 * (per enhet, 30 dagar). Lösenordet sparas aldrig.
 */
(function () {
  'use strict';
  const HV = (window.HV = window.HV || {});
  const LS_TOKEN = 'husvakten.hem.token';
  const LS_SERVER = 'husvakten.hem.server';
  const POLL_MS = 45000;
  const KOMMANDO = {
    press: { text: 'Tryck', ikon: '👆' }, turnOn: { text: 'På', ikon: '🔆' }, turnOff: { text: 'Av', ikon: '🌙' }, toggle: { text: 'Växla', ikon: '🔁' },
  };

  let el = null;
  let bas = null;          // API-bas, t.ex. https://dator.ts.net/hem
  let basKalla = '';
  let token = null;
  let status = null;       // senaste /api/status
  let fel = null;          // senaste felmeddelande (anslutning)
  let behoverInlogg = false;
  let upptagen = false;
  let pollTimer = 0;
  let bekrafta = null;     // { nyckel, tid } – första trycket på en robotstart
  const valdaRum = new Set();
  let konfigLaddad = false;

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
  function toast(msg) {
    const t = document.getElementById('toast');
    if (!t) return;
    t.textContent = msg;
    t.hidden = false;
    clearTimeout(toast._t);
    toast._t = setTimeout(() => (t.hidden = true), 3500);
  }
  function lsHamta(k) { try { return localStorage.getItem(k); } catch (e) { return null; } }
  function lsSpara(k, v) { try { if (v === null) localStorage.removeItem(k); else localStorage.setItem(k, v); } catch (e) { /* privat läge */ } }

  /** Var finns hemservern? 1) sidan serveras av servern själv (…/hem/) 2) localStorage 3) valvet. */
  async function hittaBas() {
    if (bas) return bas;
    const host = location.hostname;
    const egen = host && !/github\.io$/i.test(host) && (/\.ts\.net$/i.test(host) || host === 'localhost' || host === '127.0.0.1');
    if (egen) {
      bas = location.origin + (location.pathname.startsWith('/hem') ? '/hem' : '');
      basKalla = 'samma server';
      return bas;
    }
    const sparad = lsHamta(LS_SERVER);
    if (sparad && /^https:\/\/[\w.-]+(:\d+)?(\/[\w-]+)?$/.test(sparad)) {
      bas = sparad; basKalla = 'sparad adress';
      return bas;
    }
    if (!konfigLaddad && HV.valv && HV.valv.upplast) {
      konfigLaddad = true;
      try {
        const buf = await HV.valv.lasFil('hem/konfig.json');
        const k = JSON.parse(new TextDecoder().decode(buf));
        if (k && typeof k.server === 'string' && /^https:\/\/[\w.-]+(:\d+)?(\/[\w-]+)?$/.test(k.server)) {
          bas = k.server.replace(/\/$/, ''); basKalla = 'valvet';
          return bas;
        }
      } catch (e) {
        console.warn('Husvakten: ingen hem/konfig.json i valvet', e.message);
      }
    }
    return null;
  }

  async function api(vag, metod, body, tidsgrans) {
    const b = await hittaBas();
    if (!b) throw new Error('ingen-server');
    const ctrl = new AbortController();
    const t = setTimeout(() => ctrl.abort(), tidsgrans || 15000);
    const huvuden = { Accept: 'application/json' };
    if (body) huvuden['Content-Type'] = 'application/json';
    if (token) huvuden.Authorization = 'Bearer ' + token;
    let svar;
    try {
      svar = await fetch(b + vag, { method: metod || 'GET', headers: huvuden, body: body ? JSON.stringify(body) : undefined, signal: ctrl.signal, cache: 'no-store', credentials: 'omit' });
    } catch (e) {
      throw new Error('onåbar');
    } finally {
      clearTimeout(t);
    }
    let d = {};
    try { d = await svar.json(); } catch (e) { d = {}; }
    if (svar.status === 401) { behoverInlogg = true; throw new Error('inloggning'); }
    if (!svar.ok) throw new Error(d.fel || ('HTTP ' + svar.status));
    return d;
  }

  // ---------- Inloggning mot hemservern ----------
  async function loggaIn(epost, losen) {
    const d = await api('/api/logga-in', 'POST', { epost, losen });
    if (!d.token) throw new Error('inget svar');
    token = d.token;
    lsSpara(LS_TOKEN, token);
    behoverInlogg = false;
    return true;
  }

  /** Anropas av valv.js direkt efter upplåsning med samma uppgifter – tyst försök, sparas aldrig. */
  async function forsokLoggaIn(epost, losen) {
    try {
      if (token) return;
      if (!(await hittaBas())) return;
      await loggaIn(epost, losen);
      if (el && !el.hidden) uppdatera();
    } catch (e) {
      /* servern nås inte härifrån – knapparna visar "Inte ansluten" */
    }
  }

  async function loggaUt() {
    try { await api('/api/logga-ut', 'POST', {}); } catch (e) { /* ok */ }
    token = null;
    lsSpara(LS_TOKEN, null);
    status = null;
    behoverInlogg = true;
    rita();
  }

  // ---------- Data ----------
  async function uppdatera(farsk) {
    if (upptagen) return;
    upptagen = true;
    try {
      status = await api('/api/status' + (farsk ? '?farsk=1' : ''), 'GET', null, 70000);
      fel = null;
    } catch (e) {
      if (e.message === 'inloggning') fel = null;
      else { fel = e.message; if (e.message === 'onåbar' || e.message === 'ingen-server') status = null; }
    } finally {
      upptagen = false;
    }
    rita();
  }

  async function kor(atgard, extra, knapp) {
    if (knapp) { knapp.disabled = true; knapp.classList.add('jobbar'); }
    try {
      const d = await api('/api/atgard', 'POST', Object.assign({ atgard }, extra || {}), 90000);
      toast(d.text || 'Klart');
      setTimeout(() => uppdatera(true), 1500);
    } catch (e) {
      toast('⚠️ ' + (e.message === 'inloggning' ? 'Logga in på hemservern igen' : e.message === 'onåbar' ? 'Hemservern nås inte' : e.message));
      if (e.message === 'inloggning' || e.message === 'onåbar') rita();
    } finally {
      if (knapp) { knapp.disabled = false; knapp.classList.remove('jobbar'); }
    }
  }

  /** Robotstart kräver två tryck inom 6 s (iPad på köksbordet …). */
  function medBekraftelse(nyckel, text, gor) {
    return (ev) => {
      const k = ev.currentTarget;
      if (bekrafta && bekrafta.nyckel === nyckel && Date.now() - bekrafta.tid < 6000) {
        bekrafta = null;
        k.classList.remove('bekrafta');
        k.querySelector('.styr-text').textContent = text;
        gor(k);
        return;
      }
      bekrafta = { nyckel, tid: Date.now() };
      k.classList.add('bekrafta');
      k.querySelector('.styr-text').textContent = 'Tryck igen för att bekräfta';
      setTimeout(() => {
        if (bekrafta && bekrafta.nyckel === nyckel) { bekrafta = null; k.classList.remove('bekrafta'); k.querySelector('.styr-text').textContent = text; }
      }, 6000);
    };
  }

  // ---------- Ritning ----------
  function styrKnapp(ikon, text, attr, under) {
    return h('button', Object.assign({ class: 'styr-knapp' }, attr || {}),
      h('span', { class: 'styr-ikon' }, ikon),
      h('span', { class: 'styr-text' }, text),
      under ? h('span', { class: 'styr-under' }, under) : null);
  }

  function anslutningsKort() {
    const rader = [];
    if (!bas) {
      rader.push(h('h2', null, '🎛 Styr hemmet'),
        h('p', { class: 'fin' }, 'Inte ansluten – ingen hemserver är angiven. Öppna Husvakten via hemmanätet/Tailscale (https://…ts.net/hem/) eller ange adressen här.'));
      const f = h('form', { class: 'styr-form', onsubmit: (ev) => { ev.preventDefault(); const v = f.elements.server.value.trim().replace(/\/$/, ''); if (!/^https:\/\/[\w.-]+(:\d+)?(\/[\w-]+)?$/.test(v)) return toast('Adressen ska vara https://dator.ts.net/hem'); lsSpara(LS_SERVER, v); bas = v; basKalla = 'sparad adress'; uppdatera(true); } },
        h('label', { class: 'falt' }, 'Hemserverns adress', h('input', { name: 'server', type: 'url', placeholder: 'https://dator.tailnet.ts.net/hem', autocomplete: 'off', autocapitalize: 'off', spellcheck: 'false' })),
        h('button', { class: 'knapp primar', type: 'submit' }, 'Spara'));
      rader.push(f);
    } else if (behoverInlogg) {
      rader.push(h('h2', null, '🎛 Styr hemmet'), h('p', { class: 'fin' }, 'Logga in på hemservern (samma uppgifter som Husvakten). Sparas på den här enheten i 30 dagar.'));
      const f = h('form', { class: 'styr-form', autocomplete: 'on', onsubmit: async (ev) => {
        ev.preventDefault();
        const kn = f.querySelector('button[type=submit]');
        kn.disabled = true;
        try { await loggaIn(f.elements.epost.value, f.elements.losen.value); f.elements.losen.value = ''; toast('Ansluten till hemservern'); uppdatera(true); }
        catch (e) { toast('⚠️ ' + (e.message === 'onåbar' ? 'Hemservern nås inte – är du på Tailscale?' : e.message)); }
        finally { kn.disabled = false; }
      } },
        h('label', { class: 'falt' }, 'E-post', h('input', { name: 'epost', type: 'email', autocomplete: 'username', autocapitalize: 'off', required: true })),
        h('label', { class: 'falt' }, 'Lösenord', h('input', { name: 'losen', type: 'password', autocomplete: 'current-password', required: true })),
        h('button', { class: 'knapp primar', type: 'submit' }, 'Logga in'));
      rader.push(f);
    } else if (!status) {
      rader.push(h('h2', null, '🎛 Styr hemmet'),
        h('p', { class: 'fin styr-varning' }, fel === 'onåbar' || fel === 'ingen-server' ? '📵 Inte ansluten – hemservern nås inte. Öppna via hemmanätet/Tailscale.' : fel ? '⚠️ ' + fel : 'Ansluter …'),
        h('div', { class: 'knapprad' }, h('button', { class: 'knapp', onclick: () => uppdatera(true) }, '🔄 Försök igen'),
          basKalla === 'sparad adress' ? h('button', { class: 'knapp liten', onclick: () => { lsSpara(LS_SERVER, null); bas = null; rita(); } }, 'Byt adress') : null));
    } else {
      rader.push(h('div', { class: 'lista-huvud' }, h('h2', null, '🎛 Styr hemmet'),
        h('span', { class: 'fin' }, '🟢 ansluten · ' + basKalla)),
        fel ? h('p', { class: 'fin styr-varning' }, '⚠️ ' + fel) : null);
    }
    return h('section', { class: 'kort' }, rader);
  }

  function robotKort() {
    const r = status && status.robot;
    if (!r) return null;
    const rader = [h('div', { class: 'lista-huvud' }, h('h2', null, '🤖 Roboten'),
      h('span', { class: 'fin' }, r.tillganglig ? (r.lage || '') + (typeof r.batteri === 'number' ? ' · 🔋 ' + r.batteri + ' %' : '') : 'nås inte'))];
    if (!r.tillganglig) {
      rader.push(h('p', { class: 'fin styr-varning' }, '⚠️ ' + (r.fel || 'Roboten svarar inte')));
    } else {
      if (r.fel) rader.push(h('p', { class: 'fin styr-varning' }, '⚠️ Roboten rapporterar fel: ' + r.fel));
      rader.push(h('div', { class: 'styr-grid' },
        styrKnapp('▶️', 'Starta städning', { onclick: medBekraftelse('start', 'Starta städning', (k) => kor('robot_start', null, k)) }, 'hela hemmet'),
        styrKnapp(r.pausad ? '▶️' : '⏸', r.pausad ? 'Fortsätt' : 'Paus', { onclick: (ev) => kor(r.pausad ? 'robot_start' : 'robot_paus', null, ev.currentTarget), disabled: !r.kor && !r.pausad }),
        styrKnapp('⏹', 'Stopp', { onclick: (ev) => kor('robot_stopp', null, ev.currentTarget), disabled: !r.kor && !r.pausad }),
        styrKnapp('🔌', 'Till dockan', { onclick: (ev) => kor('robot_docka', null, ev.currentTarget) })));
      const rum = Array.isArray(r.rum) ? r.rum : [];
      if (rum.length) {
        rader.push(h('h3', null, 'Städa valda rum'),
          h('div', { class: 'styr-rum' }, rum.map((x) => h('button', {
            class: 'knapp styr-rumknapp' + (valdaRum.has(x.segment_id) ? ' vald' : ''), 'aria-pressed': String(valdaRum.has(x.segment_id)),
            onclick: (ev) => { if (valdaRum.has(x.segment_id)) valdaRum.delete(x.segment_id); else valdaRum.add(x.segment_id); ev.currentTarget.classList.toggle('vald'); ev.currentTarget.setAttribute('aria-pressed', String(valdaRum.has(x.segment_id))); const s = el.querySelector('.styr-rumstart'); if (s) s.disabled = !valdaRum.size; },
          }, (valdaRum.has(x.segment_id) ? '☑ ' : '☐ ') + x.namn))),
          h('div', { class: 'knapprad' }, h('button', { class: 'knapp primar styr-rumstart', disabled: !valdaRum.size,
            onclick: medBekraftelse('rum', '🧹 Städa valda rum', (k) => kor('robot_rum', { rum: [...valdaRum] }, k)) }, h('span', { class: 'styr-text' }, '🧹 Städa valda rum'))));
      }
      rader.push(h('p', { class: 'fin' }, 'Roboten startar aldrig av sig själv härifrån – bara när någon trycker. Startknapparna kräver två tryck.'));
    }
    return h('section', { class: 'kort' }, rader);
  }

  function enhetsKort() {
    const k = status && status.konfig;
    if (!k) return [];
    const kort = [];
    if (!k.switchbot) {
      kort.push(h('section', { class: 'kort' }, h('h2', null, '📽️ Projektor & lampor'),
        h('p', { class: 'fin styr-varning' }, 'SwitchBot är inte kopplad ännu. Token + secret läggs i ~/.husvakten/hem.json på datorn (SwitchBot-appen → Profil → Inställningar → tryck 10× på App Version → Developer Options).'),
        h('p', { class: 'fin' }, 'Därefter: python hem/switchbot.py lista --konfig')));
    } else if (!k.enheter.length) {
      kort.push(h('section', { class: 'kort' }, h('h2', null, '📽️ Projektor & lampor'),
        h('p', { class: 'fin styr-varning' }, 'SwitchBot är kopplad men inga enheter är valda i hem.json – kör python hem/switchbot.py lista --konfig.')));
    }
    const grupper = new Map();
    for (const e of k.enheter) {
      if (!grupper.has(e.grupp)) grupper.set(e.grupp, []);
      grupper.get(e.grupp).push(e);
    }
    for (const [grupp, enheter] of grupper) {
      kort.push(h('section', { class: 'kort' }, h('h2', null, grupp),
        h('div', { class: 'styr-grid' }, enheter.map((e) => {
          const st = (status.enheter || {})[e.id];
          const power = st && st.power ? String(st.power).toLowerCase() : null;
          const under = st && st.fel ? '⚠️ ' + st.fel : power ? (power === 'on' ? 'är på' : 'är av') + (typeof st.brightness === 'number' ? ' · ' + st.brightness + ' %' : '') : (e.deviceType || '');
          if (e.kommandon.length === 1) {
            const c = e.kommandon[0];
            return styrKnapp(e.ikon, e.namn, { class: 'styr-knapp' + (power === 'on' ? ' pa' : ''), onclick: (ev) => kor('enhet', { id: e.id, kommando: c }, ev.currentTarget) }, (KOMMANDO[c] || {}).text + (under ? ' · ' + under : ''));
          }
          return h('div', { class: 'styr-enhet' + (power === 'on' ? ' pa' : '') },
            h('div', { class: 'styr-enhet-huvud' }, h('span', { class: 'styr-ikon' }, e.ikon), h('span', null, h('b', null, e.namn), h('span', { class: 'fin styr-under' }, under ? ' ' + under : ''))),
            h('div', { class: 'styr-enhet-knappar' }, e.kommandon.map((c) => h('button', {
              class: 'knapp styr-liten' + (c === 'turnOn' && power === 'on' ? ' aktiv' : c === 'turnOff' && power === 'off' ? ' aktiv' : ''),
              onclick: (ev) => kor('enhet', { id: e.id, kommando: c }, ev.currentTarget) }, (KOMMANDO[c] || { ikon: '', text: c }).ikon + ' ' + (KOMMANDO[c] || { text: c }).text))));
        }))));
    }
    if (k.scener && k.scener.length) {
      kort.push(h('section', { class: 'kort' }, h('h2', null, '🎬 Scener'),
        h('div', { class: 'styr-grid' }, k.scener.map((s) => styrKnapp(s.ikon, s.namn, { onclick: (ev) => kor('scen', { id: s.id }, ev.currentTarget) }, s.steg + ' steg')))));
    }
    return kort;
  }

  function infoKort() {
    const k = status && status.konfig;
    return h('section', { class: 'kort' }, h('h3', null, 'Så hänger det ihop'),
      h('p', { class: 'fin' }, 'Knapparna går till hemservern på Marcs dator (bara via Tailscale) som pratar med SwitchBot (projektor, lampor) och Roborock. Inga nycklar finns på den här sidan.'),
      k && k.lampor_info ? h('p', { class: 'fin' }, '💡 Lampor: ' + k.lampor_info) : null,
      h('p', { class: 'fin' }, '🗣 Alexa har inget gratis API för styrning – röststyrningen fortsätter i Alexa-appen; här styrs enheterna direkt i stället.'),
      h('div', { class: 'knapprad' }, h('button', { class: 'knapp liten', onclick: () => uppdatera(true) }, '🔄 Uppdatera'),
        token ? h('button', { class: 'knapp liten', onclick: loggaUt }, 'Logga ut hemservern') : null));
  }

  function rita() {
    if (!el) return;
    // replaceChildren() skriver ut null som texten "null" – filtrera bort tomma kort.
    const kort = status ? [robotKort(), ...enhetsKort(), infoKort()] : [bas && !behoverInlogg ? infoKort() : null];
    el.replaceChildren(anslutningsKort(), ...kort.filter(Boolean));
  }

  // ---------- Livscykel ----------
  function bevaka() {
    clearInterval(pollTimer);
    pollTimer = setInterval(() => {
      if (!el || !el.isConnected) return clearInterval(pollTimer);
      if (el.hidden || document.hidden || behoverInlogg || !bas) return;
      uppdatera(false);
    }, POLL_MS);
  }

  /** Visa styrfliken i `mal`. Idempotent – uppdaterar bara när fliken öppnas. */
  async function visa(mal) {
    if (!mal) return;
    const forsta = el !== mal;
    el = mal;
    if (forsta) {
      token = lsHamta(LS_TOKEN);
      behoverInlogg = !token;
      rita();
      await hittaBas();
      rita();
      bevaka();
      if (bas && token) uppdatera(true);
    } else if (bas && token && !upptagen && (!status || Date.now() - (visa._senast || 0) > 10000)) {
      uppdatera(false);
    }
    visa._senast = Date.now();
  }

  HV.hem = { visa, forsokLoggaIn, get ansluten() { return !!status; } };
})();

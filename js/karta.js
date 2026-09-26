/* Husvakten – stiliserad planritning (egen SVG, förenklad – inga foton).
 * Koordinatsystem: viewBox 280 20 730 850 (godtyckliga enheter).
 */
(function () {
  'use strict';
  const HV = (window.HV = window.HV || {});
  const NS = 'http://www.w3.org/2000/svg';

  const VIEWBOX = '280 20 730 850';

  const RUM = [
    {
      id: 'vardagsrum',
      namn: 'Vardagsrum & kök',
      klass: 'rum-bla',
      punkter:
        '305,190 760,190 760,262 685,262 685,430 770,430 770,612 985,612 985,850 795,850 795,715 490,712 490,590 512,590 512,482 380,488 380,467 305,467',
      etikett: { x: 560, y: 395 },
    },
    {
      id: 'sovrum',
      namn: 'Sovrum',
      klass: 'rum-gul',
      punkter: '770,318 985,302 985,555 948,555 948,612 770,612',
      etikett: { x: 875, y: 480 },
    },
    {
      id: 'lillarummet',
      namn: 'Lilla rummet',
      klass: 'rum-orange',
      punkter: '885,715 985,715 985,850 900,850 885,800',
      etikett: { x: 935, y: 790 },
    },
    {
      id: 'badrum',
      namn: 'Badrum',
      klass: 'rum-badrum',
      punkter: '798,718 880,718 880,848 798,848',
      etikett: { x: 839, y: 742 },
      liten: true,
    },
    {
      id: 'balkong',
      namn: 'Balkong',
      klass: 'rum-balkong',
      punkter: '485,33 790,33 790,188 485,188',
      etikett: { x: 637, y: 70 },
    },
  ];

  // Marcs röda markeringar = robotfria zoner
  const ZONER = {
    balkong: { x: 485, y: 33, w: 305, h: 155, text: 'Balkong' },
    lampbord: { x: 457, y: 183, w: 83, h: 35, text: 'Lampbord' },
    sovrumKablar: { x: 829, y: 302, w: 157, h: 85, text: 'Kablar – robotfritt' },
    kabelhorna: { x: 673, y: 432, w: 89, h: 125, text: 'Kablar' },
  };

  const STANDARDOBJEKT = [
    { id: 'diskmaskin', namn: 'Diskmaskinen', emoji: '🍽️', rum: 'vardagsrum', x: 560, y: 690, typ: 'disk', timerMin: 150, efterTimer: 'ren' },
    { id: 'tvattmaskin', namn: 'Tvättmaskinen', emoji: '🧺', rum: 'badrum', x: 839, y: 795, typ: 'disk', timerMin: 60, efterTimer: 'ren' },
    { id: 'soffa', namn: 'Soffan', emoji: '🛋️', rum: 'vardagsrum', x: 600, y: 492 },
    { id: 'balkong', namn: 'Balkongen', emoji: '🌿', rum: 'balkong', x: 700, y: 120, zon: 'balkong' },
    { id: 'lampbord', namn: 'Lampbordet (luftrenaren)', emoji: '💡', rum: 'vardagsrum', x: 498, y: 200, zon: 'lampbord' },
    { id: 'sovrum', namn: 'Sovrummet (kablar)', emoji: '🛏️', rum: 'sovrum', x: 905, y: 345, zon: 'sovrumKablar' },
    { id: 'kabelhorna', namn: 'Kabelhörnan vid soffan', emoji: '🔌', rum: 'vardagsrum', x: 717, y: 495, zon: 'kabelhorna' },
    { id: 'matbord', namn: 'Matbordet', emoji: '🍴', rum: 'vardagsrum', x: 352, y: 332 },
    { id: 'koksbank', namn: 'Köksbänken', emoji: '🧽', rum: 'vardagsrum', x: 506, y: 630 },
    { id: 'badrumsbank', namn: 'Badrumsbänken (Adas saker)', emoji: '🧴', rum: 'badrum', x: 818, y: 822 },
    { id: 'hallskap', namn: 'Hallskåpet (Adas väskor)', emoji: '👜', rum: 'vardagsrum', x: 783, y: 700 },
    { id: 'badrumssopor', namn: 'Soptunnan i badrummet', emoji: '🗑️', rum: 'badrum', x: 862, y: 830 },
    { id: 'smutstvatt', namn: 'Smutstvätten (korgen)', emoji: '🧦', rum: 'badrum', x: 815, y: 762 },
    { id: 'vardagsrumsvaskor', namn: 'Väskorna i vardagsrummet', emoji: '🧳', rum: 'vardagsrum', x: 560, y: 560 },
    { id: 'vaxter', namn: 'Orkidéerna & växterna', emoji: '🪴', rum: 'vardagsrum', x: 352, y: 212 },
    { id: 'monstera', namn: 'Monsteran (balkongfönstret)', emoji: '🌱', rum: 'vardagsrum', x: 598, y: 232 },
    { id: 'palettblad', namn: 'Palettbladet (Coleus)', emoji: '🍁', rum: 'vardagsrum', x: 662, y: 285 },
    { id: 'schefflera', namn: 'Scheffleran (soffbordet)', emoji: '🌳', rum: 'vardagsrum', x: 530, y: 560 },
    { id: 'kaktus', namn: 'Kaktusen (balkongfönstret)', emoji: '🌵', rum: 'vardagsrum', x: 560, y: 262 },
    { id: 'clusia', namn: 'Clusian (balkongfönstret)', emoji: '🍀', rum: 'vardagsrum', x: 628, y: 300 },
    { id: 'diskho', namn: 'Diskhon', emoji: '🚰', rum: 'vardagsrum', x: 600, y: 668 },
    { id: 'kokssopor', namn: 'Soptunnan i köket', emoji: '🗑️', rum: 'vardagsrum', x: 468, y: 668 },
    { id: 'atervinning', namn: 'Återvinningen (kartong & papp)', emoji: '♻️', rum: 'vardagsrum', x: 735, y: 730 },
    { id: 'torkstallning', namn: 'Torkställningen (torr tvätt)', emoji: '👕', rum: 'badrum', x: 862, y: 762 },
    { id: 'spegelskap', namn: 'Spegelskåpet & handfatet', emoji: '🪞', rum: 'badrum', x: 839, y: 730 },
    { id: 'dusch', namn: 'Duschen', emoji: '🚿', rum: 'badrum', x: 868, y: 800 },
    { id: 'torktumlare', namn: 'Torktumlaren', emoji: '🌀', rum: 'badrum', x: 812, y: 798, typ: 'disk', timerMin: 60, efterTimer: 'paminn' },
    // Golvvakten: robotdammsugarens rum (se verktyg/roborock/live.py OBJEKT_FOR_RUM). Status sätts av
    // roboten (person Robot): smutsigt när den hittat saker på golvet, rent efter en körning utan fynd.
    // Rum 1/Rum 2 är robotens namnlösa rum – placerade efter storlek (Rum 2 ≈ 12 m², Rum 1 ≈ 2 m²).
    { id: 'golv-vardagsrum', namn: 'Golvet – Vardagsrum & kök', emoji: '🧹', rum: 'vardagsrum', x: 440, y: 425, robotRum: 'Vardagsrum', status: 'ren' },
    { id: 'golv-rum2', namn: 'Golvet – Rum 2', emoji: '🧹', rum: 'sovrum', x: 800, y: 575, robotRum: 'Rum 2', status: 'ren' },
    { id: 'golv-rum1', namn: 'Golvet – Rum 1', emoji: '🧹', rum: 'lillarummet', x: 930, y: 752, robotRum: 'Rum 1', status: 'ren' },
  ];

  const RANG = { smutsig: 3, pagar: 2, ren: 1 };

  // Prioritet inför gäster: 1 = syns direkt (gör först), 2 = syns om man tittar, 3 = kan vänta.
  const PRIO = {
    vardagsrumsvaskor: 1, diskho: 1, matbord: 1, koksbank: 1, soffa: 1, badrumssopor: 1, smutstvatt: 1, kokssopor: 1,
    atervinning: 2,
    badrumsbank: 2, torkstallning: 2, spegelskap: 2, dusch: 2, torktumlare: 2, diskmaskin: 2, hallskap: 2,
    vaxter: 2, monstera: 2, palettblad: 2, schefflera: 2, kaktus: 3, clusia: 2,
    sovrum: 3, balkong: 3, lampbord: 3, kabelhorna: 3, tvattmaskin: 3,
    'golv-vardagsrum': 2, 'golv-rum2': 2, 'golv-rum1': 2,
  };

  // Vattningsintervall i dagar: "ren" = vattnad; när intervallet gått blir objektet smutsigt (dags att vattna).
  // Orkidéer (Phalaenopsis) inomhus ca 1 gång/vecka – när rötterna blivit silvergrå och barken är torr.
  // Monstera ca var 7–10:e dag (när översta 3–5 cm jord är torra); vattenbubblan förlänger något.
  // Palettblad (Coleus) är törstigt: jämnt fuktig jord, ca var 3:e dag vid elementet.
  // Schefflera: när översta 2–3 cm jord är torra, ca var 7:e dag – tål torka bättre än övervattning.
  // Kaktus: helt torrt mellan gångerna, var 3:e–4:e vecka höst/vinter. Clusia: när översta 2–3 cm är torra.
  const VATTNA = { vaxter: 7, monstera: 7, palettblad: 3, schefflera: 7, kaktus: 21, clusia: 7 };

  // Vattningskulor (~245 ml full). Hur mycket kulan ska fyllas vid varje påfyllning + kort råd.
  const KULA = {
    vaxter: { mangd: '½ kula (~120 ml) per orkidé', rad: 'Orkidéer i bark vill torka upp mellan gångerna – ½ kula räcker ca en vecka. Aloen: ingen kula, 100 ml var 2–3:e vecka.' },
    monstera: { mangd: '1 hel kula (~245 ml)', rad: 'Räcker ca 5–7 dagar vid elementet. Fyll när översta 3–5 cm jord är torra; gula blad = minska till ¾ kula.' },
    palettblad: { mangd: '1 hel kula (~245 ml)', rad: 'Törstig – kulan töms på 2–3 dagar. Hänger bladen: fyll direkt. Nyp blomaxen.' },
    kaktus: { mangd: 'ingen kula – ca 100 ml direkt i jorden', rad: 'Låt jorden torka helt. Höst/vinter var 3:e–4:e vecka, vår/sommar varannan vecka. Hellre för lite än för mycket.' },
    clusia: { mangd: '½ kula (~120 ml)', rad: 'Tjocka blad lagrar vatten – tål torka. Räcker ca en vecka; gula/mjuka blad = för blött.' },
    schefflera: { mangd: '¾ kula (~180 ml)', rad: 'Räcker ca en vecka. Tappar den blad eller gulnar = för blött, gå ner till ½ kula. Vänd krukan ibland mot ljuset.' },
  };

  // Art per växt (visas på kartan och i växtkortet). `sida` = var etiketten står på kartan.
  const VAXTART = {
    vaxter: { art: 'Phalaenopsis (fjärilsorkidé)', kort: 'Fjärilsorkidé', sida: 'under' },
    monstera: { art: 'Monstera deliciosa', kort: 'Monstera deliciosa', sida: 'over' },
    palettblad: { art: 'Palettblad (Coleus scutellarioides)', kort: 'Palettblad (Coleus)', sida: 'hoger' },
    schefflera: { art: 'Schefflera arboricola (paraplyaralia)', kort: 'Schefflera', sida: 'under' },
    kaktus: { art: 'Pelarkaktus (troligen Cleistocactus)', kort: 'Pelarkaktus', sida: 'over' },
    clusia: { art: 'Clusia rosea (Princess)', kort: 'Clusia', sida: 'under' },
  };

  function el(namn, attr, forälder) {
    const e = document.createElementNS(NS, namn);
    for (const k in attr) e.setAttribute(k, attr[k]);
    if (forälder) forälder.appendChild(e);
    return e;
  }

  function text(t, attr, forälder) {
    const e = el('text', attr, forälder);
    e.textContent = t;
    return e;
  }

  /** Bygg den statiska grunden (rum, möbler, zoner). Anropas en gång. */
  function byggGrund(svg) {
    svg.setAttribute('viewBox', VIEWBOX);
    svg.setAttribute('role', 'img');
    svg.setAttribute('aria-label', 'Planritning över hemmet');

    const defs = el('defs', {}, svg);
    const p = el('pattern', { id: 'streck', width: 10, height: 10, patternUnits: 'userSpaceOnUse', patternTransform: 'rotate(45)' }, defs);
    el('line', { x1: 0, y1: 0, x2: 0, y2: 10, class: 'streck-linje' }, p);

    const rumLager = el('g', { id: 'lager-rum' }, svg);
    for (const r of RUM) {
      el('polygon', { points: r.punkter, class: 'rum ' + r.klass, 'data-rum': r.id }, rumLager);
    }

    // Möbler (förenklat)
    const mob = el('g', { class: 'mobler', 'aria-hidden': 'true' }, svg);
    // Matbord med stolar till vänster
    el('rect', { x: 330, y: 225, width: 44, height: 215, rx: 6, class: 'mobel' }, mob);
    for (let y = 240; y < 440; y += 34) {
      el('rect', { x: 314, y, width: 12, height: 18, rx: 3, class: 'mobel-lat' }, mob);
      el('rect', { x: 378, y, width: 12, height: 18, rx: 3, class: 'mobel-lat' }, mob);
    }
    // Soffa (L-form) i mitten
    el('path', { d: 'M560 462 h110 v22 h-86 v48 h-24 z', class: 'mobel' }, mob);
    el('rect', { x: 595, y: 505, width: 50, height: 28, rx: 5, class: 'mobel-lat' }, mob);
    // Köksbänk nere till vänster
    el('rect', { x: 496, y: 596, width: 20, height: 110, rx: 3, class: 'mobel' }, mob);
    el('rect', { x: 496, y: 688, width: 130, height: 18, rx: 3, class: 'mobel' }, mob);
    text('Kök', { x: 560, y: 650, class: 'rum-etikett liten' }, mob);
    // Säng i sovrummet
    el('rect', { x: 820, y: 400, width: 110, height: 130, rx: 8, class: 'mobel' }, mob);
    el('rect', { x: 830, y: 408, width: 40, height: 22, rx: 5, class: 'mobel-lat' }, mob);
    el('rect', { x: 880, y: 408, width: 40, height: 22, rx: 5, class: 'mobel-lat' }, mob);
    // Laddstation
    const ladd = el('g', { class: 'laddstation' }, mob);
    el('rect', { x: 718, y: 200, width: 34, height: 34, rx: 8 }, ladd);
    text('⚡', { x: 735, y: 224, 'text-anchor': 'middle', class: 'ladd-ikon' }, ladd);
    text('Laddstation', { x: 735, y: 252, class: 'rum-etikett minst' }, mob);

    // Rumsetiketter
    const etiketter = el('g', { class: 'etiketter', 'aria-hidden': 'true' }, svg);
    for (const r of RUM) text(r.namn, { x: r.etikett.x, y: r.etikett.y, class: 'rum-etikett' + (r.liten ? ' minst' : '') }, etiketter);

    // Robotfria zoner (Marcs röda markeringar)
    const zonLager = el('g', { id: 'lager-zoner' }, svg);
    for (const [id, z] of Object.entries(ZONER)) {
      const g = el('g', { class: 'zon', 'data-zon': id }, zonLager);
      el('rect', { x: z.x, y: z.y, width: z.w, height: z.h, class: 'zon-fyllning' }, g);
      el('rect', { x: z.x, y: z.y, width: z.w, height: z.h, class: 'zon-streck' }, g);
    }

    el('g', { id: 'lager-objekt' }, svg);
  }

  /** Rita om status på rum, zoner och objekt. */
  function rita(svg, objekt, valtId, onValj) {
    // Rum: färg efter sämsta status bland objekten i rummet
    const perRum = {};
    for (const o of objekt) {
      if (!o.rum) continue;
      if (!perRum[o.rum] || RANG[o.status] > RANG[perRum[o.rum]]) perRum[o.rum] = o.status;
    }
    svg.querySelectorAll('.rum').forEach((poly) => {
      const s = perRum[poly.dataset.rum];
      poly.classList.remove('st-smutsig', 'st-pagar', 'st-ren');
      if (s) poly.classList.add('st-' + s);
    });

    // Zoner: färg efter objektet som äger zonen
    svg.querySelectorAll('.zon').forEach((g) => {
      const agare = objekt.find((o) => o.zon === g.dataset.zon);
      g.classList.remove('st-smutsig', 'st-pagar', 'st-ren');
      if (agare) g.classList.add('st-' + agare.status);
    });

    const lager = svg.querySelector('#lager-objekt');
    while (lager.firstChild) lager.removeChild(lager.firstChild);

    // 1–2. Visningspositioner (de sparade x/y är ankare och ändras aldrig).
    const layout = beraknaLayout(objekt);
    const ledarLager = el('g', { class: 'objekt-ledare', 'aria-hidden': 'true' }, lager);
    const markorLager = el('g', {}, lager);
    const skyltLager = el('g', {}, lager);
    const upptaget = []; // rutor (SVG-enheter) som etiketter inte får täcka
    for (const L of layout) upptaget.push(ringRuta(L));
    // Fasta texter i grunden (rumsnamn, "Kök", laddstationen) ska inte heller täckas av etiketter.
    svg.querySelectorAll('.etiketter text, .mobler text, .laddstation rect').forEach((t) => {
      try {
        const b = t.getBBox();
        if (b.width) upptaget.push({ x: b.x - 2, y: b.y - 1, w: b.width + 4, h: b.height + 2 });
      } catch (e) {
        /* ej renderad – hoppa över, markörerna skyddas ändå */
      }
    });

    const grupper = new Map();
    for (const L of layout) {
      const o = L.o;
      if (L.flyttad) {
        el('line', { x1: r1(L.ax), y1: r1(L.ay), x2: r1(L.x), y2: r1(L.y) }, ledarLager);
        el('circle', { cx: r1(L.ax), cy: r1(L.ay), r: 2.5 }, ledarLager);
      }
      const g = el('g', {
        class: 'objekt st-' + o.status + (o.id === valtId ? ' valt' : '') + (L.liten ? ' liten' : ''),
        transform: 'translate(' + r1(L.x) + ' ' + r1(L.y) + ')',
        tabindex: '0',
        role: 'button',
        'aria-label': o.namn,
        'data-id': o.id,
      }, markorLager);
      const titel = el('title', {}, g);
      titel.textContent = o.namn;
      el('circle', { r: r1(L.yta), class: 'objekt-yta' }, g);
      const skala = el('g', L.s === 1 ? {} : { transform: 'scale(' + L.s.toFixed(3) + ')' }, g);
      el('circle', { r: L.liten ? 24 : 30, class: 'objekt-puls' }, skala);
      el('circle', { r: 19, class: 'objekt-ring' }, skala);
      text(o.emoji || '📍', { y: 7, 'text-anchor': 'middle', class: 'objekt-emoji' }, skala);
      const valj = (e) => {
        e.stopPropagation();
        onValj(o.id);
      };
      g.addEventListener('click', valj);
      g.addEventListener('keydown', (e) => {
        if (e.key === 'Enter' || e.key === ' ') valj(e);
      });
      grupper.set(o.id, g);
    }

    // 3. Etiketter: växtskyltar först (de ersätter växtens namnetikett), sedan namn i
    // prioritetsordning. Varje etikett provar under/över/höger/vänster och döljs om alla
    // lägen krockar – namnet finns ändå i listan, i title och vid tryck.
    for (const L of layout) {
      if (!L.o.vattning) continue;
      const g = el('g', { class: 'vaxt-skylt', 'data-id': L.o.id }, skyltLager);
      if (ritaVaxtEtikett(g, L, (VAXTART[L.o.id] || {}).sida, upptaget)) L.harSkylt = true;
      else skyltLager.removeChild(g);
    }
    const namnOrdning = layout
      .filter((L) => !L.liten && !L.harSkylt)
      .sort((a, b) => (PRIO[a.o.id] || 3) - (PRIO[b.o.id] || 3) || (RANG[b.o.status] || 0) - (RANG[a.o.status] || 0) || a.i - b.i);
    for (const L of namnOrdning) {
      const g = grupper.get(L.o.id);
      const kort = L.o.namn.length > 18 ? L.o.namn.slice(0, 17) + '…' : L.o.namn;
      const t = text(kort, { 'text-anchor': 'middle', class: 'objekt-namn' }, g);
      const bb = matText(t, 8.6, 15);
      const B = bb.width + 4;
      const H = bb.height + 2;
      const plats = valjPlats(L, B, H, 3, upptaget);
      if (!plats) {
        g.removeChild(t);
        continue;
      }
      // Rutan (vänster/topp, absolut) → textens mittpunkt/baslinje relativt markören.
      t.setAttribute('x', r1(plats.x - L.x + B / 2));
      t.setAttribute('y', r1(plats.y + 1 - L.y - bb.y));
      upptaget.push(plats);
    }
  }

  const VB = { x0: 280, y0: 20, x1: 1010, y1: 870 };
  const r1 = (v) => String(Math.round(v * 10) / 10);

  function rumRuta(rumId) {
    const r = RUM.find((x) => x.id === rumId);
    if (!r) return { x0: VB.x0, y0: VB.y0, x1: VB.x1, y1: VB.y1 };
    const p = r.punkter.split(' ').map((s) => s.split(',').map(Number));
    const xs = p.map((q) => q[0]);
    const ys = p.map((q) => q[1]);
    return { x0: Math.min(...xs), y0: Math.min(...ys), x1: Math.max(...xs), y1: Math.max(...ys), rum: r };
  }

  function ringRuta(L) {
    const m = L.r + 2;
    return { x: L.x - m, y: L.y - m, w: 2 * m, h: 2 * m };
  }

  function krockar(a, b) {
    return Math.min(a.x + a.w, b.x + b.w) - Math.max(a.x, b.x) > 0 && Math.min(a.y + a.h, b.y + b.h) - Math.max(a.y, b.y) > 0;
  }

  /** Ett repulsionsvarv: skjut isär par som ligger närmare än minsta avstånd. */
  function skjutIsar(layout, marginal) {
    let rort = false;
    for (let a = 0; a < layout.length; a++) {
      for (let b = a + 1; b < layout.length; b++) {
        const A = layout[a];
        const B = layout[b];
        const min = A.r + B.r + marginal(A, B);
        let dx = B.x - A.x;
        let dy = B.y - A.y;
        let d = Math.hypot(dx, dy);
        if (d >= min) continue;
        if (d < 0.01) {
          // Exakt samma punkt: deterministisk riktning utifrån indexen.
          const v = ((a * 7 + b * 13) % 16) * (Math.PI / 8);
          dx = Math.cos(v);
          dy = Math.sin(v);
          d = 1;
        }
        const skjut = (min - d) / 2 + 0.1;
        A.x -= (dx / d) * skjut;
        A.y -= (dy / d) * skjut;
        B.x += (dx / d) * skjut;
        B.y += (dy / d) * skjut;
        rort = true;
      }
    }
    return rort;
  }

  /** Beräkna visningspositioner: trånga rum får mindre markörer i rutnät, sedan repulsion över alla. */
  function beraknaLayout(objekt) {
    const R = 19;
    const layout = objekt.map((o, i) => ({ o, i, ax: o.x, ay: o.y, x: o.x, y: o.y, r: R, s: 1, liten: false, ruta: rumRuta(o.rum) }));

    const perRum = {};
    for (const L of layout) if (L.ruta.rum) (perRum[L.o.rum] = perRum[L.o.rum] || []).push(L);
    for (const lista of Object.values(perRum)) {
      const ruta = lista[0].ruta;
      const top = ruta.y0 + (ruta.rum.liten ? 30 : 0); // plats för rumsnamnet i små rum
      const w = ruta.x1 - ruta.x0;
      const h = ruta.y1 - top;
      const n = lista.length;
      if (n * Math.pow(2 * R + 14, 2) * 2.2 <= w * h) continue; // ryms i normal storlek
      // Krymp markörerna tills rutnätet ryms (minst r 9).
      let r = 13;
      let kol = 1;
      let rader = n;
      for (; r > 9; r--) {
        kol = Math.max(1, Math.floor(w / (2 * r + 4)));
        rader = Math.ceil(n / kol);
        if (rader * (2 * r + 4) <= h) break;
      }
      kol = Math.max(1, Math.floor(w / (2 * r + 4)));
      rader = Math.ceil(n / kol);
      // Cellerna fylls i läsordning efter ankarnas läge, så att objekten hamnar ungefär rätt.
      const sorterad = lista.slice().sort((a, b) => a.ay - b.ay || a.ax - b.ax || a.i - b.i);
      for (let rad = 0; rad < rader; rad++) {
        const iRad = sorterad.slice(rad * kol, rad * kol + kol).sort((a, b) => a.ax - b.ax || a.i - b.i);
        iRad.forEach((L, c) => {
          L.liten = true;
          L.r = r;
          L.s = r / R;
          L.x = ruta.x0 + ((c + 0.5) * w) / iRad.length;
          L.y = top + ((rad + 0.5) * h) / rader;
        });
      }
    }

    // Kollisionslösning: deterministisk repulsion, högst 80 varv, inom rummets ruta och kartan.
    for (const L of layout) {
      L.mx = L.x; // målpunkt för den svaga fjädern (ankaret, eller rutnätscellen)
      L.my = L.y;
    }
    const kant = (L) => {
      const x0 = Math.max(L.ruta.x0, VB.x0) + L.r + 2;
      const x1 = Math.min(L.ruta.x1, VB.x1) - L.r - 2;
      const y0 = Math.max(L.ruta.y0, VB.y0) + L.r + 2;
      const y1 = Math.min(L.ruta.y1, VB.y1) - L.r - 2;
      L.x = x0 > x1 ? (x0 + x1) / 2 : Math.min(x1, Math.max(x0, L.x));
      L.y = y0 > y1 ? (y0 + y1) / 2 : Math.min(y1, Math.max(y0, L.y));
    };
    const luft = (A, B) => (A.liten || B.liten ? 5 : 12);
    for (let varv = 0; varv < 80; varv++) {
      const rort = skjutIsar(layout, luft);
      for (const L of layout) {
        L.x += (L.mx - L.x) * 0.03;
        L.y += (L.my - L.y) * 0.03;
        kant(L);
      }
      if (!rort && varv > 5) break;
    }
    // Slutpass utan fjäder så att inga markörer ligger kvar ovanpå varandra.
    for (let varv = 0; varv < 40; varv++) {
      const rort = skjutIsar(layout, () => 5);
      for (const L of layout) kant(L);
      if (!rort) break;
    }

    for (const L of layout) {
      let narmast = Infinity;
      for (const M of layout) if (M !== L) narmast = Math.min(narmast, Math.hypot(M.x - L.x, M.y - L.y) - M.r);
      L.yta = Math.max(L.r * 1.25, Math.min(46 * L.s, narmast));
      L.flyttad = Math.hypot(L.x - L.ax, L.y - L.ay) > Math.max(14, L.r);
    }
    return layout;
  }

  /** Första lediga läge (under/över/höger/vänster) för en ruta B×H runt markören; null = dölj. */
  function valjPlats(L, B, H, gap, upptaget, forst) {
    const ordning = ['under', 'over', 'hoger', 'vanster'];
    if (forst && ordning.includes(forst)) ordning.unshift(ordning.splice(ordning.indexOf(forst), 1)[0]);
    const m = L.r + gap;
    for (const sida of ordning) {
      let x = sida === 'hoger' ? L.x + m : sida === 'vanster' ? L.x - m - B : L.x - B / 2;
      const y = sida === 'under' ? L.y + m : sida === 'over' ? L.y - m - H : L.y - H / 2;
      if (sida === 'under' || sida === 'over') x = Math.min(VB.x1 - 4 - B, Math.max(VB.x0 + 4, x));
      if (x < VB.x0 || x + B > VB.x1 || y < VB.y0 || y + H > VB.y1) continue;
      const ruta = { x, y, w: B, h: H, sida };
      if (!upptaget.some((u) => krockar(ruta, u))) return ruta;
    }
    return null;
  }

  /** Textens mått (getBBox), med uppskattning om kartan inte är renderad. */
  function matText(t, perTecken, fs) {
    let bb = null;
    try {
      bb = t.getBBox();
    } catch (e) {
      bb = null; // ej renderad (t.ex. dold flik) – uppskattning nedan
    }
    if (!bb || !bb.width) return { width: t.textContent.length * perTecken, height: fs * 1.25, y: -fs * 0.95 };
    return { width: bb.width, height: bb.height, y: bb.y };
  }

  /** Liten skylt vid en växt: art + nedräkning till nästa vattning, på mörk platta.
   *  Returnerar false om den inte får plats någonstans utan att krocka. */
  function ritaVaxtEtikett(g, L, sida, upptaget) {
    const v = L.o.vattning;
    const skylt = el('g', { class: 'vaxt-etikett', 'aria-hidden': 'true' }, g);
    const platta = el('rect', { rx: 6, class: 'vaxt-platta' }, skylt);
    const t1 = text(v.art, { 'text-anchor': 'start', class: 'vaxt-art' }, skylt);
    const t2 = text(v.text, { 'text-anchor': 'start', class: 'vaxt-nedrakning ' + v.klass }, skylt);
    const bredd = Math.max(matText(t1, 7.4, 13).width, matText(t2, 7.8, 13).width);
    const pad = 5;
    const B = bredd + pad * 2;
    const H = 36;
    const plats = valjPlats(L, B, H, 4, upptaget, sida);
    if (!plats) return false;
    upptaget.push(plats);
    platta.setAttribute('x', r1(plats.x));
    platta.setAttribute('y', r1(plats.y));
    platta.setAttribute('width', r1(B));
    platta.setAttribute('height', String(H));
    for (const [t, dy] of [[t1, 13], [t2, 29]]) {
      t.setAttribute('x', r1(plats.x + pad));
      t.setAttribute('y', r1(plats.y + dy));
    }
    return true;
  }

  /** Klientkoordinat → SVG-koordinat. */
  function tillSvg(svg, clientX, clientY) {
    const pt = svg.createSVGPoint();
    pt.x = clientX;
    pt.y = clientY;
    const ctm = svg.getScreenCTM();
    if (!ctm) return { x: 600, y: 400 };
    const p = pt.matrixTransform(ctm.inverse());
    return { x: Math.round(p.x), y: Math.round(p.y) };
  }

  /** Vilket rum ligger en punkt i? */
  function rumVid(svg, x, y) {
    const pt = svg.createSVGPoint();
    pt.x = x;
    pt.y = y;
    const polys = Array.from(svg.querySelectorAll('.rum'));
    for (const p of polys.reverse()) {
      try {
        if (p.isPointInFill && p.isPointInFill(pt)) return p.dataset.rum;
      } catch (e) {
        /* äldre webbläsare saknar isPointInFill – ignoreras medvetet */
      }
    }
    return null;
  }

  HV.karta = { RUM, ZONER, STANDARDOBJEKT, PRIO, VATTNA, KULA, VAXTART, byggGrund, rita, tillSvg, rumVid };
})();

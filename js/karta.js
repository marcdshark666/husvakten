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
    { id: 'torkstallning', namn: 'Torkställningen (torr tvätt)', emoji: '👕', rum: 'badrum', x: 862, y: 762 },
  ];

  const RANG = { smutsig: 3, pagar: 2, ren: 1 };

  // Prioritet inför gäster: 1 = syns direkt (gör först), 2 = syns om man tittar, 3 = kan vänta.
  const PRIO = {
    vardagsrumsvaskor: 1, matbord: 1, koksbank: 1, soffa: 1, badrumssopor: 1, smutstvatt: 1,
    badrumsbank: 2, torkstallning: 2, diskmaskin: 2, hallskap: 2,
    sovrum: 3, balkong: 3, lampbord: 3, kabelhorna: 3, tvattmaskin: 3,
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
    for (const o of objekt) {
      const g = el('g', {
        class: 'objekt st-' + o.status + (o.id === valtId ? ' valt' : ''),
        transform: 'translate(' + o.x + ' ' + o.y + ')',
        tabindex: '0',
        role: 'button',
        'data-id': o.id,
      }, lager);
      const titel = el('title', {}, g);
      titel.textContent = o.namn;
      el('circle', { r: 30, class: 'objekt-puls' }, g);
      el('circle', { r: 19, class: 'objekt-ring' }, g);
      text(o.emoji || '📍', { y: 7, 'text-anchor': 'middle', class: 'objekt-emoji' }, g);
      const kort = o.namn.length > 18 ? o.namn.slice(0, 17) + '…' : o.namn;
      text(kort, { y: 36, 'text-anchor': 'middle', class: 'objekt-namn' }, g);
      const valj = (e) => {
        e.stopPropagation();
        onValj(o.id);
      };
      g.addEventListener('click', valj);
      g.addEventListener('keydown', (e) => {
        if (e.key === 'Enter' || e.key === ' ') valj(e);
      });
    }
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

  HV.karta = { RUM, ZONER, STANDARDOBJEKT, PRIO, byggGrund, rita, tillSvg, rumVid };
})();

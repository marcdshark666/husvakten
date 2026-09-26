/* Husvakten – bildbedömning i webbläsaren.
 * TensorFlow.js + MobileNet (feature extractor) + KNN-klassificerare per objekt.
 * Laddas först när den behövs, från cdn.jsdelivr.net. Inga nycklar, inga betaltjänster.
 */
(function () {
  'use strict';
  const HV = (window.HV = window.HV || {});

  const SKRIPT = [
    'https://cdn.jsdelivr.net/npm/@tensorflow/tfjs@4.22.0/dist/tf.min.js',
    'https://cdn.jsdelivr.net/npm/@tensorflow-models/mobilenet@2.1.1/dist/mobilenet.min.js',
    'https://cdn.jsdelivr.net/npm/@tensorflow-models/knn-classifier@1.2.6/dist/knn-classifier.min.js',
  ];
  const MODELL_ID = 'mobilenet-v2-1.0';
  const MIN_PER_KLASS = 2; // minst så här många exempel i minst två klasser
  const K = 5;

  let laddning = null;
  let modell = null;
  const klassCache = new Map(); // objektId -> { classifier, antal }

  function laddaSkript(src) {
    return new Promise((resolve, reject) => {
      if (document.querySelector('script[data-src="' + src + '"]')) return resolve();
      const s = document.createElement('script');
      s.src = src;
      s.async = false;
      s.crossOrigin = 'anonymous';
      s.dataset.src = src;
      s.onload = () => resolve();
      s.onerror = () => reject(new Error('Kunde inte hämta ' + src.split('/npm/')[1]));
      document.head.appendChild(s);
    });
  }

  async function ladda(onStatus) {
    if (modell) return modell;
    if (laddning) return laddning;
    laddning = (async () => {
      try {
        onStatus && onStatus('Hämtar TensorFlow.js …');
        for (const src of SKRIPT) await laddaSkript(src);
        if (!window.tf || !window.mobilenet || !window.knnClassifier) {
          throw new Error('Biblioteken laddades inte korrekt');
        }
        onStatus && onStatus('Laddar MobileNet (första gången tar det en stund) …');
        await window.tf.ready();
        modell = await window.mobilenet.load({ version: 2, alpha: 1.0 });
        return modell;
      } catch (e) {
        laddning = null;
        throw e;
      }
    })();
    return laddning;
  }

  /** Läs in en fil som HTMLImageElement. */
  function filTillBild(fil) {
    return new Promise((resolve, reject) => {
      if (!fil || !/^image\//.test(fil.type || 'image/')) {
        return reject(new Error('Filen är ingen bild'));
      }
      const url = URL.createObjectURL(fil);
      const img = new Image();
      img.onload = () => resolve({ img, url });
      img.onerror = () => {
        URL.revokeObjectURL(url);
        reject(new Error('Bilden kunde inte läsas'));
      };
      img.src = url;
    });
  }

  /** Skala ned till en 224px-kvadrat (mittbeskärning) + en liten miniatyr. */
  function forbered(img) {
    const w = img.naturalWidth || img.width;
    const h = img.naturalHeight || img.height;
    const sida = Math.min(w, h);
    const sx = (w - sida) / 2;
    const sy = (h - sida) / 2;

    const c = document.createElement('canvas');
    c.width = c.height = 224;
    c.getContext('2d').drawImage(img, sx, sy, sida, sida, 0, 0, 224, 224);

    const t = document.createElement('canvas');
    t.width = t.height = 72;
    t.getContext('2d').drawImage(img, sx, sy, sida, sida, 0, 0, 72, 72);
    let thumb = '';
    try {
      thumb = t.toDataURL('image/jpeg', 0.7);
    } catch (e) {
      console.warn('Husvakten: miniatyr misslyckades', e);
    }
    // Större foto till galleriet (omkodat via canvas → ingen EXIF/GPS följer med)
    const skala = Math.min(1, 1024 / Math.max(w, h));
    const f = document.createElement('canvas');
    f.width = Math.round(w * skala);
    f.height = Math.round(h * skala);
    f.getContext('2d').drawImage(img, 0, 0, f.width, f.height);
    let foto = '';
    try {
      foto = f.toDataURL('image/jpeg', 0.75);
    } catch (e) {
      console.warn('Husvakten: foto kunde inte sparas', e);
    }
    return { canvas: c, thumb, foto };
  }

  /** Beräkna MobileNet-embedding (Float32 → vanlig array). */
  async function embedding(canvas) {
    const m = await ladda();
    const tf = window.tf;
    const tensor = tf.tidy(() => m.infer(canvas, true));
    try {
      const data = await tensor.data();
      return Array.from(data);
    } finally {
      tensor.dispose();
    }
  }

  function raknaPerEtikett(exempel) {
    const r = {};
    for (const ex of exempel) r[ex.etikett] = (r[ex.etikett] || 0) + 1;
    return r;
  }

  function tillrackligt(exempel) {
    const r = raknaPerEtikett(exempel);
    const klasser = Object.values(r).filter((n) => n >= MIN_PER_KLASS).length;
    return klasser >= 2;
  }

  function bygg(objektId, exempel) {
    const cache = klassCache.get(objektId);
    const nyckel = exempel.map((e) => e.id).join(',');
    if (cache && cache.nyckel === nyckel) return cache.classifier;
    if (cache) cache.classifier.dispose();
    const tf = window.tf;
    const clf = window.knnClassifier.create();
    for (const ex of exempel) {
      if (!ex.emb || !ex.emb.length) continue;
      clf.addExample(tf.tensor1d(ex.emb), ex.etikett);
    }
    klassCache.set(objektId, { classifier: clf, nyckel });
    return clf;
  }

  /** Bedöm en embedding mot objektets exempel. Returnerar null om för få exempel. */
  async function bedom(objektId, emb, exempel) {
    const giltiga = exempel.filter((e) => e.emb && e.emb.length === emb.length);
    if (!tillrackligt(giltiga)) return null;
    await ladda();
    const tf = window.tf;
    const clf = bygg(objektId, giltiga);
    const t = tf.tensor1d(emb);
    try {
      let k = Math.min(K, giltiga.length);
      if (k > 1 && k % 2 === 0) k--; // udda k undviker oavgjort mellan två klasser
      const res = await clf.predictClass(t, k);
      const conf = res.confidences || {};
      return { etikett: res.label, sakerhet: conf[res.label] || 0, alla: conf };
    } finally {
      t.dispose();
    }
  }

  function glom(objektId) {
    const c = klassCache.get(objektId);
    if (c) {
      try {
        c.classifier.dispose();
      } catch (e) {
        console.warn(e);
      }
      klassCache.delete(objektId);
    }
  }

  HV.ml = {
    MODELL_ID,
    MIN_PER_KLASS,
    ladda,
    arLaddad: () => !!modell,
    filTillBild,
    forbered,
    embedding,
    bedom,
    tillrackligt,
    raknaPerEtikett,
    glom,
  };
})();

"""Husvakten – bygg robotfliken ur robotdatan och lägg den KRYPTERAD i valvet.

Läser %USERPROFILE%/.roborock/data/ (status.json, karta.json, karta_grid.bin, karta.png, historik.json),
bygger en ren, beskuren kartbild + en kompakt robot.json i %USERPROFILE%/.roborock/data/publicera/
(UTANFÖR repot) och krypterar båda in i data/valv/robot/ via `node verktyg/valv.js skriv`.

Kartan visar bostadens planlösning – den får ALDRIG hamna okrypterad i repot.
Anropas av `python verktyg/roborock/robo.py publicera` (hämtar först, bara läsning).
"""
from __future__ import annotations

import json
import pathlib
import subprocess
from datetime import datetime, timezone
from typing import Any

import numpy as np
from PIL import Image

DATA = pathlib.Path.home() / ".roborock" / "data"
UT = DATA / "publicera"
ROT = pathlib.Path(__file__).resolve().parents[2]
MAXSIDA = 1000       # px, längsta sidan i kartbilden
MAX_VAGPUNKTER = 800
CELL_MM = 50

# Förbrukningsdelar: (nyckel i consumables, svenskt namn, livslängd, enhet) – python-roborock/const.py
DELAR = [
    ("mainBrushWorkTime", "Huvudborste", 1080000, "s"),
    ("sideBrushWorkTime", "Sidoborste", 720000, "s"),
    ("filterWorkTime", "Filter", 540000, "s"),
    ("sensorDirtyTime", "Sensorer (rengör)", 108000, "s"),
    ("strainerWorkTimes", "Dockans sil", 150, "ggr"),
    ("cleaningBrushWorkTimes", "Dockans rengöringsborste", 300, "ggr"),
]

LAGEN = {
    1: "Startar", 2: "Viloläge", 3: "Väntar", 4: "Fjärrstyrs", 5: "Städar", 6: "Åker hem",
    7: "Manuellt läge", 8: "Laddar", 9: "Laddningsfel", 10: "Pausad", 11: "Punktstädar",
    12: "Fel", 13: "Stänger av", 14: "Uppdaterar", 15: "Dockar", 16: "Åker till punkt",
    17: "Zonstädar", 18: "Rumsstädar", 22: "Tömmer dammbehållaren", 23: "Tvättar moppen",
    26: "Åker till tvätt", 28: "I samtal", 29: "Kartlägger", 100: "Fulladdad",
}

RUMSNAMN = {
    "living room": "Vardagsrum", "bedroom": "Sovrum", "kitchen": "Kök", "bathroom": "Badrum",
    "hallway": "Hall", "corridor": "Korridor", "dining room": "Matsal", "study": "Arbetsrum",
    "office": "Kontor", "balcony": "Balkong", "master bedroom": "Sovrum", "guest bedroom": "Gästrum",
    "children room": "Barnrum", "kids room": "Barnrum", "toilet": "Toalett", "laundry": "Tvättstuga",
}

HINDERNAMN = {
    "clothes": "Kläder", "shoes": "Skor", "cable": "Kabel", "poop": "Bajs", "pet waste": "Bajs",
    "furniture with a crossbar": "Möbel med tvärslå", "power strip": "Grenuttag",
    "weighing scale": "Våg", "weighting scale": "Våg", "dustpan": "Sopskyffel", "pedestal": "Möbelfot", "sock": "Strumpa",
    "fabric": "Tyg", "pet": "Husdjur", "bed": "Säng", "sofa": "Soffa",
}


def _las(namn: str) -> Any:
    p = DATA / namn
    return json.loads(p.read_text(encoding="utf-8")) if p.exists() else None


def _iso(ts: int | float | None) -> str | None:
    if not ts:
        return None
    return datetime.fromtimestamp(ts, timezone.utc).astimezone().isoformat(timespec="seconds")


def _kalla(namn: str | None) -> str:
    namn = (namn or "S7 MaxV").strip()
    return namn if namn.lower().startswith("roborock") else "Roborock " + namn


class Transform:
    """robot-mm → px i den beskurna, skalade bilden."""

    def __init__(self, koord: dict, x0: int, y0: int, s: int):
        self.left = koord["vänster_celler"]
        self.top = koord["topp_celler"]
        self.h = koord["höjd_celler"]
        self.x0, self.y0, self.s = x0, y0, s

    def px(self, x_mm: float, y_mm: float) -> list[float]:
        cx = x_mm / CELL_MM - self.left
        cy = self.h - (y_mm / CELL_MM - self.top)
        return [round((cx - self.x0) * self.s, 1), round((cy - self.y0) * self.s, 1)]


def _rektanglar(mask: np.ndarray) -> list[list[int]]:
    """Slå ihop sanna celler till rektanglar [x, y, b, h] (rader → sammanslagning nedåt)."""
    oppna: dict[tuple[int, int], list[int]] = {}
    ut: list[list[int]] = []
    for y in range(mask.shape[0]):
        rad = mask[y]
        korningar = []
        x = 0
        b = rad.shape[0]
        while x < b:
            if rad[x]:
                x1 = x
                while x1 < b and rad[x1]:
                    x1 += 1
                korningar.append((x, x1 - x))
                x = x1
            else:
                x += 1
        nya: dict[tuple[int, int], list[int]] = {}
        for k in korningar:
            if k in oppna:
                r = oppna.pop(k)
                r[3] += 1
                nya[k] = r
            else:
                nya[k] = [k[0], y, k[1], 1]
        ut.extend(oppna.values())
        oppna = nya
    ut.extend(oppna.values())
    return ut


def _forenkla_vag(vagar_px: list[np.ndarray]) -> list[list[list[float]]]:
    import cv2

    eps = 0.5
    while True:
        ut = []
        for v in vagar_px:
            if len(v) < 2:
                continue
            f = cv2.approxPolyDP(v.astype(np.float32).reshape(-1, 1, 2), eps, False).reshape(-1, 2)
            ut.append(f)
        if sum(len(f) for f in ut) <= MAX_VAGPUNKTER or eps > 200:
            return [[[round(float(p[0]), 1), round(float(p[1]), 1)] for p in f] for f in ut]
        eps *= 1.5


PALETT = [(93, 143, 216), (217, 178, 74), (217, 119, 79), (61, 220, 132), (176, 124, 216),
          (79, 199, 214), (230, 110, 160), (160, 190, 90)]


def bygg() -> dict:
    """Bygg karta.png + robot.json i UT. Returnerar sammanfattning."""
    import cv2

    karta = _las("karta.json")
    status = _las("status.json")
    historik = _las("historik.json")
    if not karta or "koordinater" not in karta:
        raise SystemExit("karta.json saknas eller saknar koordinater – kör robo.py karta först")
    koord = karta["koordinater"]
    W, H = koord["bredd_celler"], koord["höjd_celler"]
    g = karta.get("grid")
    gridfil = DATA / (g["fil"] if g else "karta_grid.bin")
    if not g or not gridfil.exists():
        raise SystemExit("karta_grid.bin saknas – kör robo.py karta (nyare version) först")
    if g["bredd"] != W or g["höjd"] != H:
        raise SystemExit(f"rutnätet {g['bredd']}x{g['höjd']} matchar inte kartan {W}x{H}")
    arr = np.frombuffer(gridfil.read_bytes(), dtype=np.uint8)[: W * H].reshape(H, W)[::-1]  # rad 0 = överst

    lag = arr & 0x07
    rum_id = np.where((lag == 7) & (arr != 7) & (arr != 255), arr >> 3, 0)
    vagg = (arr == 1) | ((arr != 0) & (arr != 255) & (arr != 7) & ((lag == 0) | (lag == 1)))
    inne = arr != 0

    ys, xs = np.nonzero(inne)
    if not len(xs):
        raise SystemExit("kartan är tom")
    m = 2
    x0, y0 = max(0, int(xs.min()) - m), max(0, int(ys.min()) - m)
    x1, y1 = min(W, int(xs.max()) + 1 + m), min(H, int(ys.max()) + 1 + m)
    cw, ch = x1 - x0, y1 - y0
    s = max(1, min(6, MAXSIDA // max(cw, ch)))
    T = Transform(koord, x0, y0, s)

    arr_c, rum_c, vagg_c = arr[y0:y1, x0:x1], rum_id[y0:y1, x0:x1], vagg[y0:y1, x0:x1]

    # --- Ren kartbild: transparent utanför, golv, rum i färg, väggar ljusa ---
    rgba = np.zeros((ch, cw, 4), dtype=np.uint8)
    golv = (arr_c != 0) & ~vagg_c
    rgba[golv] = (42, 53, 80, 255)
    ids = sorted(int(v) for v in np.unique(rum_c) if v)
    farg = {rid: PALETT[i % len(PALETT)] for i, rid in enumerate(ids)}
    for rid, (r, gg, b) in farg.items():
        mask = rum_c == rid
        rgba[mask] = (int(r * .55 + 42 * .45), int(gg * .55 + 53 * .45), int(b * .55 + 80 * .45), 255)
    rgba[vagg_c] = (200, 210, 228, 255)
    bild = Image.fromarray(rgba, "RGBA").resize((cw * s, ch * s), Image.NEAREST)
    UT.mkdir(parents=True, exist_ok=True)
    bildfil = UT / "karta.png"
    bild.save(bildfil, optimize=True)  # PIL skriver inga metadata-chunks här

    # --- Rum ---
    namn = {}
    for r in karta.get("rum", []):
        n = (r.get("namn") or "").strip()
        namn[r["segment_id"]] = RUMSNAMN.get(n.lower(), n) if n else None
    rum = []
    for nr, rid in enumerate(ids, 1):
        mask = (rum_c == rid).astype(np.uint8)
        konturer, _ = cv2.findContours(mask, cv2.RETR_EXTERNAL, cv2.CHAIN_APPROX_SIMPLE)
        polys = []
        for k in sorted(konturer, key=cv2.contourArea, reverse=True):
            if cv2.contourArea(k) < 6:
                continue
            k = cv2.approxPolyDP(k, 1.0, True).reshape(-1, 2)
            polys.append([[int(p[0]) * s, int(p[1]) * s] for p in k])
        dist = cv2.distanceTransform(np.pad(mask, 1), cv2.DIST_L2, 3)[1:-1, 1:-1]
        ly, lx = np.unravel_index(int(np.argmax(dist)), dist.shape)
        r, gg, b = farg[rid]
        rum.append({
            "id": rid, "namn": namn.get(rid) or f"Rum {nr}", "farg": f"#{r:02x}{gg:02x}{b:02x}",
            "celler": int(mask.sum()), "yta_m2": round(int(mask.sum()) * (CELL_MM / 1000) ** 2, 1),
            "etikett": [round((lx + .5) * s, 1), round((ly + .5) * s, 1)], "polygoner": polys,
        })

    def omr(a):
        v = a["mm"]
        return [T.px(v[i], v[i + 1]) for i in range(0, 8, 2)]

    def punkt(p):
        return None if not p else {"px": T.px(*p["mm"]), "vinkel": p.get("vinkel")}

    hinder = []
    for o in karta.get("hinder_med_foto", []) + karta.get("hinder", []):
        besk = (o.get("description") or "").strip().lower()
        hinder.append({
            "typ": o.get("type"), "beskrivning": besk or None,
            "namn": HINDERNAMN.get(besk, besk.capitalize() if besk else "Okänt hinder"),
            "sakerhet": round(o.get("confidence_level") or 0), "px": T.px(o["x"], o["y"]),
        })

    vagar = [np.array([T.px(x, y) for x, y in sub]) for sub in karta.get("städväg_mm", []) if sub]

    # --- Status ---
    st = (status or {}).get("status", {})
    cons = (status or {}).get("consumables", {})
    delar = []
    for nyckel, dnamn, liv, enhet in DELAR:
        if nyckel in cons and cons[nyckel] is not None:
            anv = cons[nyckel]
            kvar = max(0, round(100 - 100 * anv / liv))
            delar.append({"namn": dnamn, "kvar_procent": kvar,
                          "anvant": round(anv / 3600, 1) if enhet == "s" else anv,
                          "livslangd": round(liv / 3600) if enhet == "s" else liv,
                          "enhet": "h" if enhet == "s" else "ggr"})
    summa = (historik or {}).get("sammanfattning", {})
    stadningar = []
    for p in (historik or {}).get("poster", [])[:12]:
        r = p.get("rå")
        r = r[0] if isinstance(r, list) and r else r
        if not isinstance(r, dict):
            continue
        stadningar.append({
            "start": _iso(r.get("begin")), "slut": _iso(r.get("end")),
            "minuter": round((r.get("duration") or 0) / 60), "yta_m2": round((r.get("area") or 0) / 1e6, 1),
            "klar": bool(r.get("complete")), "undvek": r.get("avoid_count"),
        })
    lagkod = st.get("state")
    robot = {
        "version": 1,
        "kalla": _kalla((status or {}).get("enhet", {}).get("namn")),
        "uppdaterad": karta.get("hamtad") or (status or {}).get("hamtad"),
        "publicerad": datetime.now(timezone.utc).astimezone().isoformat(timespec="seconds"),
        "status": {
            "hamtad": (status or {}).get("hamtad"),
            "batteri": st.get("battery"), "lage_kod": lagkod,
            "lage": LAGEN.get(lagkod, f"Läge {lagkod}" if lagkod is not None else "Okänt"),
            "laddar": st.get("chargeStatus") == 1, "stadar": bool(st.get("inCleaning")),
            "felkod": st.get("errorCode") or 0,
            "senaste_minuter": round((st.get("cleanTime") or 0) / 60),
            "senaste_yta_m2": round((st.get("cleanArea") or 0) / 1e6, 1),
            "delar": delar,
        },
        "totalt": {
            "stadningar": summa.get("cleanCount"),
            "timmar": round((summa.get("cleanTime") or 0) / 3600),
            "yta_m2": round((summa.get("cleanArea") or 0) / 1e6),
            "tomningar": summa.get("dustCollectionCount"),
        },
        "stadningar": stadningar,
        "karta": {
            "bredd": cw * s, "hojd": ch * s, "cell_px": s, "cell_mm": CELL_MM,
            "celler": [cw, ch],
            "rum": rum,
            "no_go": [omr(a) for a in karta.get("no_go", [])],
            "no_mop": [omr(a) for a in karta.get("no_mop", [])],
            "virtuella_vaggar": [T.px(w["mm"][0], w["mm"][1]) + T.px(w["mm"][2], w["mm"][3])
                                 for w in karta.get("virtuella_väggar", [])],
            "hinder": hinder,
            "laddstation": punkt(karta.get("laddstation")),
            "robot": punkt(karta.get("robot")),
            "stadvag": _forenkla_vag(vagar),
            "vaggar": _rektanglar(vagg_c),  # [x, y, b, h] i celler (× cell_px = px)
        },
    }
    jsonfil = UT / "robot.json"
    jsonfil.write_text(json.dumps(robot, ensure_ascii=False, separators=(",", ":")), encoding="utf-8")
    return {"karta": str(bildfil), "json": str(jsonfil), "bild_px": [cw * s, ch * s], "rum": len(rum),
            "hinder": len(hinder), "vagpunkter": sum(len(v) for v in robot["karta"]["stadvag"]),
            "vaggrektanglar": len(robot["karta"]["vaggar"]), "json_kb": round(jsonfil.stat().st_size / 1024, 1)}


def kryptera_in(sammanfattning: dict) -> None:
    """Lägg båda filerna krypterade i data/valv/robot/ (Node-valvet, samma format som sajten)."""
    for logiskt, fil in (("robot/karta.png", sammanfattning["karta"]), ("robot/robot.json", sammanfattning["json"])):
        r = subprocess.run(["node", str(ROT / "verktyg" / "valv.js"), "skriv", logiskt, fil],
                           cwd=ROT, capture_output=True, text=True, encoding="utf-8")
        if r.returncode != 0:
            raise SystemExit(f"valv.js skriv {logiskt} misslyckades: {r.stderr.strip()}")
        print(r.stdout.strip())


if __name__ == "__main__":
    import sys

    if hasattr(sys.stdout, "reconfigure"):
        sys.stdout.reconfigure(encoding="utf-8")
    info = bygg()
    print(json.dumps(info, ensure_ascii=False, indent=2))
    if "--kryptera" in sys.argv:
        kryptera_in(info)

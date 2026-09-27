"""Husvakten – vaktrunda med Roborock S7 MaxV UTAN att städa (⚠ RÖR ROBOTEN).

Roboten åker med `app_goto_target` (ingen sug, ingen mopp) till ett antal punkter i varje rum, tar de hinderfoton
den själv tar på vägen, och skickas sedan hem med `app_charge`. Inga städkommandon används någonsin
(app_start / app_segment_clean / app_zoned_clean finns inte i den här filen). Startar ALDRIG av sig själv – inget
schema, inget anrop från synka.py/live.py. Varje riktig körning kräver Marcs ja.

    python verktyg/roborock/patrull.py --torrkorning        # läser kartan, planerar målen, skickar INGA kommandon
    python verktyg/roborock/patrull.py --kor                # ⚠ kör vaktrundan (status → mål → hem), sparar resultat
    python verktyg/roborock/patrull.py --galleri [resultat] # AI-klassa fotona, lägg i valvet/galleriet, push, notis
    python verktyg/roborock/patrull.py --kor --galleri      # båda stegen i följd

Säkerhet: stoppar direkt (inget kommando) om roboten inte står i dockan, har < 30 % batteri eller en felkod.
Vid fel/avvikelse (felkod, städläge, timeout 4 min per mål, total maxtid 25 min) skickas app_charge.
Allt rått (kartbild, foton, resultat) ligger bara i ~/.roborock/data/patrull/ – in i repot går allt krypterat
via verktyg/logga.js (bilderna skalas och strippas där på ALL metadata).
"""
from __future__ import annotations

import argparse
import asyncio
import contextlib
import io
import json
import logging
import math
import pathlib
import re
import shutil
import subprocess
import sys
import time
from datetime import datetime, timedelta
from typing import Any

HAR = pathlib.Path(__file__).resolve().parent
sys.path.insert(0, str(HAR))
import live  # noqa: E402 – git, git_las, skicka_telegram, RumsKarta, logg
import publicera  # noqa: E402 – HINDERNAMN, RUMSNAMN, LAGEN
import robo  # noqa: E402 – anslut, hamta_karta, hamta_foton, goto

ROT = HAR.parents[1]
HEM = pathlib.Path.home() / ".roborock"
DATA = HEM / "data"
UT = DATA / "patrull"
LAS = HEM / "patrull.lock"
DOLT = live.DOLT

MIN_BATTERI = 30
MAL_TIMEOUT_S = 240
TOTAL_MAX_S = 25 * 60
HEMRESA_RESERV_S = 5 * 60        # sluta besöka nya mål när så här lite tid återstår
DOCKNING_MAX_S = 10 * 60
POLL_S = 4
NADD_MM = 400                    # närmare än så = målet nått (700 gav falskt "nått" nära dockan 27/9)
MAX_MISS_I_RAD = 2               # så många mål i rad som inte nås → avbryt (roboten vägrar/kommer inte fram)
ZONMARGINAL_MM = 450             # håll så här långt från robotfria zoner
MIN_FRI_CELLER = 8               # minst 0,4 m till vägg/möbelkant (1 cell = 50 mm)
M2_PER_PUNKT = 6.0               # fler punkter = fler vägar genom rummet = fler chanser till hinderfoton
MAX_PER_RUM = 6
MIN_FRAN_DOCKAN_MM = 900
DOCKAD = {8, 100}                # laddar / fulladdad
STADLAGEN = {5, 11, 17, 18}      # städar – får aldrig hända under en vaktrunda
FELLAGEN = {9, 12}
KATEGORIER = ("plocka_upp", "smutsigt", "rent", "annat")
OBJEKT_FOR_RUM = live.OBJEKT_FOR_RUM
MEDDELANDE = ("Husvakten: vaktrunda (test) i galleriet\n\n"
              "Co-Authored-By: Claude Opus 5.5 (1M context) <noreply@anthropic.com>")


def skriv(text: str) -> None:
    print(text, flush=True)
    live.logg("patrull: " + text)


# ---------- planering (bara läsning av kartan) ----------

def planera(karta: dict) -> dict:
    """Mål i robot-mm: fri golvyta i varje rum, utanför robotfria zoner (+marginal), ordnade från dockan."""
    import cv2
    import numpy as np

    g, k = karta.get("grid") or {}, karta.get("koordinater") or {}
    fil = DATA / (g.get("fil") or "karta_grid.bin")
    if not g or not fil.exists():
        raise RuntimeError("kartans rutnät saknas – kör robo.py karta")
    w, h = g["bredd"], g["höjd"]
    arr = np.frombuffer(fil.read_bytes(), dtype=np.uint8)[: w * h].reshape(h, w)
    arum = np.where(((arr & 7) == 7) & (arr != 7) & (arr != 255), arr >> 3, 0)
    golv = ((arum > 0) | (arr == 7) | (arr == 255)).astype(np.uint8)
    fri = cv2.distanceTransform(golv, cv2.DIST_L2, 5)
    L, T = k["vänster_celler"], k["topp_celler"]
    xs_mm = (np.arange(w) + L) * 50 + 25
    ys_mm = (np.arange(h) + T) * 50 + 25
    X, Y = np.meshgrid(xs_mm, ys_mm)
    forbjuden = np.zeros_like(golv, dtype=bool)
    zoner = [a["mm"] for a in karta.get("no_go") or []]
    for z in zoner:
        zx, zy = z[0::2], z[1::2]
        forbjuden |= ((X >= min(zx) - ZONMARGINAL_MM) & (X <= max(zx) + ZONMARGINAL_MM)
                      & (Y >= min(zy) - ZONMARGINAL_MM) & (Y <= max(zy) + ZONMARGINAL_MM))
    ladd = (karta.get("laddstation") or {}).get("mm") or [0, 0]
    forbjuden |= np.hypot(X - ladd[0], Y - ladd[1]) < MIN_FRAN_DOCKAN_MM

    rk = live.RumsKarta()
    rum_ut, mal = [], []
    for r in sorted(karta.get("rum") or [], key=lambda r: r["segment_id"]):
        sid = r["segment_id"]
        namn = rk.namn_for(sid) or f"Rum {sid}"
        mask = arum == sid
        yta = float(mask.sum()) * 0.0025
        info = {"segment_id": sid, "namn": namn, "yta_m2": round(yta, 1), "mal": []}
        rum_ut.append(info)
        tillatet = mask & ~forbjuden
        kand = None
        for troskel in (MIN_FRI_CELLER, 6, 4):
            c = tillatet & (fri >= troskel)
            if c.any():
                kand = c
                info["fri_troskel_m"] = troskel * 0.05
                break
        if kand is None:
            info["hoppas_over"] = "ingen fri golvyta utanför zonerna"
            continue
        cy, cx = np.nonzero(kand)
        px, py = xs_mm[cx], ys_mm[cy]
        my, mx = np.nonzero(mask)
        mitt = (float(xs_mm[mx].mean()), float(ys_mm[my].mean()))
        n = max(1, min(MAX_PER_RUM, round(yta / M2_PER_PUNKT)))
        poang = np.hypot(px - mitt[0], py - mitt[1]) - 60 * fri[cy, cx]  # nära mitten, långt från kanter
        valda = [int(np.argmin(poang))]
        avst = np.hypot(px - px[valda[0]], py - py[valda[0]])
        while len(valda) < n:  # längst bort från redan valda → sprid punkterna över rummet
            i = int(np.argmax(avst))
            if avst[i] < 1200:
                break
            valda.append(i)
            avst = np.minimum(avst, np.hypot(px - px[i], py - py[i]))
        for i in valda:
            p = {"rum": namn, "segment_id": sid, "mm": [int(px[i]), int(py[i])],
                 "fri_m": round(float(fri[cy[i], cx[i]]) * 0.05, 2)}
            # dubbelkoll med samma funktion som vaktloggen använder
            p["i_zon"] = rk.i_robotfri_zon(p["mm"][0], p["mm"][1], zoner)
            p["rum_kontroll"] = rk.namn_for(rk.rum_vid(*p["mm"]))
            info["mal"].append(p["mm"])
            mal.append(p)
    # närmaste-granne från dockan
    ordning, kvar, pos = [], list(mal), ladd
    while kvar:
        nasta = min(kvar, key=lambda p: math.dist(pos, p["mm"]))
        kvar.remove(nasta)
        ordning.append(nasta)
        pos = nasta["mm"]
    fel = [p for p in ordning if p["i_zon"] or p["rum_kontroll"] != p["rum"]]
    return {"laddstation": ladd, "zoner": zoner, "rum": rum_ut, "mal": ordning, "tveksamma": fel}


def rita_plan(karta_png: pathlib.Path, karta: dict, plan: dict, rutt: list, ut: pathlib.Path,
              besok: list | None = None) -> pathlib.Path:
    from PIL import Image, ImageDraw

    k = karta["koordinater"]

    def px(x: float, y: float) -> tuple[float, float]:
        return ((x / 50 - k["vänster_celler"]) * k["skala"], (k["höjd_celler"] - (y / 50 - k["topp_celler"]) - 1) * k["skala"])

    bild = Image.open(karta_png).convert("RGB")
    d = ImageDraw.Draw(bild)
    for z in plan["zoner"]:
        pts = [px(z[i], z[i + 1]) for i in range(0, 8, 2)]
        d.polygon(pts, outline=(220, 30, 30), width=3)
    if len(rutt) > 1:
        d.line([px(x, y) for _, x, y in rutt], fill=(30, 110, 255), width=3)
    status = {tuple(b["mm"]): b.get("resultat") for b in (besok or [])}
    for n, p in enumerate(plan["mal"], 1):
        x, y = px(*p["mm"])
        res = status.get(tuple(p["mm"]))
        farg = (40, 170, 70) if res == "nått" else (240, 150, 20) if res else (130, 60, 200)
        d.ellipse([x - 9, y - 9, x + 9, y + 9], fill=farg, outline=(255, 255, 255), width=2)
        d.text((x + 11, y - 7), str(n), fill=(0, 0, 0))
    lx, ly = px(*plan["laddstation"])
    d.rectangle([lx - 7, ly - 7, lx + 7, ly + 7], fill=(20, 20, 20))
    ut.parent.mkdir(parents=True, exist_ok=True)
    bild.save(ut)
    return ut


# ---------- körning (⚠ rör roboten) ----------

class Avbryt(Exception):
    pass


async def ogonblick(dev, med_karta: bool = True) -> dict:
    p = dev.v1_properties
    await asyncio.wait_for(p.status.refresh(), 30)
    st = p.status.as_dict()
    s = {x: st.get(x) for x in ("state", "battery", "errorCode", "inCleaning", "fanPower", "waterBoxMode")}
    s["t"] = time.time()
    if med_karta:
        with contextlib.suppress(Exception):
            await asyncio.wait_for(p.map_content.refresh(), 45)
            md = p.map_content.map_data
            if md is not None:
                if md.vacuum_position:
                    s["pos"] = [md.vacuum_position.x, md.vacuum_position.y]
                s["rum_id"] = md.vacuum_room
                s["hinder"] = [o.as_dict() for o in (md.obstacles_with_photo or [])] + \
                              [o.as_dict() for o in (md.obstacles or [])]
    return s


def kontrollera(s: dict) -> None:
    if s.get("state") in STADLAGEN:
        raise Avbryt(f"roboten gick in i städläge ({publicera.LAGEN.get(s['state'])}) – avbryter")
    if s.get("state") in FELLAGEN or (s.get("errorCode") or 0):
        raise Avbryt(f"fel: läge {s.get('state')}, felkod {s.get('errorCode')} "
                     f"({live.FELTEXT.get(s.get('errorCode'), '')})")


async def kor(plan: dict, dev, t0: float, logg: dict) -> None:
    rutt, hinder = logg["rutt"], logg["hinder_sedda"]

    def notera(s: dict) -> None:
        if s.get("pos"):
            rutt.append([round(s["t"] - t0), s["pos"][0], s["pos"][1]])
        for o in s.get("hinder") or []:
            nyckel = o.get("photo_name") or f"{o.get('type')}@{round(o.get('x', 0) / 250)},{round(o.get('y', 0) / 250)}"
            if nyckel not in hinder:
                hinder[nyckel] = {**o, "sedd_s": round(s["t"] - t0), "robot_pos": s.get("pos")}

    miss = 0
    for n, m in enumerate(plan["mal"], 1):
        if time.time() - t0 > TOTAL_MAX_S - HEMRESA_RESERV_S:
            logg["besok"].append({**m, "resultat": "hoppades över (tidsgräns)"})
            continue
        skriv(f"mål {n}/{len(plan['mal'])}: {m['rum']} {m['mm']}")
        svar = await robo.goto(dev, m["mm"][0], m["mm"][1], bekraftat=True)
        start, sett_rorelse, s = time.time(), False, {}
        while True:
            await asyncio.sleep(POLL_S)
            s = await ogonblick(dev)
            notera(s)
            logg.setdefault("lagen", []).append([round(s["t"] - t0), n, s.get("state")])
            kontrollera(s)
            if s.get("state") == 16:
                sett_rorelse = True
            elif sett_rorelse or time.time() - start > 25:
                if s.get("state") in DOCKAD and not sett_rorelse:
                    raise Avbryt(f"goto_target verkar inte fungera (svar {svar}, roboten står kvar i dockan)")
                if s.get("state") not in {16, 1}:
                    break
            if time.time() - start > MAL_TIMEOUT_S:
                raise Avbryt(f"mål {n} ({m['rum']}) nåddes inte inom {MAL_TIMEOUT_S // 60} min")
            if time.time() - t0 > TOTAL_MAX_S:
                raise Avbryt("total maxtid 25 min nådd")
        avst = math.dist(s["pos"], m["mm"]) if s.get("pos") else None
        res = "nått" if avst is not None and avst <= NADD_MM else "stannade före målet"
        logg["besok"].append({**m, "resultat": res, "avstand_mm": round(avst) if avst else None,
                              "sek": round(time.time() - start), "lage": publicera.LAGEN.get(s.get("state"))})
        skriv(f"  → {res} ({round(avst) if avst else '?'} mm, {round(time.time() - start)} s, "
              f"batteri {s.get('battery')} %, hinder hittills {len(hinder)})")
        miss = 0 if res == "nått" else miss + 1
        if miss >= MAX_MISS_I_RAD:
            raise Avbryt(f"{miss} mål i rad nåddes inte – roboten kommer inte fram, avbryter")


async def hem(dev, t0: float, logg: dict) -> dict:
    from roborock.roborock_typing import RoborockCommand as C
    skriv("skickar app_charge (hem till dockan)")
    await dev.v1_properties.command.send(C.APP_CHARGE, params=None)
    start, s = time.time(), {}
    while time.time() - start < DOCKNING_MAX_S:
        await asyncio.sleep(POLL_S + 1)
        with contextlib.suppress(Exception):
            s = await ogonblick(dev)
            if s.get("pos"):
                logg["rutt"].append([round(s["t"] - t0), s["pos"][0], s["pos"][1]])
            if s.get("state") in DOCKAD:
                return s
            if s.get("state") in (2, 3) and time.time() - start > 60:  # stod still – skicka igen en gång
                await dev.v1_properties.command.send(C.APP_CHARGE, params=None)
    return s


async def vaktrunda(a: argparse.Namespace) -> dict:
    dm, dev = await robo.anslut()
    try:
        karta = await robo.hamta_karta(dev)
        robo.spara_json("karta.json", karta)
        plan = planera(karta)
        s0 = await ogonblick(dev, med_karta=False)
        stamp = datetime.now().strftime("%Y%m%d-%H%M")
        mapp = UT / stamp
        logg: dict = {"runda": f"v-{stamp}", "start": live.iso(), "plan": plan, "status_fore": s0,
                      "rutt": [], "besok": [], "hinder_sedda": {}, "torrkorning": bool(a.torrkorning)}
        fore = {o.get("photo_name") for o in karta.get("hinder_med_foto") or []} | \
               {o.get("photo_name") for o in karta.get("ignorerade_hinder_med_foto") or []}
        logg["foto_fore"] = sorted(x for x in fore if x)
        skriv(f"status: {publicera.LAGEN.get(s0.get('state'), s0.get('state'))}, batteri {s0.get('battery')} %, "
              f"felkod {s0.get('errorCode')}")
        for r in plan["rum"]:
            skriv(f"  {r['namn']} ({r['yta_m2']} m²): {len(r['mal'])} mål {r.get('hoppas_over', '')}")
        for n, m in enumerate(plan["mal"], 1):
            skriv(f"  mål {n}: {m['rum']} {m['mm']} fri {m['fri_m']} m zon={m['i_zon']} kontroll={m['rum_kontroll']}")
        if DATA.joinpath("karta.png").exists():
            skriv("planbild: " + str(rita_plan(DATA / "karta.png", karta, plan, [], mapp / "plan.png")))
        if plan["tveksamma"]:
            raise SystemExit(f"STOPP: {len(plan['tveksamma'])} mål ligger i zon/fel rum – inget skickat")
        if a.torrkorning:
            skriv("torrkörning – inga kommandon skickade")
            return logg
        if s0.get("state") not in DOCKAD:
            raise SystemExit(f"STOPP: roboten står inte i dockan (läge {s0.get('state')}) – inget skickat")
        if (s0.get("battery") or 0) < MIN_BATTERI:
            raise SystemExit(f"STOPP: batteri {s0.get('battery')} % < {MIN_BATTERI} % – inget skickat")
        if s0.get("errorCode"):
            raise SystemExit(f"STOPP: felkod {s0.get('errorCode')} – inget skickat")
        if not plan["mal"]:
            raise SystemExit("STOPP: inga mål planerade")
        if LAS.exists() and time.time() - LAS.stat().st_mtime < 3600:
            raise SystemExit("STOPP: en annan vaktrunda kör (patrull.lock)")
        LAS.write_text(live.iso(), encoding="utf-8")
        t0 = time.time()
        try:
            await kor(plan, dev, t0, logg)
        except Avbryt as e:
            logg["avbruten"] = str(e)
            skriv("AVBRYTER: " + str(e))
        except Exception as e:  # noqa: BLE001 – alltid hem
            logg["avbruten"] = f"{type(e).__name__}: {e}"
            skriv("AVBRYTER (oväntat): " + logg["avbruten"])
        finally:
            slut = await hem(dev, t0, logg)
            LAS.unlink(missing_ok=True)
        logg["status_efter"] = slut
        logg["dockad"] = slut.get("state") in DOCKAD
        logg["minuter"] = round((time.time() - t0) / 60, 1)
        logg["slut"] = live.iso()
        skriv(f"hemma: {logg['dockad']} ({publicera.LAGEN.get(slut.get('state'))}), batteri {slut.get('battery')} %, "
              f"{logg['minuter']} min")
        # efteråt: ny karta + hinderfoton (bara läsning)
        karta2 = await robo.hamta_karta(dev)
        robo.spara_json("karta.json", karta2)
        foton = await robo.hamta_foton(dev, karta2)
        robo.spara_json("foton.json", foton)
        alla = [o for o in (karta2.get("hinder_med_foto") or []) + (karta2.get("ignorerade_hinder_med_foto") or [])
                if o.get("photo_name")]
        nya = [o for o in alla if o["photo_name"] not in fore]
        for key, o in logg["hinder_sedda"].items():  # hinder som sågs under rundan men försvann från slutkartan
            if o.get("photo_name") and o["photo_name"] not in fore and not any(x["photo_name"] == key for x in nya):
                nya.append(o)
        # foton som bara sågs under rundan hämtas här (samma läsning som robo.hamta_foton)
        mappf = DATA / "foton"
        for o in nya:
            fil = mappf / f"{o['photo_name'].replace('/', '_')}.jpg"
            if not fil.exists() and dev.v1_properties.obstacle_photos is not None:
                with contextlib.suppress(Exception):
                    f = await asyncio.wait_for(dev.v1_properties.obstacle_photos.get_photo(o["photo_name"]), 30)
                    if f and f.image_content:
                        mappf.mkdir(parents=True, exist_ok=True)
                        fil.write_bytes(f.image_content)
            o["lokal"] = str(fil) if fil.exists() else None
        logg["foton_nya"] = nya
        logg["hinderfoto_pa"] = foton.get("hinderfoto_på")
        if DATA.joinpath("karta.png").exists():
            logg["kartbild"] = str(rita_plan(DATA / "karta.png", karta2, plan, logg["rutt"], mapp / "karta-rutt.png",
                                             logg["besok"]))
        logg["karta_efter"] = {x: karta2.get(x) for x in ("robot", "laddstation", "robot_rum")}
        mapp.mkdir(parents=True, exist_ok=True)
        (mapp / "resultat.json").write_text(json.dumps(logg, ensure_ascii=False, indent=2, default=robo._json_default),
                                            encoding="utf-8")
        skriv(f"resultat: {mapp / 'resultat.json'} – {len(nya)} nya hinderfoton")
        return logg
    finally:
        with contextlib.suppress(Exception):
            await dm.close()


# ---------- AI-klassning + galleri ----------

def ai_klassa(foto: pathlib.Path, rum: str | None, robot_etikett: str) -> dict:
    """claude -p --model haiku (prenumerationen, aldrig API) på en kopia i ~/.roborock/tmp."""
    ut = {"objekt": "okänt", "kategori": "annat", "atgard": "Titta på fotot själv.", "sakerhet": 0.0,
          "overens": None, "ok": False}
    claude = shutil.which("claude") or str(pathlib.Path.home() / ".local" / "bin" / "claude.exe")
    tmpdir = HEM / "tmp"
    tmpdir.mkdir(parents=True, exist_ok=True)
    tmp = tmpdir / f"vakt-{int(time.time() * 1000)}.jpg"
    try:
        shutil.copyfile(foto, tmp)
        prompt = (f"Läs bilden {tmp.name} i den här mappen. Den är tagen av en robotdammsugares kamera nära golvet"
                  f"{' i ' + rum if rum else ''} under en vaktrunda. Robotens egen etikett: '{robot_etikett}'. "
                  "Svara med EN rad JSON och inget annat: "
                  '{"objekt":"vad som syns, kort svenska","kategori":"plocka_upp|smutsigt|rent|annat",'
                  '"atgard":"en kort svensk uppmaning, t.ex. Plocka upp strumpan i sovrummet (eller Inget att göra)",'
                  '"sakerhet":0.0-1.0,"stammer_med_robot":true|false}. '
                  "plocka_upp = saker som ska plockas upp (strumpor, kläder, skor, kablar, leksaker, papper); "
                  "smutsigt = smuts, smulor, fläckar, damm, spill; rent = fritt golv; annat = möbler m.m.")
        r = subprocess.run([claude, "-p", "--model", "haiku", "--allowedTools", "Read"], cwd=tmpdir, input=prompt,
                           capture_output=True, text=True, encoding="utf-8", errors="replace", timeout=120,
                           creationflags=DOLT)
        m = re.search(r"\{[^{}]*\"kategori\"[^{}]*\}", r.stdout or "")
        if r.returncode != 0 or not m:
            live.logg(f"patrull AI misslyckades ({r.returncode}): {(r.stdout or r.stderr or '')[:200]}")
            return ut
        d = json.loads(m.group(0))
        kat = str(d.get("kategori", "")).strip().lower()
        ut = {"objekt": re.sub(r"\s+", " ", str(d.get("objekt") or "okänt")).strip()[:80],
              "kategori": kat if kat in KATEGORIER else "annat",
              "atgard": re.sub(r"\s+", " ", str(d.get("atgard") or "")).strip()[:100] or "Inget att göra.",
              "sakerhet": max(0.0, min(1.0, float(d.get("sakerhet") or 0))),
              "overens": d.get("stammer_med_robot") if isinstance(d.get("stammer_med_robot"), bool) else None,
              "ok": True}
    except Exception as e:  # noqa: BLE001 – ett foto får aldrig stoppa resten
        live.logg(f"patrull AI fel: {type(e).__name__}: {e}")
    finally:
        with contextlib.suppress(OSError):
            tmp.unlink()
    return ut


def robot_etikett(o: dict) -> str:
    d = (o.get("description") or "").strip().lower()
    if d:
        return publicera.HINDERNAMN.get(d, d)
    return f"hinder typ {o.get('type')}" if o.get("type") is not None else "okänt hinder"


def logga(args: list[str], vakt: dict) -> dict:
    UT.mkdir(parents=True, exist_ok=True)
    vf = UT / "vakt-tmp.json"
    vf.write_text(json.dumps(vakt, ensure_ascii=False), encoding="utf-8")
    r = subprocess.run(["node", str(ROT / "verktyg" / "logga.js"), *args, "--vakt", str(vf)], cwd=ROT,
                       capture_output=True, text=True, encoding="utf-8", errors="replace", timeout=180,
                       creationflags=DOLT)
    vf.unlink(missing_ok=True)
    if r.returncode != 0:
        raise RuntimeError("logga.js: " + (r.stderr or r.stdout).strip()[:300])
    return json.loads(r.stdout)


def tidigare_foton(res: dict) -> tuple[list[dict], datetime | None]:
    """Hinderfoton som redan låg på kartan före rundan (från senaste städningen) + städningens starttid."""
    nar = None
    with contextlib.suppress(Exception):
        h = json.loads((DATA / "historik.json").read_text(encoding="utf-8"))
        r = h["poster"][0]["rå"]
        r = r[0] if isinstance(r, list) else r
        nar = datetime.fromtimestamp(r["begin"]).astimezone()
    ut = []
    for pid in res.get("foto_fore") or []:
        o = (res.get("hinder_sedda") or {}).get(pid)
        fil = DATA / "foton" / f"{pid.replace('/', '_')}.jpg"
        if o and fil.exists():
            ut.append({**o, "lokal": str(fil), "tidigare": True})
    return ut, nar


def galleri(res: dict, push: bool = True, notis: bool = True, aven_tidigare: bool = False) -> dict:
    rk = live.RumsKarta()
    start = datetime.fromisoformat(res["start"])
    etikett = f"Vaktrunda (test) {start.strftime('%Y-%m-%d %H:%M')}"
    runda = res["runda"]
    foton = []
    kallor = list(res.get("foton_nya") or [])
    tidig_nar = None
    if aven_tidigare:
        tidigare, tidig_nar = tidigare_foton(res)
        kallor += tidigare
    for o in kallor:
        if not o.get("lokal") or not pathlib.Path(o["lokal"]).exists():
            continue
        rum = rk.namn_for(rk.rum_vid(o["x"], o["y"])) if o.get("x") is not None else None
        ai = ai_klassa(pathlib.Path(o["lokal"]), rum, robot_etikett(o))
        foton.append({"o": o, "rum": rum, "ai": ai, "robot": robot_etikett(o), "tidigare": bool(o.get("tidigare"))})
        skriv(f"foto {o['photo_name']}: {rum} robot={robot_etikett(o)} AI={ai['kategori']} {ai['objekt']}")
    besokta = {b["rum"] for b in res.get("besok") or [] if b.get("resultat") == "nått"}
    rumslista = list(dict.fromkeys([r["namn"] for r in res["plan"]["rum"]] + [f["rum"] for f in foton if f["rum"]]))
    sammanf = {}
    for r in rumslista:
        fr = [f for f in foton if f["rum"] == r]
        sammanf[r] = {"plocka_upp": sum(f["ai"]["kategori"] == "plocka_upp" for f in fr),
                      "smutsigt": sum(f["ai"]["kategori"] == "smutsigt" for f in fr),
                      "foton": len(fr), "besokt": r in besokta}
    tid = start
    loggade = []
    for f in foton:  # ett galleri-kort per foto
        smuts = f["ai"]["kategori"] in ("plocka_upp", "smutsigt")
        obj = OBJEKT_FOR_RUM.get(f["rum"] or "", "golv-vardagsrum")
        tid += timedelta(seconds=1)
        ftid, fetikett = tid, etikett
        if f["tidigare"]:  # ärligt: fotot togs under förra städningen, inte under vaktrundan
            ftid = (tidig_nar or tid) + timedelta(seconds=len(loggade))
            fetikett = (f"Hinderfoto städning {tidig_nar.strftime('%d/%m %H:%M')}" if tidig_nar
                        else "Hinderfoto senaste städningen") + " (klassat vid vaktrundan)"
        vakt = {"runda": runda, "etikett": fetikett, "typ": "foto", "rum": f["rum"], "robotEtikett": f["robot"],
                **{k: f["ai"][k] for k in ("objekt", "kategori", "atgard", "sakerhet", "overens")}}
        args = ["--objekt", obj, "--status", "smutsig" if smuts else "ren", "--person", "Robot",
                "--tid", ftid.isoformat(), "--bild", f["o"]["lokal"], "--notis", f"{fetikett}: {f['ai']['atgard']}"]
        loggade.append(logga(args, vakt)["handelse"]["id"])
    kartbild = res.get("kartbild")
    karta_lagd = False
    for i, r in enumerate(rumslista):  # sist per rum: rummets golvstatus följer fynden
        obj = OBJEKT_FOR_RUM.get(r)
        s = sammanf[r]
        if not obj or (not s["besokt"] and not s["foton"]):
            continue
        tid += timedelta(seconds=1)
        smuts = s["plocka_upp"] + s["smutsigt"] > 0
        text = (f"{etikett}: {s['plocka_upp']} att plocka upp, {s['smutsigt']} smutsiga ställen" if smuts
                else f"{etikett}: inget på golvet (ingen städning)")
        if not s["besokt"]:
            text += " (rummet nåddes inte, status från fotona)"
        
        vakt = {"runda": runda, "etikett": etikett, "typ": "rum", "rum": r, "sammanfattning": sammanf,
                "minuter": res.get("minuter"), "dockad": res.get("dockad"),
                "besok": [{"rum": b["rum"], "resultat": b["resultat"]} for b in res.get("besok") or []]}
        args = ["--objekt", obj, "--status", "smutsig" if smuts else "ren", "--person", "Robot",
                "--tid", tid.isoformat(), "--notis", text]
        if kartbild and not karta_lagd and pathlib.Path(kartbild).exists():
            karta_lagd = True
            vakt["typ"] = "karta"
            args += ["--bild", kartbild]
        loggade.append(logga(args, vakt)["handelse"]["id"])
    ut = {"etikett": etikett, "foton": len(foton), "sammanfattning": sammanf, "handelser": loggade}
    if push and loggade:
        ut["commit"] = pusha()
    if notis:
        delar = [f"{r}: {s['plocka_upp']} plocka upp, {s['smutsigt']} smutsigt" for r, s in sammanf.items()
                 if s["besokt"] or s["foton"]]
        live.skicka_telegram(f"🤖 <b>Husvakten</b>: {etikett} klar – {len(foton)} foton, "
                             f"{'åter i dockan' if res.get('dockad') else 'INTE i dockan'}, "
                             f"batteri {(res.get('status_efter') or {}).get('battery')} %. "
                             + "; ".join(delar) + ". Se Husvakten → Galleri.")
    return ut


def pusha() -> str:
    vagar = ["data/valv/events.json.enc", "data/valv/foton"]
    with live.git_las():
        live.git("add", "--", *vagar)
        staged = [f for f in live.git("diff", "--cached", "--name-only").splitlines() if f]
        fel = [f for f in staged if not (f.startswith("data/valv/") and f.endswith(".enc"))]
        if fel:
            live.git("reset", "-q", "--", *vagar, kontroll=False)
            raise RuntimeError(f"vägrar commita okrypterat: {fel}")
        live.git("commit", "-q", "-m", MEDDELANDE, "--", *vagar)
        live.git("pull", "-q", "--rebase")
        live.git("push", "-q")
        return live.git("rev-parse", "--short", "HEAD")


def main() -> int:
    ap = argparse.ArgumentParser(description="Husvakten – vaktrunda utan städning (⚠ rör roboten med --kor)")
    ap.add_argument("--torrkorning", action="store_true", help="planera målen, skicka inga kommandon")
    ap.add_argument("--kor", action="store_true", help="⚠ kör vaktrundan (kräver Marcs ja)")
    ap.add_argument("--galleri", nargs="?", const="senaste", help="AI-klassa + lägg i galleriet (resultat.json)")
    ap.add_argument("--aven-tidigare", action="store_true",
                    help="galleri: klassa även hinderfotona från senaste städningen (märks så)")
    ap.add_argument("--ingen-push", action="store_true")
    ap.add_argument("--ingen-notis", action="store_true")
    a = ap.parse_args()
    logging.basicConfig(level=logging.ERROR, stream=io.StringIO())
    if sys.platform == "win32":
        asyncio.set_event_loop_policy(asyncio.WindowsSelectorEventLoopPolicy())
    if not (a.torrkorning or a.kor or a.galleri):
        ap.error("välj --torrkorning, --kor och/eller --galleri")
    res = None
    if a.torrkorning or a.kor:
        if a.torrkorning:
            a.kor = False
        res = asyncio.run(vaktrunda(a))
    if a.galleri and not a.torrkorning:
        if res is None:
            fil = (max(UT.glob("*/resultat.json"), key=lambda p: p.stat().st_mtime) if a.galleri == "senaste"
                   else pathlib.Path(a.galleri))
            res = json.loads(fil.read_text(encoding="utf-8"))
        print(json.dumps(galleri(res, push=not a.ingen_push, notis=not a.ingen_notis,
                                 aven_tidigare=a.aven_tidigare), ensure_ascii=False, indent=2))
    return 0


if __name__ == "__main__":
    if hasattr(sys.stdout, "reconfigure"):
        sys.stdout.reconfigure(encoding="utf-8")
    sys.exit(main())

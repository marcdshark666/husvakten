"""Husvakten – livebevakare ("Vaktlogg") för Roborock S7 MaxV. BARA LÄSNING – skickar aldrig rörelse- eller ändringskommandon.

Startas av synka.py när roboten är igång (eller för hand). Så länge roboten städar läses status + karta
lokalt var ~90:e s och en tidslinje skrivs: start (hur den startades), lägesbyten i klartext, vilket rum den är i,
nya AI-hinder (typ, rum, foto + AI-bedömning via lokala `claude -p --model haiku`), fel och avslut.

  * Tidslinjen (senaste 200 händelserna) ligger i klartext BARA i ~/.roborock/vaktlogg.json och krypteras in i
    valvet som robot/logg.json (data/valv/robot/logg.json.enc). Push vid viktiga händelser (start, fynd, fel, klar),
    högst var 3:e minut. Commit: "Husvakten: robotlogg".
  * Golvvakten: efter körningen grupperas fynden per rum → händelse på "Golvet – <rum>" (person Robot) via
    verktyg/logga.js: SMUTSIG "2 × kläder, 1 × skor" + första fotot, eller REN om körningen blev klar utan fynd där.
  * Misstänkt (bara indikationer): startad utanför schemat nattetid eller med knappen på roboten, fel/fast robot,
    robot i robotfri zon / zonfel, ovanliga hinderklasser.
  * Notiser till Marcs telefon (node ~/.claude/hooks/telegram-send.js), max 1 per händelsetyp per 10 min.

    python verktyg/roborock/live.py                       # bevaka (avslutar direkt om roboten laddar/vilar)
    python verktyg/roborock/live.py --simulera            # spela upp en påhittad körning LOKALT (inget valv, ingen push,
                                                          # inga notiser) – skriver ~/.roborock/sim/
    python verktyg/roborock/live.py --ingen-notis         # skicka inga Telegram-notiser (loggas i live.log)
    python verktyg/roborock/live.py --ingen-ai            # hoppa över AI-bedömningen av fotona
    python verktyg/roborock/live.py --testnotis "text"    # skicka en notis och avsluta

Låsfil (~/.roborock/live.lock) så bara en instans kör. Allt loggas i ~/.roborock/live.log; avslutar alltid tyst (0).
"""
from __future__ import annotations

import argparse
import asyncio
import contextlib
import html
import io
import json
import logging
import os
import pathlib
import random
import re
import shutil
import subprocess
import sys
import time
import traceback
from datetime import datetime, timedelta, timezone
from typing import Any

HAR = pathlib.Path(__file__).resolve().parent
ROT = HAR.parents[1]
HEM = pathlib.Path.home() / ".roborock"
DATA = HEM / "data"
LOGG = HEM / "live.log"
GITLAS = HEM / "git.lock"
TELEGRAM = pathlib.Path.home() / ".claude" / "hooks" / "telegram-send.js"
DOLT = subprocess.CREATE_NO_WINDOW if sys.platform == "win32" else 0

POLL_S = 90
MAX_BEVAKNING_S = 4 * 3600
PUSH_MIN_S = 180
NOTIS_MIN_S = 600
MAX_HANDELSER = 200
LAS_GAMMALT_S = 10 * 60      # låset "touchas" varje varv; äldre än så = kvarlämnat
MAX_FEL_I_RAD = 5
AI_TIMEOUT_S = 90
FOTO_MAXSIDA = 640
MEDDELANDE = "Husvakten: robotlogg\n\nCo-Authored-By: Claude Opus 5.5 (1M context) <noreply@anthropic.com>"

sys.path.insert(0, str(HAR))
import publicera  # noqa: E402 – LAGEN, HINDERNAMN, RUMSNAMN, STARTSATT, _schema, _foto_namn

# Robotens rum (namn som i robotfliken) → Husvakten-objekt i js/karta.js
OBJEKT_FOR_RUM = {"Vardagsrum": "golv-vardagsrum", "Rum 1": "golv-rum1", "Rum 2": "golv-rum2"}

LAGE_IKON = {1: "▶️", 2: "💤", 3: "⏳", 5: "🧹", 6: "🏠", 7: "🎮", 8: "🔌", 9: "⚠️", 10: "⏸️", 11: "🎯",
             12: "⚠️", 15: "🏠", 16: "📍", 17: "🧹", 18: "🧹", 22: "🗑️", 23: "🫧", 26: "🫧", 29: "🗺️", 100: "🔋"}
STADLAGEN = {5, 11, 17, 18}
RORLIGA = {1, 4, 5, 6, 7, 10, 11, 12, 15, 16, 17, 18, 22, 23, 26, 29}
VILA = {2, 3, 8, 100}

FELTEXT = {
    1: "lasern är blockerad", 2: "stötfångaren har fastnat", 3: "hjulen hänger i luften (lyft/fast)",
    4: "kantsensorn (fallsensor) ger fel", 5: "huvudborsten har fastnat", 6: "sidoborsten har fastnat",
    7: "hjulen har fastnat", 8: "roboten sitter fast", 9: "dammbehållaren saknas", 10: "filtret är blött/igensatt",
    11: "starkt magnetfält", 12: "låg batterinivå", 13: "laddningsfel", 14: "batterifel", 15: "väggsensorn är smutsig",
    16: "roboten lutar", 17: "fel på sidoborsten", 18: "fläktfel", 19: "dockan saknar ström",
    20: "golvsensorn är smutsig", 21: "stötfångaren trycks in", 22: "hittar inte dockan", 23: "kom inte tillbaka till dockan",
    24: "robotfri zon upptäckt", 25: "kamerafel", 26: "väggsensorfel", 27: "moppen har fastnat", 28: "roboten står på en matta",
    29: "filtret är igensatt", 30: "osynlig vägg upptäckt", 31: "kan inte korsa mattan", 32: "internt fel",
    34: "töm dockans dammpåse", 38: "kolla rentvattentanken", 39: "kolla smutsvattentanken", 41: "rentvattentanken är tom",
}
ZONFEL = {24, 30}
FASTFEL = {2, 3, 7, 8, 16, 21, 27}

MISSTANKTA_KLASSER = {"pet": "husdjur", "poop": "bajs", "pet waste": "bajs", "person": "en person", "human": "en person",
                      "people": "en person"}
VANLIGA_KLASSER = set(publicera.HINDERNAMN) - set(MISSTANKTA_KLASSER)
HINDERIKON = {"clothes": "👕", "shoes": "👟", "sock": "🧦", "cable": "🔌", "power strip": "🔌", "poop": "💩",
              "pet waste": "💩", "weighing scale": "⚖️", "weighting scale": "⚖️", "furniture with a crossbar": "🪑",
              "pedestal": "🪑", "dustpan": "🧹", "fabric": "🧣", "pet": "🐾", "bed": "🛏️", "sofa": "🛋️"}
BEDOMNINGAR = ("smutsigt", "stökigt", "rent", "misstänkt", "oklart")


# ---------- småhjälpare ----------

def logg(text: str) -> None:
    HEM.mkdir(parents=True, exist_ok=True)
    try:
        if LOGG.exists() and LOGG.stat().st_size > 1_000_000:
            LOGG.replace(LOGG.with_suffix(".log.1"))
        with LOGG.open("a", encoding="utf-8") as f:
            f.write(time.strftime("%Y-%m-%d %H:%M:%S ") + str(text).rstrip() + "\n")
    except OSError:
        pass  # loggen får aldrig stoppa bevakningen


def iso(t: datetime | None = None) -> str:
    return (t or datetime.now(timezone.utc)).astimezone().isoformat(timespec="seconds")


def tolka_tid(s: str) -> datetime:
    return datetime.fromisoformat(s)


def klocka(s: str) -> str:
    return tolka_tid(s).astimezone().strftime("%H:%M")


def las_json(p: pathlib.Path, standard: Any) -> Any:
    try:
        return json.loads(p.read_text(encoding="utf-8"))
    except (OSError, ValueError):
        return standard


def skriv_json(p: pathlib.Path, data: Any) -> None:
    p.parent.mkdir(parents=True, exist_ok=True)
    tmp = p.with_suffix(p.suffix + ".tmp")
    tmp.write_text(json.dumps(data, ensure_ascii=False, indent=1), encoding="utf-8")
    tmp.replace(p)


def i_repot(p: pathlib.Path) -> bool:
    try:
        p.resolve().relative_to(ROT)
        return True
    except ValueError:
        return False


def git(*args: str, kontroll: bool = True) -> str:
    r = subprocess.run(["git", *args], cwd=ROT, capture_output=True, text=True, encoding="utf-8",
                       errors="replace", creationflags=DOLT, timeout=180)
    if kontroll and r.returncode != 0:
        raise RuntimeError(f"git {' '.join(args)}: {(r.stderr or r.stdout).strip()[:400]}")
    return r.stdout.strip()


@contextlib.contextmanager
def git_las(vanta_s: float = 240):
    """Gemensamt lås för git-arbete (live.py och synka.py) så de inte krockar i index.lock."""
    t0 = time.time()
    while GITLAS.exists() and time.time() - GITLAS.stat().st_mtime < 600:
        if time.time() - t0 > vanta_s:
            raise RuntimeError("git.lock hålls av någon annan")
        time.sleep(3)
    GITLAS.write_text(str(os.getpid()), encoding="utf-8")
    try:
        yield
    finally:
        with contextlib.suppress(OSError):
            GITLAS.unlink()


def node_skriv(logiskt: str, fil: pathlib.Path) -> None:
    if i_repot(fil):
        raise RuntimeError("källfilen ligger i repot – vägrar")
    r = subprocess.run(["node", str(ROT / "verktyg" / "valv.js"), "skriv", logiskt, str(fil)], cwd=ROT,
                       capture_output=True, text=True, encoding="utf-8", errors="replace", creationflags=DOLT, timeout=120)
    if r.returncode != 0:
        raise RuntimeError(f"valv.js skriv {logiskt}: {r.stderr.strip()[:300]}")


# ---------- vilka stigar (riktig körning eller simulering) ----------

class Stig:
    def __init__(self, sim: bool):
        self.sim = sim
        self.bas = HEM / "sim" if sim else HEM
        self.las = self.bas / "live.lock"
        self.tillstand = self.bas / "live-state.json"
        self.vaktlogg = self.bas / "vaktlogg.json"
        self.foton = (self.bas / "foton") if sim else (DATA / "foton")
        self.rena = (self.bas / "rena-foton") if sim else (DATA / "publicera" / "foton")
        self.tmp = HEM / "tmp"


def las_ar_upptaget(las: pathlib.Path) -> bool:
    return las.exists() and time.time() - las.stat().st_mtime < LAS_GAMMALT_S


def kor_redan() -> bool:
    """Används av synka.py: kör en riktig livebevakare just nu?"""
    return las_ar_upptaget(HEM / "live.lock")


# ---------- rum ur kartan ----------

class RumsKarta:
    """Robot-mm → rum. Rumsnamnen byggs som i publicera.py (sorterade segment, "Rum N" om namnlöst)."""

    def __init__(self) -> None:
        k = las_json(DATA / "karta.json", {}) or {}
        rum = sorted(k.get("rum") or [], key=lambda r: r["segment_id"])
        self.namn: dict[int, str] = {}
        self.bbox: dict[int, list[float]] = {}
        for nr, r in enumerate(rum, 1):
            n = (r.get("namn") or "").strip()
            self.namn[r["segment_id"]] = publicera.RUMSNAMN.get(n.lower(), n) if n else f"Rum {nr}"
            self.bbox[r["segment_id"]] = r.get("bbox_mm") or []
        self.koord = k.get("koordinater") or {}
        g = k.get("grid") or {}
        self.grid = None
        f = DATA / (g.get("fil") or "karta_grid.bin")
        if g and f.exists() and g.get("bredd") == self.koord.get("bredd_celler"):
            self.grid = (f.read_bytes(), g["bredd"], g["höjd"])
        self.no_go = [a["mm"] for a in (k.get("no_go") or [])]

    def namn_for(self, rid: Any) -> str | None:
        try:
            return self.namn.get(int(rid)) if rid not in (None, "") else None
        except (TypeError, ValueError):
            return None

    def rum_vid(self, x: float, y: float) -> int | None:
        if self.grid and self.koord:
            buf, w, h = self.grid
            cx = int(x / 50 - self.koord["vänster_celler"])
            cy = int(y / 50 - self.koord["topp_celler"])
            for r in range(0, 5):  # hinder ligger ofta intill vägg/möbel – leta närmaste rumscell
                for dy in range(-r, r + 1):
                    for dx in range(-r, r + 1):
                        if max(abs(dx), abs(dy)) != r:
                            continue
                        xx, yy = cx + dx, cy + dy
                        if 0 <= xx < w and 0 <= yy < h:
                            v = buf[yy * w + xx]
                            if (v & 7) == 7 and v not in (7, 255):
                                return v >> 3
        traff = [(abs((b[2] - b[0]) * (b[3] - b[1])), rid) for rid, b in self.bbox.items()
                 if len(b) == 4 and b[0] <= x <= b[2] and b[1] <= y <= b[3]]
        return min(traff)[1] if traff else None

    def i_robotfri_zon(self, x: float, y: float, zoner: list | None = None) -> bool:
        for v in zoner if zoner is not None else self.no_go:
            xs, ys = v[0::2], v[1::2]
            if min(xs) <= x <= max(xs) and min(ys) <= y <= max(ys):
                return True
        return False


# ---------- källor: riktig robot eller simulering ----------

def ar_aktiv(s: dict) -> bool:
    return bool(s.get("inCleaning")) or s.get("state") in RORLIGA


class RobotKalla:
    """Läser roboten (bara läskommandon via robo.py)."""

    def __init__(self) -> None:
        self.dm = self.dev = None

    async def oppna(self) -> None:
        import robo
        self.robo = robo
        self.dm, self.dev = await robo.anslut()

    async def stang(self) -> None:
        if self.dm:
            with contextlib.suppress(Exception):
                await self.dm.close()

    async def vanta(self, s: float) -> None:
        await asyncio.sleep(s)

    async def ogonblick(self) -> dict:
        p = self.dev.v1_properties
        await asyncio.wait_for(p.status.refresh(), 30)
        st = p.status.as_dict()
        s = {k: st.get(k) for k in ("state", "inCleaning", "errorCode", "dockErrorStatus", "battery", "cleanTime",
                                    "cleanArea", "cleanPercent")}
        s["tid"] = iso()
        if ar_aktiv(s):  # kartan bara när roboten är igång (färre anrop)
            try:
                await asyncio.wait_for(p.map_content.refresh(), 60)
                md = p.map_content.map_data
            except Exception as e:  # noqa: BLE001 – status räcker om kartan inte kom
                logg(f"karta misslyckades: {type(e).__name__}: {e}")
                md = None
            if md is not None:
                if md.vacuum_position:
                    s["robot_mm"] = [md.vacuum_position.x, md.vacuum_position.y]
                s["rum_id"] = md.vacuum_room
                s["hinder"] = [o.as_dict() for o in (md.obstacles_with_photo or [])] + \
                              [o.as_dict() for o in (md.obstacles or [])]
                s["no_go"] = [a.as_list() for a in (md.no_go_areas or [])]
                s["stadade_rum"] = list(md.cleaned_rooms or [])
        return s

    async def foto(self, pid: str) -> bytes | None:
        p = self.dev.v1_properties
        if p.obstacle_photos is None:
            return None
        f = await asyncio.wait_for(p.obstacle_photos.get_photo(pid), 30)
        return f.image_content if f and f.image_content else None

    async def schema(self) -> list[str]:
        from roborock.roborock_typing import RoborockCommand as C
        ra = {}
        for k in (C.GET_TIMER, C.GET_SERVER_TIMER):
            with contextlib.suppress(Exception):
                ra[str(k.value)] = await self.robo.las(self.dev, k)
        return publicera._schema(ra)

    async def senaste_post(self) -> dict | None:
        from roborock.roborock_typing import RoborockCommand as C
        p = self.dev.v1_properties
        await asyncio.wait_for(p.clean_summary.refresh(), 30)
        ids = p.clean_summary.records or []
        if not ids:
            return None
        r = await self.robo.las(self.dev, C.GET_CLEAN_RECORD, [ids[0]])
        r = r[0] if isinstance(r, list) and r else r
        return r if isinstance(r, dict) else None

    async def hamta_allt(self) -> None:
        """Samma läsning som `robo.py alla` på den öppna anslutningen (för robotfliken efter körningen)."""
        r = self.robo
        karta = await r.hamta_karta(self.dev)
        r.spara_json("status.json", await r.hamta_status(self.dev))
        r.spara_json("karta.json", karta)
        r.spara_json("historik.json", await r.hamta_historik(self.dev))
        r.spara_json("foton.json", await r.hamta_foton(self.dev, karta))


class SimKalla:
    """Påhittad körning byggd ur den lokala kartan (~/.roborock/data/karta.json). Skriver bara i ~/.roborock/sim/."""

    def __init__(self, stig: Stig, rk: RumsKarta):
        self.stig, self.rk = stig, rk
        self.t = datetime.now(timezone.utc) - timedelta(minutes=40)
        self.i = 0
        self.steg = self._bygg()

    def _mitt(self, rid: int) -> list[float]:
        b = self.rk.bbox.get(rid) or [0, 0, 1000, 1000]
        return [(b[0] + b[2]) / 2, (b[1] + b[3]) / 2]

    def _bygg(self) -> list[dict]:
        ids = sorted(self.rk.namn) or [1, 2, 16]
        stor = max(ids, key=lambda i: (lambda b: (b[2] - b[0]) * (b[3] - b[1]) if len(b) == 4 else 0)(self.rk.bbox.get(i, [])))
        andra = [i for i in ids if i != stor] or [stor]
        r1, r2 = andra[0], andra[-1]
        v, a, b = self._mitt(stor), self._mitt(r2), self._mitt(r1)
        hk = lambda p, d, nr, off=0: {"x": p[0] + off, "y": p[1] + off, "type": 1, "description": d,  # noqa: E731
                                      "confidence_level": 0.9, "photo_name": f"sim/foto_{nr}"}
        h1 = hk(v, "clothes", 1, 300)
        h2, h3 = hk(a, "clothes", 2, -200), hk(a, "shoes", 3, 250)
        h4 = hk(b, "unknown thing", 4, 100)
        bas = {"errorCode": 0, "dockErrorStatus": 0, "battery": 80, "inCleaning": 1, "no_go": [], "stadade_rum": []}
        s = [
            {"state": 5, "rum_id": stor, "robot_mm": v, "hinder": []},
            {"state": 5, "rum_id": stor, "robot_mm": v, "hinder": [h1]},
            {"state": 5, "rum_id": r2, "robot_mm": a, "hinder": [h1, h2, h3]},
            {"state": 23, "rum_id": r2, "robot_mm": a, "hinder": [h1, h2, h3]},
            {"state": 5, "rum_id": r1, "robot_mm": b, "hinder": [h1, h2, h3, h4]},
            {"state": 12, "errorCode": 8, "rum_id": r1, "robot_mm": b, "hinder": [h1, h2, h3, h4]},
            {"state": 5, "rum_id": r1, "robot_mm": b, "hinder": [h1, h2, h3, h4]},
            {"state": 6, "rum_id": stor, "robot_mm": v, "hinder": [h1, h2, h3, h4], "stadade_rum": [stor, r1, r2]},
            {"state": 22, "inCleaning": 0, "rum_id": stor, "robot_mm": v, "hinder": [h1, h2, h3, h4], "stadade_rum": [stor, r1, r2]},
            {"state": 8, "inCleaning": 0, "rum_id": stor, "robot_mm": v, "hinder": [h1, h2, h3, h4], "stadade_rum": [stor, r1, r2]},
        ]
        return [{**bas, **x, "cleanTime": 240 * (n + 1), "cleanArea": 4_000_000 * (n + 1)} for n, x in enumerate(s)]

    async def oppna(self) -> None:
        pass

    async def stang(self) -> None:
        pass

    async def vanta(self, s: float) -> None:
        self.t += timedelta(seconds=s * 3)

    async def ogonblick(self) -> dict | None:
        if self.i >= len(self.steg):
            return None
        s = dict(self.steg[self.i])
        self.i += 1
        s["tid"] = iso(self.t)
        return s

    async def foto(self, pid: str) -> bytes | None:
        from PIL import Image, ImageDraw
        typ = {"sim/foto_1": "kläder", "sim/foto_2": "kläder", "sim/foto_3": "skor", "sim/foto_4": "okänt"}.get(pid, "?")
        bild = Image.new("RGB", (640, 480), (110, 100, 90))
        d = ImageDraw.Draw(bild)
        d.rectangle([180, 160, 460, 340], fill=(60, 80, 140) if typ != "skor" else (40, 40, 40))
        d.text((20, 20), f"SIMULERAT HINDERFOTO – {typ}", fill=(255, 255, 255))
        ut = io.BytesIO()
        bild.save(ut, "JPEG", quality=80)
        return ut.getvalue()

    async def schema(self) -> list[str]:
        return []

    async def senaste_post(self) -> dict | None:
        slut = self.t
        return {"begin": int((slut - timedelta(minutes=38)).timestamp()), "end": int(slut.timestamp()),
                "duration": 38 * 60, "area": 42_500_000, "complete": 1, "start_type": 1, "avoid_count": 4}

    async def hamta_allt(self) -> None:
        pass


# ---------- AI-bedömning av hinderfoton (lokala claude-CLI:n, aldrig API) ----------

def ai_bedom(foto: pathlib.Path, stig: Stig, rum: str | None, klass: str) -> dict:
    """Kör `claude -p --model haiku` på en temporär kopia utanför repot. Fel → oklart."""
    ut = {"bedomning": "oklart", "text": "AI-bedömningen kunde inte göras just nu."}
    claude = shutil.which("claude") or str(pathlib.Path.home() / ".local" / "bin" / "claude.exe")
    if not pathlib.Path(claude).exists() and not shutil.which("claude"):
        ut["text"] = "AI-bedömning saknas (claude-CLI:n hittades inte)."
        return ut
    stig.tmp.mkdir(parents=True, exist_ok=True)
    tmp = stig.tmp / f"hinder-{int(time.time())}-{random.randint(1000, 9999)}.jpg"
    try:
        shutil.copyfile(foto, tmp)
        prompt = (f"Läs bilden {tmp.name} i den här mappen. Den är tagen av en robotdammsugare på golvet"
                  f"{' i ' + rum if rum else ''}; robotens egen gissning är '{klass}'. "
                  "Svara med EN rad JSON och inget annat: "
                  '{"bedomning":"smutsigt|stökigt|rent|misstänkt|oklart","text":"kort svensk beskrivning av vad som '
                  'ligger på golvet och i vilket skick (max 20 ord)"}')
        # Prompten via stdin (--allowedTools tar flera värden och skulle annars äta upp den)
        r = subprocess.run([claude, "-p", "--model", "haiku", "--allowedTools", "Read"], cwd=stig.tmp, input=prompt,
                           capture_output=True, text=True, encoding="utf-8", errors="replace",
                           timeout=AI_TIMEOUT_S, creationflags=DOLT)
        m = re.search(r"\{[^{}]*\"bedomning\"[^{}]*\}", r.stdout or "")
        if r.returncode != 0 or not m:
            logg(f"AI-bedömning misslyckades (kod {r.returncode}): {(r.stdout or r.stderr or '').strip()[:200]}")
            return ut
        d = json.loads(m.group(0))
        b = str(d.get("bedomning", "")).strip().lower()
        ut = {"bedomning": b if b in BEDOMNINGAR else "oklart",
              "text": re.sub(r"\s+", " ", str(d.get("text") or "")).strip()[:160] or "Ingen beskrivning."}
    except subprocess.TimeoutExpired:
        logg("AI-bedömning: tidsgränsen 90 s nåddes")
        ut["text"] = "AI-bedömningen tog för lång tid."
    except Exception as e:  # noqa: BLE001 – bedömningen får aldrig stoppa vakten
        logg(f"AI-bedömning fel: {type(e).__name__}: {e}")
    finally:
        with contextlib.suppress(OSError):
            tmp.unlink()
    return ut


# ---------- själva vakten ----------

class Vakt:
    def __init__(self, stig: Stig, kalla, rk: RumsKarta, ingen_notis: bool, ingen_ai: bool):
        self.stig, self.kalla, self.rk = stig, kalla, rk
        self.ingen_notis, self.ingen_ai = ingen_notis, ingen_ai
        self.st = las_json(stig.tillstand, {}) or {}
        self.st.setdefault("notiser", {})
        self.logg = las_json(stig.vaktlogg, None) or {"version": 1, "handelser": []}
        self.logg.setdefault("handelser", [])
        self.golv_argument: list[list[str]] = []   # logga.js-anrop som väntar på nästa push
        self.skickade: list[str] = []

    # --- tidslinjen ---
    def handelse(self, typ: str, ikon: str, text: str, tid: str, **extra: Any) -> dict:
        k = self.st.get("korning") or {}
        h = {"id": "h-" + tolka_tid(tid).strftime("%Y%m%d-%H%M%S") + "-" + format(random.randint(0, 0xffff), "04x"),
             "tid": tid, "typ": typ, "ikon": ikon, "text": text}
        if k.get("id"):
            h["korning"] = k["id"]
        h.update({a: b for a, b in extra.items() if b not in (None, "", False)})
        self.logg["handelser"].append(h)
        self.logg["handelser"] = self.logg["handelser"][-MAX_HANDELSER:]
        logg(f"händelse [{typ}] {text}")
        return h

    def notis(self, typ: str, text: str) -> None:
        nu = time.time()
        if nu - self.st["notiser"].get(typ, 0) < NOTIS_MIN_S:
            logg(f"notis spärrad (max 1 per 10 min för {typ}): {text}")
            return
        self.st["notiser"][typ] = nu
        if self.ingen_notis:
            logg("NOTIS (ej skickad): " + text)
            self.skickade.append(text)
            return
        skicka_telegram(text)

    def viktig(self) -> None:
        self.st["vantar_push"] = True

    # --- ett varv ---
    async def behandla(self, s: dict) -> str:
        k = self.st.get("korning")
        aktiv = ar_aktiv(s)
        if k is None:
            if not aktiv:
                return "vila"
            await self.starta(s)
            k = self.st["korning"]
        tid = s["tid"]
        k["senast"] = tid
        kod = s.get("state")
        rid = s.get("rum_id")
        rnamn = self.rk.namn_for(rid)
        if rid is not None and rnamn and kod in STADLAGEN:
            if rnamn not in k["rum"]:
                k["rum"].append(rnamn)
        for r in s.get("stadade_rum") or []:
            n = self.rk.namn_for(r)
            if n and n not in k["rum"]:
                k["rum"].append(n)

        # Lägesbyten i klartext
        if kod != k.get("lage_kod"):
            k["lage_kod"] = kod
            text = publicera.LAGEN.get(kod, f"Läge {kod}")
            if kod in STADLAGEN and rnamn:
                text += " i " + rnamn
                k["rum_nu"] = rnamn
            if kod not in (12, 9):  # fel beskrivs nedan
                self.handelse("lage", LAGE_IKON.get(kod, "ℹ️"), text, tid, rum=rnamn if kod in STADLAGEN else None)
        elif kod in STADLAGEN and rnamn and rnamn != k.get("rum_nu"):
            k["rum_nu"] = rnamn
            self.handelse("rum", "📍", "Städar nu i " + rnamn, tid, rum=rnamn)
        k["lage"] = publicera.LAGEN.get(kod, f"Läge {kod}")

        # Fel / fast
        fk = s.get("errorCode") or 0
        if fk and fk != k.get("felkod"):
            k["felkod"] = fk
            beskr = FELTEXT.get(fk, f"felkod {fk}")
            fast = fk in FASTFEL
            rubrik = "Roboten sitter fast" + ("" if fk == 8 else ": " + beskr) if fast else "Fel: " + beskr
            self.handelse("fel", "🆘" if fast else "⚠️", rubrik
                          + (f" ({rnamn})" if rnamn else ""), tid, rum=rnamn, misstankt=True, felkod=fk)
            if fk in ZONFEL:
                self.handelse("misstankt", "🚧", "Zon/dörr-avvikelse: roboten rapporterar " + beskr +
                              ". Kan betyda att en dörr eller möbel flyttats – bara en indikation.", tid, misstankt=True)
            self.notis("fel", f"🤖 <b>Husvakten</b>: {html.escape(rubrik)}"
                              f"{' i ' + html.escape(rnamn) if rnamn else ''}. Se Husvakten → Robot.")
            self.viktig()
        elif not fk and k.get("felkod"):
            k["felkod"] = 0
            self.handelse("lage", "✅", "Felet är åtgärdat – roboten fortsätter", tid)
        dfel = s.get("dockErrorStatus") or 0
        if dfel and dfel != k.get("dockfel"):
            k["dockfel"] = dfel
            self.handelse("fel", "⚠️", f"Dockan rapporterar fel (kod {dfel}) – kolla vattentankar/dammpåse", tid, misstankt=True)
            self.notis("fel", f"🤖 <b>Husvakten</b>: dockan rapporterar fel (kod {dfel}). Se Husvakten → Robot.")
            self.viktig()

        # Robotfri zon (position inne i en no-go-rektangel)
        pos = s.get("robot_mm")
        if pos and self.rk.i_robotfri_zon(pos[0], pos[1], s.get("no_go")) and not k.get("zonflagga"):
            k["zonflagga"] = True
            self.handelse("misstankt", "🚧", "Roboten står i en robotfri zon – har zonen eller möblerna flyttats? "
                          "Bara en indikation.", tid, misstankt=True, rum=rnamn)
            self.viktig()

        # Nya hinder
        for o in self._unika_hinder(s.get("hinder") or []):
            nyckel = o["_nyckel"]
            if nyckel in k["sedda"]:
                continue
            k["sedda"].append(nyckel)
            await self.nytt_fynd(o, tid)

        return "pagar" if aktiv else "klar"

    def _unika_hinder(self, lista: list[dict]) -> list[dict]:
        ut: dict[str, dict] = {}
        for o in lista:
            if o.get("x") is None or o.get("y") is None:
                continue
            d = (o.get("description") or "").strip().lower()
            nyckel = f"{d}@{round(o['x'] / 250)},{round(o['y'] / 250)}"
            if nyckel not in ut or (o.get("photo_name") and not ut[nyckel].get("photo_name")):
                ut[nyckel] = {**o, "_nyckel": nyckel, "_klass": d}
        return list(ut.values())

    async def starta(self, s: dict) -> None:
        tid = s["tid"]
        start = tolka_tid(tid) - timedelta(seconds=int(s.get("cleanTime") or 0))
        schema = []
        with contextlib.suppress(Exception):
            schema = await self.kalla.schema()
        via = "schemat" if enligt_schema(start, schema) else None
        ic = s.get("inCleaning")
        if not via:
            via = "appen (rumsstädning)" if ic == 2 else "appen (zonstädning)" if ic == 3 else "appen eller knappen på roboten"
        self.st["korning"] = {"id": "k-" + start.astimezone().strftime("%Y%m%d-%H%M"), "start": iso(start), "via": via,
                              "rum": [], "sedda": [], "fynd": [], "lage_kod": None, "felkod": 0}
        forsenad = int(s.get("cleanTime") or 0) > 3 * 60
        self.handelse("start", "▶️", f"Städningen startade kl {klocka(iso(start))} – via {via}"
                      + (" (bevakningen kom igång lite senare)" if forsenad else ""), iso(start))
        h = start.astimezone().hour
        if via != "schemat" and (h >= 23 or h < 6):
            self.handelse("misstankt", "🌙", "Startad mitt i natten utan schema – var det någon av er? Bara en indikation.",
                          iso(start), misstankt=True)
            self.notis("misstankt", "🤖 <b>Husvakten</b>: roboten startade nattetid utan schema. Se Husvakten → Robot.")
        self.viktig()

    async def nytt_fynd(self, o: dict, tid: str) -> None:
        k = self.st["korning"]
        klass = o["_klass"]
        namn = publicera.HINDERNAMN.get(klass, f"Okänt föremål ({klass})" if klass else "Okänt hinder")
        rid = self.rk.rum_vid(o["x"], o["y"])
        rnamn = self.rk.namn_for(rid) or k.get("rum_nu")
        fynd = {"tid": tid, "klass": klass, "namn": namn, "rum": rnamn, "ikon": HINDERIKON.get(klass, "❓")}
        pid = o.get("photo_name")
        lokal = None
        if pid:
            try:
                bytes_ = await self.kalla.foto(pid)
                if bytes_:
                    lokal, logiskt = self._spara_foto(pid, bytes_)
                    fynd["foto"] = logiskt
                    fynd["lokal"] = str(lokal)
            except Exception as e:  # noqa: BLE001
                logg(f"foto {pid} misslyckades: {type(e).__name__}: {e}")
        if lokal and not self.ingen_ai:
            fynd["ai"] = ai_bedom(lokal, self.stig, rnamn, namn)
        misstankt = None
        if klass in MISSTANKTA_KLASSER:
            misstankt = f"AI:n tror att det är {MISSTANKTA_KLASSER[klass]}"
        elif klass and klass not in VANLIGA_KLASSER:
            misstankt = f"ovanlig hinderklass '{klass}'"
        if fynd.get("ai", {}).get("bedomning") == "misstänkt":
            misstankt = misstankt or "AI-bedömningen tycker att det ser misstänkt ut"
        k["fynd"].append(fynd)
        text = f"Nytt fynd: {namn.lower() if klass else 'okänt hinder'}" + (f" i {rnamn}" if rnamn else "")
        self.handelse("fynd", fynd["ikon"], text, tid, rum=rnamn, foto=fynd.get("foto"), klass=klass or None,
                      ai=fynd.get("ai"), misstankt=bool(misstankt))
        if misstankt:
            self.handelse("misstankt", "🔎", f"Misstänkt: {misstankt}" + (f" i {rnamn}" if rnamn else "")
                          + ". Bara en indikation – titta på fotot.", tid, misstankt=True, rum=rnamn)
        ai_txt = f" AI: {html.escape(fynd['ai']['bedomning'])} – {html.escape(fynd['ai']['text'])}." if fynd.get("ai") else ""
        self.notis("fynd", f"🤖 <b>Husvakten</b>: nytt fynd – {fynd['ikon']} {html.escape(namn)}"
                           f"{' i ' + html.escape(rnamn) if rnamn else ''}.{ai_txt} Se Husvakten → Robot.")
        self.viktig()

    def _spara_foto(self, pid: str, data: bytes) -> tuple[pathlib.Path, str]:
        from PIL import Image
        fid = publicera._foto_namn(pid)
        self.stig.foton.mkdir(parents=True, exist_ok=True)
        ra = self.stig.foton / f"{fid}.jpg"
        ra.write_bytes(data)
        bild = Image.open(io.BytesIO(data)).convert("RGB")
        bild.thumbnail((FOTO_MAXSIDA, FOTO_MAXSIDA))
        self.stig.rena.mkdir(parents=True, exist_ok=True)
        ren = self.stig.rena / f"{fid}.jpg"
        bild.save(ren, "JPEG", quality=75)  # nysparad – ingen EXIF följer med
        logiskt = f"robot/foton/{fid}.jpg"
        if not self.stig.sim and not (ROT / "data" / "valv" / "robot" / "foton" / f"{fid}.jpg.enc").exists():
            node_skriv(logiskt, ren)
        return ren, logiskt

    async def avsluta(self, s: dict, orsak: str | None = None) -> None:
        k = self.st["korning"]
        tid = s["tid"]
        post = None
        with contextlib.suppress(Exception):
            post = await self.kalla.senaste_post()
        minuter = round((s.get("cleanTime") or 0) / 60)
        yta = round((s.get("cleanArea") or 0) / 1e6, 1)
        klar = orsak is None
        if post and post.get("begin") and abs(post["begin"] - tolka_tid(k["start"]).timestamp()) < 30 * 60:
            minuter = round((post.get("duration") or 0) / 60)
            yta = round((post.get("area") or 0) / 1e6, 1)
            klar = klar and bool(post.get("complete"))
            via = publicera.STARTSATT.get(post.get("start_type"))
            if via:
                k["via"] = via
                if post.get("start_type") == 1:
                    self.handelse("misstankt", "👆", "Körningen startades med knappen på roboten – någon har varit vid "
                                  "den. Om ingen av er var hemma: kolla. Bara en indikation.", tid, misstankt=True)
        n = len(k["fynd"])
        text = (f"Klar kl {klocka(tid)} – {minuter} min, {yta:g} m², {n} fynd" if klar else
                f"Körningen avslutades kl {klocka(tid)}{' (' + orsak + ')' if orsak else ' (avbruten)'} – {minuter} min, "
                f"{yta:g} m², {n} fynd")
        self.handelse("klar", "✅" if klar else "⏹️", text, tid)
        self.golvvakt(k, klar, tid)
        self.notis("klar", f"🤖 <b>Husvakten</b>: {html.escape(text)}. "
                           f"Rum: {html.escape(', '.join(k['rum']) or 'okänt')}. Se Husvakten → Robot.")
        self.st["senaste_korning"] = {"id": k["id"], "start": k["start"], "slut": tid, "minuter": minuter, "yta_m2": yta,
                                      "fynd": n, "klar": klar, "via": k.get("via"), "rum": k["rum"],
                                      "fyndlista": k["fynd"]}
        self.st["korning"] = None
        self.viktig()

    def golvvakt(self, k: dict, klar: bool, tid: str) -> None:
        perrum: dict[str, list[dict]] = {}
        for f in k["fynd"]:
            perrum.setdefault(f.get("rum") or "?", []).append(f)
        rum = list(dict.fromkeys(k["rum"] + [r for r in perrum if r != "?"]))
        for r in rum:
            obj = OBJEKT_FOR_RUM.get(r)
            if not obj:
                logg(f"golvvakt: inget Husvakten-objekt för rummet {r}")
                continue
            fynd = perrum.get(r, [])
            if fynd:
                antal: dict[str, int] = {}
                for f in fynd:
                    antal[f["namn"].lower()] = antal.get(f["namn"].lower(), 0) + 1
                notis = ", ".join(f"{v} × {n}" for n, v in antal.items())
                args = ["--objekt", obj, "--status", "smutsig", "--person", "Robot", "--tid", tid, "--notis", notis]
                bild = next((f["lokal"] for f in fynd if f.get("lokal") and pathlib.Path(f["lokal"]).exists()), None)
                if bild:
                    args += ["--bild", bild]
                self.handelse("golv", "🧽", f"Golvvakten: {r} → smutsigt ({notis})", tid, rum=r)
            elif klar:
                args = ["--objekt", obj, "--status", "ren", "--person", "Robot", "--tid", tid,
                        "--notis", "Roboten städade – inga fynd"]
                self.handelse("golv", "✨", f"Golvvakten: {r} → rent (inga fynd)", tid, rum=r)
            else:
                continue
            self.golv_argument.append(args)

    # --- skanningssammanfattning för fliken ---
    def skanning(self) -> dict | None:
        k = self.st.get("korning") or self.st.get("senaste_korning")
        if not k:
            return None
        fynd = k.get("fynd") if "fynd" in k and isinstance(k.get("fynd"), list) else k.get("fyndlista") or []
        perrum: dict[str, list] = {}
        for f in fynd:
            perrum.setdefault(f.get("rum") or "Okänt rum", []).append(
                {x: f.get(x) for x in ("namn", "ikon", "foto", "ai", "tid", "klass") if f.get(x)})
        rum = list(dict.fromkeys((k.get("rum") or []) + list(perrum)))
        return {"korning": k.get("id"), "start": k.get("start"), "pagar": bool(self.st.get("korning")),
                "rum": [{"namn": r, "fynd": perrum.get(r, []), "fritt": not perrum.get(r)} for r in rum],
                "foton": sum(1 for f in fynd if f.get("foto"))}

    def dokument(self) -> dict:
        k = self.st.get("korning")
        self.logg.update({
            "version": 1, "uppdaterad": iso(), "pagar": bool(k),
            "korning": None if not k else {x: k.get(x) for x in ("id", "start", "via", "lage", "rum_nu", "rum", "senast")}
                                          | {"fynd": len(k.get("fynd") or [])},
            "senaste_korning": {x: v for x, v in (self.st.get("senaste_korning") or {}).items() if x != "fyndlista"} or None,
            "skanning": self.skanning(),
        })
        if self.stig.sim:
            self.logg["simulerad"] = True
        return self.logg

    # --- spara / publicera ---
    def spara_lokalt(self) -> None:
        skriv_json(self.stig.vaktlogg, self.dokument())
        skriv_json(self.stig.tillstand, self.st)

    def publicera(self, tvinga: bool = False, robotdata: dict | None = None) -> None:
        self.spara_lokalt()
        if self.stig.sim:
            for args in self.golv_argument:  # simulering: bara torrkörning, inget skrivs i valvet
                r = kor_logga(args + ["--dry-run"])
                logg("golvvakt (torrkörning): " + ("OK" if r.returncode == 0 else r.stderr.strip()[:200]))
            self.golv_argument = []
            self.st["vantar_push"] = False
            return
        if not self.st.get("vantar_push") and not tvinga:
            return
        if time.time() - self.st.get("senaste_push", 0) < PUSH_MIN_S and not tvinga:
            return
        commit_och_pusha(self, robotdata)
        self.st["vantar_push"] = False
        self.st["senaste_push"] = time.time()
        skriv_json(self.stig.tillstand, self.st)


def enligt_schema(start: datetime, schema: list[str]) -> bool:
    """schema = publicera._schema-rader ('vardagar kl. 09:30'). Matchar ±15 min och rätt dag."""
    lokal = start.astimezone()
    dn = ["mån", "tis", "ons", "tor", "fre", "lör", "sön"]
    for rad in schema:
        m = re.search(r"kl\. (\d\d):(\d\d)", rad)
        if not m:
            continue
        dag = rad.split(" kl.")[0]
        idag = dn[lokal.weekday()]
        ok_dag = (dag == "varje dag" or (dag == "vardagar" and lokal.weekday() < 5)
                  or (dag == "helger" and lokal.weekday() >= 5) or idag in dag)
        if not ok_dag:
            continue
        planerad = lokal.replace(hour=int(m.group(1)), minute=int(m.group(2)), second=0)
        if abs((lokal - planerad).total_seconds()) <= 15 * 60:
            return True
    return False


def kor_logga(args: list[str]) -> subprocess.CompletedProcess:
    return subprocess.run(["node", str(ROT / "verktyg" / "logga.js"), *args], cwd=ROT, capture_output=True, text=True,
                          encoding="utf-8", errors="replace", creationflags=DOLT, timeout=180)


def skicka_telegram(text: str) -> None:
    try:
        r = subprocess.run(["node", str(TELEGRAM), text], capture_output=True, text=True, encoding="utf-8",
                           errors="replace", timeout=60, creationflags=DOLT)
        logg(f"notis skickad ({r.returncode}): {text}")
    except Exception as e:  # noqa: BLE001
        logg(f"notis misslyckades: {type(e).__name__}: {e}")


def commit_och_pusha(v: Vakt, robotdata: dict | None) -> None:
    """pull → kryptera logg (+ golvvakt, + robotfliken) → commit (bara .enc) → push. Försöker om vid krock."""
    for forsok in range(3):
        with git_las():
            git("pull", "-q", "--rebase", "--autostash")
            node_skriv("robot/logg.json", v.stig.vaktlogg)
            vagar = ["data/valv/robot"]
            if v.golv_argument:
                for args in v.golv_argument:
                    r = kor_logga(args)
                    if r.returncode != 0:
                        logg("golvvakt: logga.js fel: " + (r.stderr or r.stdout).strip()[:300])
                vagar += ["data/valv/events.json.enc", "data/valv/foton"]
            if robotdata:
                with contextlib.redirect_stdout(io.StringIO()):
                    publicera.kryptera_in(robotdata)
            git("add", "--", *vagar)
            staged = [f for f in git("diff", "--cached", "--name-only").splitlines() if f]
            fel = [f for f in staged if not (f.startswith("data/valv/") and f.endswith(".enc"))]
            if fel:
                git("reset", "-q", "--", *vagar, kontroll=False)
                raise RuntimeError(f"vägrar commita: {fel}")
            if not staged:
                v.golv_argument = []
                return
            git("commit", "-q", "-m", MEDDELANDE, "--", *vagar)
            try:
                git("push", "-q")
            except RuntimeError:
                try:
                    git("pull", "-q", "--rebase")
                    git("push", "-q")
                except RuntimeError as e:
                    logg(f"push-krock (försök {forsok + 1}): {e}")
                    git("rebase", "--abort", kontroll=False)
                    git("reset", "-q", "--keep", "HEAD~1")  # släpp vår commit, gör om ovanpå det nya
                    continue
            logg(f"pushat {git('rev-parse', '--short', 'HEAD')} ({len(staged)} filer)")
            v.golv_argument = []
            if robotdata:
                with contextlib.suppress(Exception):
                    (HEM / "synk-state.json").write_text(json.dumps(
                        {"hash": publicera.innehallshash(), "tid": time.time(), "commit": git("rev-parse", "--short", "HEAD")}),
                        encoding="utf-8")
            return
    raise RuntimeError("kunde inte pusha efter 3 försök")


# ---------- huvudloop ----------

async def bevaka(a: argparse.Namespace) -> str:
    stig = Stig(a.simulera)
    stig.bas.mkdir(parents=True, exist_ok=True)
    if las_ar_upptaget(stig.las):
        return "en annan livebevakare kör redan (live.lock)"
    stig.las.write_text(str(os.getpid()), encoding="utf-8")
    rk = RumsKarta()
    if a.simulera:
        for p in (stig.tillstand, stig.vaktlogg):  # varje simulering börjar från noll
            with contextlib.suppress(OSError):
                p.unlink()
    kalla = SimKalla(stig, rk) if a.simulera else RobotKalla()
    v = Vakt(stig, kalla, rk, ingen_notis=a.ingen_notis or a.simulera, ingen_ai=a.ingen_ai)
    try:
        await kalla.oppna()
        t0 = time.time()
        fel_i_rad = 0
        while True:
            stig.las.touch()
            try:
                s = await kalla.ogonblick()
                fel_i_rad = 0
            except Exception as e:  # noqa: BLE001 – tappad anslutning: försök igen några gånger
                fel_i_rad += 1
                logg(f"läsning misslyckades ({fel_i_rad}/{MAX_FEL_I_RAD}): {type(e).__name__}: {e}")
                if fel_i_rad >= MAX_FEL_I_RAD:
                    v.spara_lokalt()
                    return "gav upp efter upprepade läsfel (körningen fortsätter vid nästa start)"
                await kalla.vanta(POLL_S)
                continue
            if s is None:  # simuleringen slut
                break
            res = await v.behandla(s)
            if res == "vila":
                lage = publicera.LAGEN.get(s.get("state"), f"läge {s.get('state')}")
                fk = s.get("errorCode") or 0
                if fk and fk != v.st.get("vilofel"):
                    v.st["vilofel"] = fk
                    v.handelse("fel", "⚠️", f"Roboten står still med fel: {FELTEXT.get(fk, f'felkod {fk}')}", s["tid"],
                               misstankt=True)
                    v.notis("fel", f"🤖 <b>Husvakten</b>: roboten har ett fel – {html.escape(FELTEXT.get(fk, str(fk)))}. "
                                   "Se Husvakten → Robot.")
                    v.viktig()
                elif not fk:
                    v.st["vilofel"] = 0
                if not v.logg["handelser"]:
                    v.handelse("info", "📡", f"Vaktloggen är igång – roboten: {lage.lower()}, batteri {s.get('battery')} %",
                               s["tid"])
                    v.viktig()
                v.publicera(tvinga=bool(v.st.get("vantar_push")))
                return f"{lage.lower()} (batteri {s.get('battery')} %) – inget att göra"
            if res == "klar" or time.time() - t0 > MAX_BEVAKNING_S:
                await v.avsluta(s, None if res == "klar" else "bevakningen nådde 4 h")
                robotdata = None
                if not a.simulera:
                    try:  # robotfliken får färsk karta/historik/foton (bara läsning)
                        with contextlib.redirect_stdout(io.StringIO()):
                            await kalla.hamta_allt()
                        robotdata = publicera.bygg()
                    except BaseException as e:  # noqa: BLE001
                        logg(f"robotdata efter körningen misslyckades: {type(e).__name__}: {e}")
                if not a.simulera:
                    vanta = PUSH_MIN_S - (time.time() - v.st.get("senaste_push", 0))
                    if vanta > 0:
                        await asyncio.sleep(vanta)
                v.publicera(tvinga=True, robotdata=robotdata)
                return "körningen klar – loggad och publicerad"
            v.publicera()
            await kalla.vanta(POLL_S)
        v.publicera(tvinga=True)
        return "simuleringen slut"
    finally:
        with contextlib.suppress(Exception):
            v.spara_lokalt()
        await kalla.stang()
        with contextlib.suppress(OSError):
            stig.las.unlink()
        if v.skickade:
            logg(f"{len(v.skickade)} notiser skulle ha skickats (--ingen-notis)")


def starta_bakgrund() -> bool:
    """Starta live.py fristående (utan fönster) – anropas av synka.py. False om den redan kör."""
    if kor_redan():
        return False
    exe = sys.executable
    if sys.platform == "win32" and exe.lower().endswith("python.exe"):
        w = pathlib.Path(exe).with_name("pythonw.exe")
        exe = str(w) if w.exists() else exe
    flaggor = DOLT
    if sys.platform == "win32":
        flaggor |= subprocess.DETACHED_PROCESS | subprocess.CREATE_NEW_PROCESS_GROUP
    for extra in ((0x01000000,) if sys.platform == "win32" else ()) + (0,):  # CREATE_BREAKAWAY_FROM_JOB om tillåtet
        try:
            subprocess.Popen([exe, str(HAR / "live.py")], cwd=ROT, creationflags=flaggor | extra, close_fds=True,
                             stdin=subprocess.DEVNULL, stdout=subprocess.DEVNULL, stderr=subprocess.DEVNULL)
            return True
        except OSError:
            continue
    return False


def main() -> int:
    ap = argparse.ArgumentParser(description="Husvakten – livebevakare (read-only)")
    ap.add_argument("--simulera", action="store_true")
    ap.add_argument("--ingen-notis", action="store_true")
    ap.add_argument("--ingen-ai", action="store_true")
    ap.add_argument("--testnotis")
    a = ap.parse_args()
    logging.basicConfig(level=logging.ERROR, stream=io.StringIO())
    if a.testnotis:
        skicka_telegram(a.testnotis)
        return 0
    if sys.platform == "win32":  # aiomqtt kräver selector-loop
        asyncio.set_event_loop_policy(asyncio.WindowsSelectorEventLoopPolicy())
    t0 = time.time()
    try:
        res = asyncio.run(bevaka(a))
        logg(f"{'SIM ' if a.simulera else ''}OK ({time.time() - t0:.0f} s): {res}")
        if sys.stdout is not None:
            print(res)
    except BaseException as e:  # noqa: BLE001 – avsluta alltid tyst
        logg(f"FEL ({time.time() - t0:.0f} s): {type(e).__name__}: {e}")
        logg(traceback.format_exc(limit=5))
    return 0


if __name__ == "__main__":
    if sys.stdout is not None and hasattr(sys.stdout, "reconfigure"):
        sys.stdout.reconfigure(encoding="utf-8")
    sys.exit(main())

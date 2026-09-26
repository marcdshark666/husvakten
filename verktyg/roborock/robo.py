"""Husvakten – läs ALLT som Roborock S7 MaxV vet (read-only).

Användning:
    python verktyg/roborock/robo.py status     # status, förbrukning, funktioner, DND, timers m.m.
    python verktyg/roborock/robo.py karta      # karta.png + karta.json (rum, väggar, zoner, bana, laddstation)
    python verktyg/roborock/robo.py historik   # städsammanfattning + senaste städposter
    python verktyg/roborock/robo.py foton      # kamerastatus + hinderbilder från kartan
    python verktyg/roborock/robo.py alla       # allt ovan i en anslutning
    python verktyg/roborock/robo.py publicera  # alla + bygg robotfliken och kryptera in i data/valv/robot/
                                               # (--ingen-hamtning = bygg om från redan hämtad data)

All data sparas ENDAST i %USERPROFILE%/.roborock/data/ – aldrig i repot (repot är publikt).
Inloggningen återanvänds från ~/.roborock/husvakten-userdata.json. Ingen ny inloggningskod begärs.

SÄKERHET: CLI:t skickar bara läskommandon (se LASKOMMANDON). Funktionerna under
"RÖRELSE" längst ned får roboten att köra – de anropas aldrig av CLI:t och kräver
bekraftat=True.
"""
from __future__ import annotations

import argparse
import asyncio
import json
import logging
import pathlib
import sys
import time
from datetime import datetime, timezone
from typing import Any

from roborock.data import UserData
from roborock.devices.device_manager import UserParams, create_device_manager
from roborock.devices.file_cache import FileCache
from roborock.map.map_parser import MapParserConfig
from roborock.roborock_typing import RoborockCommand as C
from vacuum_map_parser_base.config.drawable import Drawable

VALV = pathlib.Path.home() / ".roborock"
DATA = VALV / "data"
TOKENFIL = VALV / "husvakten-userdata.json"
CACHEFIL = VALV / "robo-cache.pkl"
KARTSKALA = 4  # 1 kartpixel (50 mm) blir 4 bildpixlar i karta.png

# Enda råkommandona CLI:t får skicka. Allt här är läsning.
LASKOMMANDON: set[str] = {
    C.GET_STATUS, C.GET_CONSUMABLE, C.GET_CLEAN_SUMMARY, C.GET_CLEAN_RECORD,
    C.GET_ROOM_MAPPING, C.GET_MAP_V1, C.GET_MULTI_MAPS_LIST, C.GET_CAMERA_STATUS,
    C.GET_PHOTO, C.GET_DND_TIMER, C.GET_TIMER, C.GET_SERVER_TIMER, C.GET_SERIAL_NUMBER,
    C.GET_FW_FEATURES, C.GET_SOUND_VOLUME, C.GET_CHILD_LOCK_STATUS, C.GET_CARPET_MODE,
    C.GET_CUSTOMIZE_CLEAN_MODE, C.GET_MAP_STATUS, C.APP_GET_INIT_STATUS,
    C.GET_LED_STATUS, C.GET_VALLEY_ELECTRICITY_TIMER, C.GET_NETWORK_INFO,
}
HISTORIK_MAX = 50  # så många städposter som roboten lämnar ut (S7 MaxV ger i praktiken 20)
# Kommandon som FLYTTAR roboten eller startar kamera – skickas aldrig av CLI:t.
RORELSEKOMMANDON: set[str] = {
    C.APP_GOTO_TARGET, C.APP_SEGMENT_CLEAN, C.APP_START_PATROL, C.APP_START_PET_PATROL,
    C.APP_RESUME_PATROL, C.START_CAMERA_PREVIEW, C.APP_ZONED_CLEAN, C.APP_START, C.APP_CHARGE,
}

log = logging.getLogger("robo")


# ---------- hjälpare ----------

def spara_json(namn: str, data: Any) -> pathlib.Path:
    DATA.mkdir(parents=True, exist_ok=True)
    p = DATA / namn
    p.write_text(json.dumps(data, ensure_ascii=False, indent=2, default=_json_default), encoding="utf-8")
    return p


def _json_default(o: Any) -> Any:
    if isinstance(o, bytes):
        return f"<{len(o)} bytes>"
    if isinstance(o, set):
        return sorted(o)
    if hasattr(o, "as_dict"):
        try:
            return o.as_dict()
        except Exception:  # noqa: BLE001 – faller tillbaka på str nedan
            pass
    if hasattr(o, "value"):
        return o.value
    return str(o)


def nu() -> str:
    return datetime.now(timezone.utc).astimezone().isoformat(timespec="seconds")


async def las(dev, kommando: str, params: Any = None, timeout: float = 15) -> Any:
    """Skicka ett råkommando – bara om det finns i LASKOMMANDON."""
    if kommando not in LASKOMMANDON or kommando in RORELSEKOMMANDON:
        raise PermissionError(f"{kommando} är inte ett godkänt läskommando")
    async with asyncio.timeout(timeout):
        return await dev.v1_properties.command.send(kommando, params=params)


async def forsok(fel: dict, namn: str, coro) -> Any:
    """Kör ett steg; fel sparas i `fel` i stället för att stoppa resten."""
    try:
        return await coro
    except Exception as e:  # noqa: BLE001 – vill fortsätta med övriga steg
        fel[namn] = f"{type(e).__name__}: {e}"
        log.warning("%s misslyckades: %s", namn, e)
        return None


# ---------- anslutning ----------

async def anslut():
    if not TOKENFIL.exists():
        raise SystemExit(f"Saknar {TOKENFIL} – logga in med verktyg/roborock_fil_login.py först.")
    d = json.loads(TOKENFIL.read_text(encoding="utf-8"))
    params = UserParams(username=d["epost"], user_data=UserData.from_dict(d["user_data"]))
    konfig = MapParserConfig(drawables=list(Drawable), map_scale=KARTSKALA)
    dm = await create_device_manager(params, cache=FileCache(CACHEFIL), map_parser_config=konfig)
    enheter = await dm.get_devices()
    robot = next((e for e in enheter if e.v1_properties is not None), None)
    if robot is None:
        await dm.close()
        raise SystemExit("Hittade ingen v1-robot på kontot.")
    for _ in range(60):  # upp till 30 s för första anslutningen (MQTT/lokalt)
        if robot.is_connected:
            break
        await asyncio.sleep(0.5)
    if not robot.is_connected:
        await dm.close()
        raise SystemExit("Roboten svarar inte (offline?).")
    return dm, robot


# ---------- läsning ----------

async def hamta_status(dev) -> dict:
    p = dev.v1_properties
    fel: dict = {}
    await forsok(fel, "status", p.status.refresh())
    await forsok(fel, "consumables", p.consumables.refresh())
    await forsok(fel, "dnd", p.dnd.refresh())
    ut: dict = {
        "hamtad": nu(),
        "enhet": {"namn": dev.name, "modell": dev.product.model, "lokal": dev.is_local_connected,
                  "firmware": getattr(dev.device_info, "fv", None)},
        "status": p.status.as_dict(),
        "consumables": p.consumables.as_dict(),
        "dnd": p.dnd.as_dict(),
        "funktioner": {k: v for k, v in p.device_features.as_dict().items()},
        "rå": {},
    }
    for k in (C.GET_TIMER, C.GET_SERVER_TIMER, C.GET_FW_FEATURES,
              C.GET_SOUND_VOLUME, C.GET_CHILD_LOCK_STATUS, C.GET_CARPET_MODE,
              C.GET_CUSTOMIZE_CLEAN_MODE, C.GET_MAP_STATUS, C.GET_CAMERA_STATUS,
              C.GET_VALLEY_ELECTRICITY_TIMER):
        ut["rå"][str(k.value)] = await forsok(fel, str(k.value), las(dev, k))
    # Nätverk: spara BARA signalstyrkan (IP, MAC, SSID och BSSID lämnar aldrig roboten här).
    natet = await forsok(fel, "network_info", las(dev, C.GET_NETWORK_INFO))
    ut["wifi_rssi"] = natet.get("rssi") if isinstance(natet, dict) else None
    ut["fel"] = fel
    return ut


async def hamta_historik(dev, antal: int = HISTORIK_MAX) -> dict:
    p = dev.v1_properties
    fel: dict = {}
    await forsok(fel, "clean_summary", p.clean_summary.refresh())
    s = p.clean_summary
    poster = []
    for rid in (s.records or [])[:antal]:
        r = await forsok(fel, f"record_{rid}", las(dev, C.GET_CLEAN_RECORD, [rid]))
        poster.append({"id": rid, "rå": r})
    return {"hamtad": nu(), "sammanfattning": s.as_dict(), "poster": poster, "fel": fel}


def _pixlar(md) -> dict:
    """Koordinatsystemet: robot-mm → pixel i karta.png."""
    d = md.image.dimensions
    return {
        "enhet": "robotkoordinater i mm; 1 kartcell = 50 mm",
        "vänster_celler": d.left, "topp_celler": d.top, "bredd_celler": d.width,
        "höjd_celler": d.height, "skala": d.scale, "rotation": d.rotation,
        "formel": "px = (x_mm/50 - vänster)*skala ; py = (höjd - (y_mm/50 - topp) - 1)*skala",
        "bildstorlek_px": [int(d.width * d.scale), int(d.height * d.scale)],
    }


def _px(md, x: float, y: float) -> list[float]:
    from vacuum_map_parser_base.map_data import Point
    q = Point(x, y).to_img(md.image.dimensions)
    return [round(q.x, 1), round(q.y, 1)]


def _rumspolygoner(grid, bredd: int, hojd: int, md) -> dict[int, list[list[list[float]]]]:
    """Rumskonturer ur rådata (cv2 om det finns). Punkter i mm."""
    try:
        import cv2
        import numpy as np
    except ImportError:
        return {}
    arr = np.frombuffer(grid, dtype=np.uint8)[: bredd * hojd].reshape(hojd, bredd)
    rum = np.where((arr & 0x07) == 7, arr >> 3, 0)
    d = md.image.dimensions
    ut: dict[int, list] = {}
    for nr in sorted(int(v) for v in np.unique(rum) if v):
        mask = (rum == nr).astype(np.uint8)
        konturer, _ = cv2.findContours(mask, cv2.RETR_EXTERNAL, cv2.CHAIN_APPROX_SIMPLE)
        polys = []
        for k in konturer:
            if cv2.contourArea(k) < 4:
                continue
            k = cv2.approxPolyDP(k, 1.0, True)
            # rådata: rad 0 = y-minimum; cellindex + bildens vänster/topp → mm
            polys.append([[(int(pt[0][0]) + d.left) * 50, (int(pt[0][1]) + d.top) * 50] for pt in k])
        ut[nr] = polys
    return ut


async def hamta_karta(dev) -> dict:
    from vacuum_map_parser_roborock import image_parser as ip

    p = dev.v1_properties
    fel: dict = {}
    await forsok(fel, "status", p.status.refresh())
    await forsok(fel, "rooms", p.rooms.refresh())
    await forsok(fel, "maps", p.maps.refresh())
    rum_mapping = await forsok(fel, "room_mapping_rå", las(dev, C.GET_ROOM_MAPPING))

    # Fånga rå pixeldata för rumspolygoner (parsern kastar den annars).
    fangad: dict = {}
    orig = ip.RoborockImageParser.parse

    def spion(self, raw, width, height, *a, **kw):
        fangad.update(raw=bytes(raw), w=width, h=height)
        return orig(self, raw, width, height, *a, **kw)

    ip.RoborockImageParser.parse = spion
    try:
        await forsok(fel, "map_v1", asyncio.wait_for(p.map_content.refresh(), 60))
    finally:
        ip.RoborockImageParser.parse = orig

    mc = p.map_content
    ut: dict = {"hamtad": nu(), "fel": fel, "room_mapping_rå": rum_mapping,
                "rum_namn": [r.as_dict() for r in (p.rooms.rooms or [])],
                "kartor": p.maps.as_dict(), "aktuell_karta": p.maps.current_map
                if hasattr(p.maps, "current_map") else None}
    if mc.raw_api_response:
        DATA.mkdir(parents=True, exist_ok=True)
        (DATA / "karta.raw").write_bytes(mc.raw_api_response)
    if mc.image_content:
        (DATA / "karta.png").write_bytes(mc.image_content)
    md = mc.map_data
    if md is None or md.image is None:
        return ut
    if fangad:  # rå rutnät (1 byte/cell, rad 0 = y-minimum) – för väggar/rum i publicera
        (DATA / "karta_grid.bin").write_bytes(fangad["raw"][: fangad["w"] * fangad["h"]])
        ut["grid"] = {"fil": "karta_grid.bin", "bredd": fangad["w"], "höjd": fangad["h"],
                      "kodning": "0=utanför, 1=vägg, 255=golv, 7=skannat, annars &7: 0=grå vägg, 1=vägg v2, 7=rum (id = v>>3)"}

    namn = {r.segment_id: r.name for r in (p.rooms.rooms or [])}
    ut["koordinater"] = _pixlar(md)
    polys = _rumspolygoner(fangad["raw"], fangad["w"], fangad["h"], md) if fangad else {}
    ut["rum"] = [{
        "segment_id": nr, "namn": namn.get(nr, r.name),
        "bbox_mm": [r.x0, r.y0, r.x1, r.y1],
        "bbox_px": _px(md, r.x0, r.y1) + _px(md, r.x1, r.y0),
        "polygoner_mm": polys.get(nr, []),
    } for nr, r in sorted((md.rooms or {}).items())]

    def punkt(pt):
        return None if pt is None else {"mm": [pt.x, pt.y], "vinkel": pt.a, "px": _px(md, pt.x, pt.y)}

    def area(a):
        v = a.as_list()
        return {"mm": v, "px": sum((_px(md, v[i], v[i + 1]) for i in range(0, 8, 2)), [])}

    ut["laddstation"] = punkt(md.charger)
    ut["robot"] = punkt(md.vacuum_position)
    ut["robot_rum"] = md.vacuum_room
    ut["gå_till_mål"] = punkt(md.goto)
    ut["virtuella_väggar"] = [{"mm": w.as_list(), "px": _px(md, w.x0, w.y0) + _px(md, w.x1, w.y1)}
                              for w in (md.walls or [])]
    ut["no_go"] = [area(a) for a in (md.no_go_areas or [])]
    ut["no_mop"] = [area(a) for a in (md.no_mopping_areas or [])]
    ut["no_carpet"] = [area(a) for a in (md.no_carpet_areas or [])]
    ut["zoner"] = [z.as_dict() for z in (md.zones or [])]
    ut["hinder"] = [o.as_dict() for o in (md.obstacles or [])]
    ut["hinder_med_foto"] = [o.as_dict() for o in (md.obstacles_with_photo or [])]
    ut["ignorerade_hinder_med_foto"] = [o.as_dict() for o in (md.ignored_obstacles_with_photo or [])]
    ut["städade_rum"] = md.cleaned_rooms
    ut["kartnamn"] = md.map_name
    if md.path:
        ut["städväg_mm"] = [[[q.x, q.y] for q in sub] for sub in md.path.path]
    if md.goto_path:
        ut["gå_till_väg_mm"] = [[[q.x, q.y] for q in sub] for sub in md.goto_path.path]
    ut["kalibrering"] = md.calibration()
    ut["övrigt"] = md.additional_parameters
    return ut


async def hamta_foton(dev, karta: dict | None = None) -> dict:
    p = dev.v1_properties
    fel: dict = {}
    ut: dict = {"hamtad": nu(), "fel": fel}
    ut["ai_hinder_stöds"] = bool(getattr(p.device_features, "is_ai_recognition_obstacle_supported", False))
    cam = await forsok(fel, "camera_status", las(dev, C.GET_CAMERA_STATUS))
    ut["camera_status_rå"] = cam
    if isinstance(cam, list) and cam and isinstance(cam[0], int):
        ut["camera_status_bitar"] = {f"bit{i}": (cam[0] >> i) & 1 for i in range(16) if (cam[0] >> i) & 1}
        ut["hinderfoto_på"] = bool((cam[0] >> 10) & 1)
    if karta is None:
        karta = await hamta_karta(dev)
    ids = [o.get("photo_name") for o in karta.get("hinder_med_foto", []) + karta.get("ignorerade_hinder_med_foto", [])]
    ids = [i for i in ids if i]
    ut["foto_id"] = ids
    ut["sparade"] = []
    if ids and ut.get("hinderfoto_på") is False:
        ut["hoppade_over"] = "hinderfoton är avstängda i roboten"
    elif ids and p.obstacle_photos is None:
        fel["foton"] = "obstacle_photos-traiten saknas för enheten"
    elif ids:
        mapp = DATA / "foton"
        mapp.mkdir(parents=True, exist_ok=True)
        for pid in ids:
            foto = await forsok(fel, f"foto_{pid}", asyncio.wait_for(p.obstacle_photos.get_photo(pid), 30))
            if foto and foto.image_content:
                ext = ".png" if foto.image_content.startswith(b"\x89PNG") else ".jpg"
                fil = mapp / f"{pid.replace('/', '_')}{ext}"
                fil.write_bytes(foto.image_content)
                ut["sparade"].append(str(fil))
    return ut


# ---------- RÖRELSE (RÖR ROBOTEN – anropas aldrig av CLI:t) ----------

async def _rorelse(dev, kommando: str, params: Any, bekraftat: bool) -> Any:
    if not bekraftat:
        raise PermissionError(f"{kommando} FLYTTAR ROBOTEN – kräver bekraftat=True och Marcs ja.")
    return await dev.v1_properties.command.send(kommando, params=params)


async def goto(dev, x_mm: int, y_mm: int, *, bekraftat: bool = False) -> Any:
    """⚠ RÖR ROBOTEN: kör till punkt (robot-mm, samma system som karta.json)."""
    return await _rorelse(dev, C.APP_GOTO_TARGET, [int(x_mm), int(y_mm)], bekraftat)


async def rumsstad(dev, segment_ids: list[int], varv: int = 1, *, bekraftat: bool = False) -> Any:
    """⚠ RÖR ROBOTEN: städa valda rum (segment_id från karta.json)."""
    return await _rorelse(dev, C.APP_SEGMENT_CLEAN, [{"segments": list(segment_ids), "repeat": varv}], bekraftat)


async def patrull(dev, *, bekraftat: bool = False) -> Any:
    """⚠ RÖR ROBOTEN: startar videopatrull (kräver kamerafunktion i appen)."""
    return await _rorelse(dev, C.APP_START_PATROL, None, bekraftat)


# ---------- CLI ----------

async def main(val: str) -> int:
    dm, dev = await anslut()
    try:
        t0 = time.time()
        ut: list[pathlib.Path] = []
        karta = None
        if val in ("status", "alla"):
            ut.append(spara_json("status.json", await hamta_status(dev)))
        if val in ("karta", "alla", "foton"):
            karta = await hamta_karta(dev)
            ut.append(spara_json("karta.json", karta))
        if val in ("historik", "alla"):
            ut.append(spara_json("historik.json", await hamta_historik(dev)))
        if val in ("foton", "alla"):
            ut.append(spara_json("foton.json", await hamta_foton(dev, karta)))
        for p in ut:
            print(f"sparad: {p}")
        if karta and (DATA / "karta.png").exists():
            print(f"sparad: {DATA / 'karta.png'}")
        print(f"klart på {time.time() - t0:.1f} s")
        return 0
    finally:
        await dm.close()


if __name__ == "__main__":
    if hasattr(sys.stdout, "reconfigure"):
        sys.stdout.reconfigure(encoding="utf-8")
    ap = argparse.ArgumentParser(description="Husvakten – läs Roborock (read-only)")
    ap.add_argument("val", choices=["status", "karta", "historik", "foton", "alla", "publicera"])
    ap.add_argument("-v", action="store_true", help="debuglogg")
    ap.add_argument("--ingen-hamtning", action="store_true", help="publicera: använd redan hämtad data")
    a = ap.parse_args()
    logging.basicConfig(level=logging.DEBUG if a.v else logging.WARNING)
    if sys.platform == "win32":  # aiomqtt kräver selector-loop (Proactor saknar add_reader)
        asyncio.set_event_loop_policy(asyncio.WindowsSelectorEventLoopPolicy())
    if a.val == "publicera":
        sys.path.insert(0, str(pathlib.Path(__file__).resolve().parent))
        import publicera  # noqa: E402 – bara när det behövs (numpy/cv2/PIL)

        if not a.ingen_hamtning:
            kod = asyncio.run(main("alla"))  # bara läskommandon
            if kod:
                sys.exit(kod)
        info = publicera.bygg()
        print(json.dumps(info, ensure_ascii=False, indent=2))
        publicera.kryptera_in(info)
        print("klart – commita data/valv/robot/ (krypterat)")
        sys.exit(0)
    sys.exit(asyncio.run(main(a.val)))

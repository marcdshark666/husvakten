#!/usr/bin/env python3
"""Husvakten – Roborock S7 MaxV från hemservern (styrknapparna på iPaden).

Återanvänder inloggningen och anslutningen i verktyg/roborock/robo.py (token i
~/.roborock/husvakten-userdata.json, aldrig i repot). Kör en egen tråd med en selector-
eventloop (aiomqtt kräver det på Windows) och håller anslutningen öppen mellan knapptrycken.

FAST kommandolista (KOMMANDON) – servern skickar aldrig något annat. Rum-städning tar bara
segment-id:n som finns i robotens egen karta (~/.roborock/data/karta.json).
Roboten startar ALDRIG av sig själv härifrån – bara när någon trycker i Husvakten.
"""
from __future__ import annotations

import asyncio
import json
import os
import pathlib
import sys
import threading
import time
from typing import Any

HAR = os.path.dirname(os.path.abspath(__file__))
ROBO_KATALOG = os.path.join(os.path.dirname(HAR), "verktyg", "roborock")
ROBO_DATA = pathlib.Path.home() / ".roborock" / "data"
KARTA = ROBO_DATA / "karta.json"
STATUS_CACHE_SEK = 20
ANSLUT_TIDSGRANS = 45
KOMMANDO_TIDSGRANS = 20

# Lägeskoder → svenska (python-roborock RoborockStateCode).
LAGE: dict[int, str] = {
    0: "Okänt", 1: "Startar", 2: "Laddaren frånkopplad", 3: "Vilar", 4: "Fjärrstyrd", 5: "Städar", 6: "På väg hem",
    7: "Manuellt läge", 8: "Laddar", 9: "Laddningsproblem", 10: "Pausad", 11: "Punktstädar", 12: "Fel", 13: "Stänger av",
    14: "Uppdaterar", 15: "Dockar", 16: "Kör till mål", 17: "Zonstädar", 18: "Städar rum", 22: "Tömmer", 23: "Tvättar moppen",
    25: "Tvättar moppen", 26: "Åker och tvättar moppen", 28: "I samtal", 29: "Kartlägger", 32: "Patrullerar",
    33: "Sätter på moppen", 34: "Tar av moppen", 100: "Fulladdad", 101: "Offline", 103: "Låst",
}
KOR_LAGEN = {5, 6, 11, 15, 16, 17, 18, 26, 29, 32}
PAUS_LAGEN = {10}


class RobotFel(RuntimeError):
    pass


def las_rum() -> list[dict]:
    """Rum ur robotens karta: [{segment_id, namn}] – namnen kan skrivas över i hem.json ("rum")."""
    try:
        k = json.loads(KARTA.read_text(encoding="utf-8"))
    except (OSError, ValueError):
        return []
    ut = []
    for r in k.get("rum") or []:
        sid = r.get("segment_id")
        if isinstance(sid, int):
            ut.append({"segment_id": sid, "namn": r.get("namn") or None})
    return sorted(ut, key=lambda r: r["segment_id"])


class RobotStyr:
    """En tråd + eventloop; anropas synkront från HTTP-trådarna."""

    def __init__(self) -> None:
        self._loop = asyncio.SelectorEventLoop()
        self._trad = threading.Thread(target=self._loop.run_forever, name="robot-loop", daemon=True)
        self._trad.start()
        self._dm = None
        self._dev = None
        self._status: dict | None = None
        self._status_tid = 0.0
        self._lock = threading.Lock()  # ett robotanrop i taget
        self.senaste_fel: str | None = None

    # ---------- körning i loopen ----------
    def _kor(self, coro, tidsgrans: float) -> Any:
        fut = asyncio.run_coroutine_threadsafe(coro, self._loop)
        try:
            return fut.result(timeout=tidsgrans)
        except TimeoutError:
            fut.cancel()
            raise RobotFel("roboten svarade inte i tid")
        except (asyncio.CancelledError,) as e:
            raise RobotFel(f"avbrutet: {e}")

    async def _anslut(self) -> None:
        if self._dev is not None and getattr(self._dev, "is_connected", False):
            return
        await self._stang()
        if ROBO_KATALOG not in sys.path:
            sys.path.insert(0, ROBO_KATALOG)
        try:
            import robo  # noqa: WPS433 – verktyg/roborock/robo.py (läs-verktyget, samma inloggning)
        except Exception as e:  # noqa: BLE001
            raise RobotFel(f"robo.py kunde inte laddas: {type(e).__name__}: {e}")
        try:
            self._dm, self._dev = await robo.anslut()
        except SystemExit as e:  # robo.anslut använder SystemExit för "ingen token"/"offline"
            raise RobotFel(str(e) or "roboten nås inte")
        except Exception as e:  # noqa: BLE001
            raise RobotFel(f"anslutning misslyckades: {type(e).__name__}: {e}")

    async def _stang(self) -> None:
        dm, self._dm, self._dev = self._dm, None, None
        if dm is not None:
            try:
                await dm.close()
            except Exception:  # noqa: BLE001
                pass

    async def _hamta_status(self) -> dict:
        await self._anslut()
        p = self._dev.v1_properties
        async with asyncio.timeout(KOMMANDO_TIDSGRANS):
            await p.status.refresh()
        s = p.status
        kod = _int(getattr(s, "state", None))
        fel = _int(getattr(s, "error_code", None))
        return {
            "hamtad": time.strftime("%Y-%m-%dT%H:%M:%S"),
            "namn": getattr(self._dev, "name", "Roborock"),
            "lokal": bool(getattr(self._dev, "is_local_connected", False)),
            "lage_kod": kod,
            "lage": LAGE.get(kod, f"Läge {kod}"),
            "kor": kod in KOR_LAGEN,
            "pausad": kod in PAUS_LAGEN,
            "batteri": _int(getattr(s, "battery", None)),
            "fel_kod": fel,
            "fel": (getattr(s, "error_code_name", None) or None) if fel else None,
            "stadtid_min": round((_int(getattr(s, "clean_time", 0)) or 0) / 60),
            "stadyta_m2": round((_int(getattr(s, "clean_area", 0)) or 0) / 1_000_000, 1),
        }

    async def _skicka(self, kommando, params: Any) -> Any:
        await self._anslut()
        async with asyncio.timeout(KOMMANDO_TIDSGRANS):
            return await self._dev.v1_properties.command.send(kommando, params=params)

    # ---------- publikt (trådsäkert) ----------
    def status(self, farsk: bool = False) -> dict:
        with self._lock:
            if not farsk and self._status and time.time() - self._status_tid < STATUS_CACHE_SEK:
                return self._status
            try:
                self._status = self._kor(self._hamta_status(), ANSLUT_TIDSGRANS + KOMMANDO_TIDSGRANS)
                self._status_tid = time.time()
                self.senaste_fel = None
                return self._status
            except RobotFel as e:
                self.senaste_fel = str(e)
                self._kor(self._stang(), 10)
                raise

    def kommando(self, namn: str, rum: list[int] | None = None) -> dict:
        """Skickar ETT fast kommando. `namn` måste finnas i KOMMANDON."""
        from roborock.roborock_typing import RoborockCommand as C

        KOMMANDON = {
            "start": (C.APP_START, None), "paus": (C.APP_PAUSE, None), "stopp": (C.APP_STOP, None), "docka": (C.APP_CHARGE, None),
        }
        if namn == "rum":
            kanda = {r["segment_id"] for r in las_rum()}
            valda = [int(x) for x in (rum or []) if isinstance(x, int) and x in kanda]
            if not valda or len(valda) != len(rum or []):
                raise ValueError("okända rum")
            kmd, params = C.APP_SEGMENT_CLEAN, [{"segments": valda, "repeat": 1}]
        elif namn in KOMMANDON:
            kmd, params = KOMMANDON[namn]
        else:
            raise ValueError("okänt robotkommando")
        with self._lock:
            try:
                svar = self._kor(self._skicka(kmd, params), ANSLUT_TIDSGRANS + KOMMANDO_TIDSGRANS)
                self._status_tid = 0  # nästa status läses färskt
                return {"ok": True, "svar": svar if isinstance(svar, (list, dict, str, int)) else str(svar)}
            except RobotFel as e:
                self.senaste_fel = str(e)
                self._kor(self._stang(), 10)
                raise


def _int(v: Any) -> int | None:
    if isinstance(v, bool):
        return int(v)
    if isinstance(v, int):
        return v
    if hasattr(v, "value"):
        try:
            return int(v.value)
        except (TypeError, ValueError):
            return None
    try:
        return int(v)
    except (TypeError, ValueError):
        return None


if __name__ == "__main__":  # snabbtest: python hem/robot.py  (bara status – rör inte roboten)
    if hasattr(sys.stdout, "reconfigure"):
        sys.stdout.reconfigure(encoding="utf-8")
    r = RobotStyr()
    print(json.dumps({"rum": las_rum(), "status": r.status(farsk=True)}, ensure_ascii=False, indent=2))

#!/usr/bin/env python3
"""Husvakten – SwitchBot Cloud API v1.1 (gratis, 10 000 anrop/dygn) med HMAC-signering på servern.

Token + secret hämtas i SwitchBot-appen: Profil → Inställningar → tryck 10× på "App Version" →
Developer Options. De läggs i ~/.husvakten/hem.json (UTANFÖR repot, se README) – aldrig i klienten.

    python hem/switchbot.py lista            # alla enheter (id, namn, typ) + IR-fjärrar
    python hem/switchbot.py lista --konfig   # föreslår "enheter"-poster att klistra in i hem.json
    python hem/switchbot.py status <id>      # läs status för en enhet (rör inget)

Modulen skickar BARA kommandon ur TILLATNA_KOMMANDON – inga fria strängar från klienten når API:t.
"""
from __future__ import annotations

import base64
import hashlib
import hmac
import json
import os
import sys
import time
import uuid
from urllib import error, request

BAS = "https://api.switch-bot.com/v1.1"
TIDSGRANS = 12
KONFIG = os.path.join(os.path.expanduser("~"), ".husvakten", "hem.json")

# Enda kommandon som någonsin skickas (SwitchBot "command"-typen). Klienten väljer ur enhetens
# konfigurerade delmängd av dessa; allt annat ger 400 i servern.
TILLATNA_KOMMANDON: frozenset[str] = frozenset({"press", "turnOn", "turnOff", "toggle"})
# Standardförslag per enhetstyp (för `lista --konfig`).
FORSLAG: dict[str, list[str]] = {
    "Bot": ["press"],
    "Plug": ["turnOn", "turnOff"], "Plug Mini (US)": ["turnOn", "turnOff"], "Plug Mini (JP)": ["turnOn", "turnOff"],
    "Color Bulb": ["turnOn", "turnOff"], "Strip Light": ["turnOn", "turnOff"], "Ceiling Light": ["turnOn", "turnOff"],
    "Ceiling Light Pro": ["turnOn", "turnOff"], "Relay Switch 1PM": ["turnOn", "turnOff"], "Relay Switch 1": ["turnOn", "turnOff"],
    "Curtain": ["turnOn", "turnOff"], "Curtain3": ["turnOn", "turnOff"], "Roller Shade": ["turnOn", "turnOff"],
}
IKON: dict[str, str] = {
    "Bot": "🔘", "Plug": "🔌", "Plug Mini (US)": "🔌", "Plug Mini (JP)": "🔌", "Color Bulb": "💡", "Strip Light": "💡",
    "Ceiling Light": "💡", "Ceiling Light Pro": "💡", "Curtain": "🪟", "Curtain3": "🪟", "Roller Shade": "🪟",
    "Projector": "📽️", "TV": "📺", "Light": "💡", "Air Conditioner": "❄️", "Fan": "🌀", "Speaker": "🔊", "Hub Mini": "📡",
}


class SwitchBotFel(RuntimeError):
    pass


def las_konfig() -> dict:
    try:
        with open(KONFIG, encoding="utf-8-sig") as fh:
            d = json.load(fh)
        return d if isinstance(d, dict) else {}
    except (OSError, json.JSONDecodeError):
        return {}


class SwitchBot:
    def __init__(self, token: str, secret: str):
        if not token or not secret:
            raise SwitchBotFel("SwitchBot är inte konfigurerad (token/secret saknas i ~/.husvakten/hem.json)")
        self._token = token.strip()
        self._secret = secret.strip().encode("utf-8")

    def _huvuden(self) -> dict[str, str]:
        t = str(int(time.time() * 1000))
        nonce = str(uuid.uuid4())
        sign = base64.b64encode(hmac.new(self._secret, (self._token + t + nonce).encode("utf-8"), hashlib.sha256).digest()).decode("ascii").upper()
        return {"Authorization": self._token, "sign": sign, "t": t, "nonce": nonce, "Content-Type": "application/json; charset=utf8"}

    def _anropa(self, vag: str, body: dict | None = None) -> dict:
        data = json.dumps(body).encode("utf-8") if body is not None else None
        req = request.Request(BAS + vag, data=data, headers=self._huvuden(), method="POST" if data else "GET")
        try:
            with request.urlopen(req, timeout=TIDSGRANS) as svar:
                d = json.loads(svar.read().decode("utf-8"))
        except error.HTTPError as e:
            raise SwitchBotFel(f"SwitchBot HTTP {e.code}") from None
        except (error.URLError, TimeoutError, OSError) as e:
            raise SwitchBotFel(f"SwitchBot nås inte: {getattr(e, 'reason', e)}") from None
        except ValueError:
            raise SwitchBotFel("SwitchBot svarade inte med JSON") from None
        if not isinstance(d, dict) or d.get("statusCode") not in (100, 0):
            raise SwitchBotFel(f"SwitchBot: {d.get('message', 'okänt fel') if isinstance(d, dict) else 'okänt svar'} ({d.get('statusCode') if isinstance(d, dict) else '?'})")
        return d.get("body") or {}

    def enheter(self) -> dict:
        """{"deviceList": [...], "infraredRemoteList": [...]}"""
        return self._anropa("/devices")

    def status(self, device_id: str) -> dict:
        return self._anropa(f"/devices/{_id(device_id)}/status")

    def kommando(self, device_id: str, kommando: str) -> dict:
        if kommando not in TILLATNA_KOMMANDON:
            raise ValueError(f"otillåtet SwitchBot-kommando: {kommando!r}")
        return self._anropa(f"/devices/{_id(device_id)}/commands", {"command": kommando, "parameter": "default", "commandType": "command"})


def _id(device_id: str) -> str:
    s = str(device_id or "").strip()
    if not s or len(s) > 64 or not all(c.isalnum() or c in "-_" for c in s):
        raise ValueError("ogiltigt enhets-id")
    return s


def fran_konfig(konfig: dict | None = None) -> SwitchBot | None:
    k = (konfig if konfig is not None else las_konfig()).get("switchbot") or {}
    if not k.get("token") or not k.get("secret"):
        return None
    return SwitchBot(k["token"], k["secret"])


def _slug(s: str) -> str:
    ut = "".join(c.lower() if c.isalnum() else "_" for c in s.strip()).strip("_")
    return ut or "enhet"


def main(argv: list[str]) -> int:
    if hasattr(sys.stdout, "reconfigure"):
        sys.stdout.reconfigure(encoding="utf-8")
    if not argv or argv[0] not in ("lista", "status"):
        print(__doc__)
        return 2
    sb = fran_konfig()
    if sb is None:
        print(f"SwitchBot är inte konfigurerad – lägg token och secret i {KONFIG} (se hem/README.md).")
        return 1
    if argv[0] == "status":
        if len(argv) < 2:
            print("ange enhets-id")
            return 2
        print(json.dumps(sb.status(argv[1]), ensure_ascii=False, indent=2))
        return 0
    d = sb.enheter()
    fysiska = d.get("deviceList") or []
    ir = d.get("infraredRemoteList") or []
    if "--konfig" in argv:
        poster = []
        for e in fysiska:
            typ = e.get("deviceType") or ""
            if typ in ("Hub Mini", "Hub 2", "Hub Plus", "Hub 3", "Meter", "MeterPlus", "Motion Sensor", "Contact Sensor", "Remote"):
                continue
            poster.append({"id": _slug(e.get("deviceName") or typ), "namn": e.get("deviceName") or typ, "ikon": IKON.get(typ, "🔘"),
                           "typ": "switchbot", "deviceId": e.get("deviceId"), "deviceType": typ,
                           "kommandon": FORSLAG.get(typ, ["turnOn", "turnOff"]), "grupp": "Enheter", "status": typ != "Bot"})
        for e in ir:
            typ = e.get("remoteType") or "IR"
            poster.append({"id": _slug(e.get("deviceName") or typ), "namn": e.get("deviceName") or typ, "ikon": IKON.get(typ, "📡"),
                           "typ": "switchbot", "deviceId": e.get("deviceId"), "deviceType": "IR " + typ,
                           "kommandon": ["turnOn", "turnOff"], "grupp": "Fjärrar", "status": False})
        print(json.dumps({"enheter": poster}, ensure_ascii=False, indent=2))
        return 0
    print(f"{len(fysiska)} enheter, {len(ir)} IR-fjärrar")
    for e in fysiska:
        print(f"  {e.get('deviceId')}  {e.get('deviceType'):<18} {e.get('deviceName')}  hub={e.get('hubDeviceId') or '-'}")
    for e in ir:
        print(f"  {e.get('deviceId')}  IR {e.get('remoteType'):<15} {e.get('deviceName')}")
    return 0


if __name__ == "__main__":
    try:
        sys.exit(main(sys.argv[1:]))
    except (SwitchBotFel, ValueError) as fel:
        print(f"FEL: {fel}")
        sys.exit(1)

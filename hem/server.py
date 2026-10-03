#!/usr/bin/env python3
"""Husvakten – hemservern: iPadens styrknappar (lampor, projektor, Roborock) via en LOKAL server.

Lyssnar ENBART på http://127.0.0.1:5193/ och nås utifrån bara via Tailscale
(tailscale serve --bg --set-path /hem http://127.0.0.1:5193 → https://<dator>.ts.net/hem, tailnet only,
ALDRIG Funnel). Speglar spelkontroll/server.py (samma inloggning, whitelist, vakt, VBS-start).

Serverar också Husvaktens statiska sida (index.html, css/, js/, data/valv/) så att hela appen kan öppnas
på https://<dator>.ts.net/hem/ med samma origin. GitHub Pages-sidan (https://marcdshark666.github.io)
får anropa API:t cross-origin (CORS, bara den originen + servern själv). Inget annat origin släpps in.

Inloggning: samma e-post + lösenord som Husvakten (hashfilen manadsavrakning/data/inloggning.json, skapas
ALDRIG här). Sessionen är en bearer-token (Authorization: Bearer …) – ingen kaka, så Safari på iPaden
fungerar cross-site. Sessioner (30 dagar) i hem/data/sessioner.json. 5 fel/15 min per IP → 429.
Datorn själv (127.0.0.1 utan proxyhuvuden) slipper inloggning, som Spelkontroll.

Åtgärder (POST /api/atgard, FAST whitelist – ingen text ur förfrågan körs som kommando):
  robot_start | robot_paus | robot_stopp | robot_docka | robot_rum {"rum":[segment-id…]}
  enhet {"id": "<ur hem.json>", "kommando": "press|turnOn|turnOff|toggle"}   (SwitchBot Cloud API v1.1)
  scen  {"id": "<ur hem.json>"}                                             (fasta steg ur hem.json)
Rate-limit: 20 åtgärder/min per session, 3 s per enhet (8 s för Bot-tryck). Revisionslogg hem/data/atgarder.log.

Hemligheter (SwitchBot token/secret, enhets-id:n) ligger ENBART i ~/.husvakten/hem.json – aldrig i repot.

  GET  /api/halsa     {"ok": true} (öppen, för vakten)      POST /api/logga-in {"epost","losen"} → {"token"}
  GET  /api/status    robot + enheter + scener (inloggad)   POST /api/logga-ut
  GET  /api/logg      senaste åtgärderna (inloggad)         POST /api/atgard   {"atgard": …}
Körs:  python -X utf8 server.py   (vakten: vakt\\server_vakt.ps1, schemalagd som Husvakten-Hem-Server)
"""
from __future__ import annotations

import hashlib
import hmac
import json
import mimetypes
import os
import re
import secrets
import sys
import threading
import time
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer
from urllib.parse import urlsplit

try:
    import fonster
except ImportError:
    try:
        from hem import fonster
    except ImportError:
        fonster = None

import subprocess

TANGENT_KNAPPAR = {
    "windows": ("win",),
    "windows_tab": ("win", "tab"),
    "vanster": ("left",),
    "hoger": ("right",),
    "upp": ("up",),
    "ner": ("down",),
    "enter": ("enter",),
}



HAR = os.path.dirname(os.path.abspath(__file__))
ROT = os.path.dirname(HAR)  # husvakten/ (repot)
DATA = os.path.join(HAR, "data")  # gitignorerad
PORT = int(os.environ.get("HEM_PORT", "5193"))
BIND = "127.0.0.1"  # avsiktligt fast: utåt bara via Tailscale (WebCrypto kräver ändå https)
PREFIX = "/hem"
GITHUB_ORIGIN = "https://marcdshark666.github.io"
KONFIG = os.path.join(os.path.expanduser("~"), ".husvakten", "hem.json")
INLOGG = os.path.join(os.path.dirname(ROT), "manadsavrakning", "data", "inloggning.json")
SESSIONER = os.path.join(DATA, "sessioner.json")
ATGARDSLOGG = os.path.join(DATA, "atgarder.log")
SESSION_SEK = 30 * 24 * 3600
SPARR_FONSTER = 15 * 60
SPARR_MAX = 5
ATGARD_PER_MIN = 20
ENHET_PAUS_SEK = 3.0
BOT_PAUS_SEK = 8.0
SB_STATUS_CACHE_SEK = 45
PROXYHUVUDEN = ("X-Forwarded-For", "X-Forwarded-Host", "X-Forwarded-Proto", "X-Real-IP", "Forwarded", "Tailscale-User-Login")
AUTH_LOCK = threading.Lock()
ATGARD_LOCK = threading.Lock()
_fel: dict[str, list[float]] = {}
_atgarder: dict[str, list[float]] = {}
_enhet_senast: dict[str, float] = {}
_sb_cache: dict[str, tuple[float, dict | None]] = {}
ID_RE = re.compile(r"^[a-z0-9_-]{1,40}$")

sys.path.insert(0, HAR)
import switchbot as sbmod  # noqa: E402
from robot import RobotStyr, RobotFel, las_rum  # noqa: E402

ROBOT: RobotStyr | None = None
ROBOT_FEL: str | None = None


# ---------------------------------------------------------------- konfiguration (~/.husvakten/hem.json)
def las_konfig() -> dict:
    k = sbmod.las_konfig()
    enheter = []
    for e in k.get("enheter") or []:
        if not isinstance(e, dict) or not ID_RE.match(str(e.get("id") or "")) or e.get("typ") != "switchbot":
            continue
        kmd = [c for c in (e.get("kommandon") or []) if c in sbmod.TILLATNA_KOMMANDON]
        if not e.get("deviceId") or not kmd:
            continue
        enheter.append({"id": e["id"], "namn": str(e.get("namn") or e["id"])[:40], "ikon": str(e.get("ikon") or "🔘")[:4],
                        "grupp": str(e.get("grupp") or "Enheter")[:30], "deviceId": str(e["deviceId"]), "deviceType": str(e.get("deviceType") or "")[:30],
                        "kommandon": kmd, "status": bool(e.get("status", False))})
    ids = {e["id"] for e in enheter}
    scener = []
    for s in k.get("scener") or []:
        if not isinstance(s, dict) or not ID_RE.match(str(s.get("id") or "")):
            continue
        steg = [st for st in (s.get("steg") or []) if isinstance(st, dict) and st.get("enhet") in ids and st.get("kommando") in sbmod.TILLATNA_KOMMANDON]
        if steg:
            scener.append({"id": s["id"], "namn": str(s.get("namn") or s["id"])[:40], "ikon": str(s.get("ikon") or "🎬")[:4], "steg": steg[:12]})
    rumnamn = {str(a): str(b)[:30] for a, b in (k.get("rum") or {}).items()} if isinstance(k.get("rum"), dict) else {}
    return {"switchbot": bool((k.get("switchbot") or {}).get("token") and (k.get("switchbot") or {}).get("secret")),
            "sb": k.get("switchbot") or {}, "enheter": enheter, "scener": scener, "rum": rumnamn, "lampor_info": str(k.get("lampor_info") or "")[:200]}


def publik_konfig(k: dict) -> dict:
    """Det klienten får se: inga token, inga deviceId."""
    return {"switchbot": k["switchbot"], "lampor_info": k["lampor_info"],
            "enheter": [{kk: v for kk, v in e.items() if kk not in ("deviceId",)} for e in k["enheter"]],
            "scener": [{"id": s["id"], "namn": s["namn"], "ikon": s["ikon"], "steg": len(s["steg"])} for s in k["scener"]]}


# ---------------------------------------------------------------- inloggning (kopia från spelkontroll/server.py)
def las_inlogg() -> dict | None:
    try:
        with open(INLOGG, encoding="utf-8") as fh:
            d = json.load(fh)
        return d if d.get("losen_hash") and d.get("epost_hash") else None
    except (OSError, json.JSONDecodeError, AttributeError):
        return None


def _pbkdf2(varde: str, salt_hex: str, it: int) -> bytes:
    return hashlib.pbkdf2_hmac("sha256", varde.encode("utf-8"), bytes.fromhex(salt_hex), it)


def kontrollera(epost: str, losen: str) -> bool:
    d = las_inlogg()
    if not d:
        return False
    it = int(d.get("iterationer") or 310_000)
    ok_e = hmac.compare_digest(_pbkdf2(epost.strip().lower(), d["epost_salt"], it), bytes.fromhex(d["epost_hash"]))
    ok_l = hmac.compare_digest(_pbkdf2(losen, d["losen_salt"], it), bytes.fromhex(d["losen_hash"]))
    return ok_e and ok_l


def _th(token: str) -> str:
    return hashlib.sha256(token.encode("utf-8")).hexdigest()


def _las_sessioner() -> dict:
    try:
        with open(SESSIONER, encoding="utf-8") as fh:
            d = json.load(fh)
        return d if isinstance(d, dict) else {}
    except (OSError, json.JSONDecodeError):
        return {}


def _skriv_sessioner(d: dict) -> None:
    nu = time.time()
    d = {k: v for k, v in d.items() if isinstance(v, (int, float)) and v > nu}
    os.makedirs(DATA, exist_ok=True)
    tmp = SESSIONER + ".tmp"
    with open(tmp, "w", encoding="utf-8") as fh:
        json.dump(d, fh)
    os.replace(tmp, SESSIONER)


def ny_session() -> str:
    token = secrets.token_urlsafe(32)
    with AUTH_LOCK:
        d = _las_sessioner()
        d[_th(token)] = time.time() + SESSION_SEK
        _skriv_sessioner(d)
    return token


def giltig_session(token: str | None) -> bool:
    if not token or len(token) > 200:
        return False
    with AUTH_LOCK:
        utgar = _las_sessioner().get(_th(token))
    return isinstance(utgar, (int, float)) and utgar > time.time()


def ta_bort_session(token: str | None) -> None:
    if not token:
        return
    with AUTH_LOCK:
        d = _las_sessioner()
        if d.pop(_th(token), None) is not None:
            _skriv_sessioner(d)


def sparrad(ip: str) -> bool:
    nu = time.time()
    with AUTH_LOCK:
        lista = [t for t in _fel.get(ip, []) if nu - t < SPARR_FONSTER]
        _fel[ip] = lista
        return len(lista) >= SPARR_MAX


def notera_fel(ip: str) -> None:
    with AUTH_LOCK:
        _fel.setdefault(ip, []).append(time.time())


def for_manga_atgarder(identitet: str) -> bool:
    nu = time.time()
    with AUTH_LOCK:
        lista = [t for t in _atgarder.get(identitet, []) if nu - t < 60]
        if len(lista) >= ATGARD_PER_MIN:
            _atgarder[identitet] = lista
            return True
        lista.append(nu)
        _atgarder[identitet] = lista
        return False


def logga_atgard(ip: str, text: str) -> None:
    """Revisionslogg – aldrig hemligheter, bara vad som gjordes."""
    try:
        os.makedirs(DATA, exist_ok=True)
        with open(ATGARDSLOGG, "a", encoding="utf-8") as fh:
            fh.write(f"{time.strftime('%Y-%m-%d %H:%M:%S')} {ip} {text}\n")
    except OSError:
        pass
    sys.stderr.write(f"atgard {ip} {text}\n")


def las_logg(n: int = 30) -> list[str]:
    try:
        with open(ATGARDSLOGG, encoding="utf-8") as fh:
            rader = fh.read().splitlines()
    except OSError:
        return []
    return [r[:200] for r in rader[-n:]][::-1]


# ---------------------------------------------------------------- enheter (SwitchBot) och robot
def sb_status(sb: sbmod.SwitchBot, enhet: dict, farsk: bool = False) -> dict | None:
    """Status för en enhet, cachad (API-kvoten är 10 000/dygn). None = okänd."""
    nu = time.time()
    tid, varde = _sb_cache.get(enhet["id"], (0.0, None))
    if not farsk and nu - tid < SB_STATUS_CACHE_SEK:
        return varde
    try:
        s = sb.status(enhet["deviceId"])
        varde = {k: s.get(k) for k in ("power", "brightness", "color", "battery", "slidePosition", "moving", "deviceMode") if k in s}
    except (sbmod.SwitchBotFel, ValueError) as e:
        varde = {"fel": str(e)[:120]}
    _sb_cache[enhet["id"]] = (nu, varde)
    return varde


def status(konfig: dict, farsk: bool) -> dict:
    ut: dict = {"tid": time.strftime("%Y-%m-%dT%H:%M:%S"), "konfig": publik_konfig(konfig)}
    # Robot (läsning, rör den aldrig)
    rum = [{"segment_id": r["segment_id"], "namn": konfig["rum"].get(str(r["segment_id"])) or r["namn"] or f"Rum {r['segment_id']}"} for r in las_rum()]
    if ROBOT is None:
        ut["robot"] = {"tillganglig": False, "fel": ROBOT_FEL or "robotmodulen kunde inte startas", "rum": rum}
    else:
        try:
            ut["robot"] = {"tillganglig": True, "rum": rum, **ROBOT.status(farsk)}
        except (RobotFel, Exception) as e:  # noqa: BLE001
            ut["robot"] = {"tillganglig": False, "fel": str(e)[:200], "rum": rum}
    # SwitchBot-enheter
    sb = sbmod.fran_konfig(konfig={"switchbot": konfig["sb"]}) if konfig["switchbot"] else None
    tillstand = {}
    if sb is not None:
        for e in konfig["enheter"]:
            if e["status"]:
                tillstand[e["id"]] = sb_status(sb, e, farsk)
    ut["enheter"] = tillstand
    return ut


def atgard(namn: str, data: dict, konfig: dict) -> dict:
    """FAST whitelist. ValueError → 400, RuntimeError → 500."""
    if namn in ("robot_start", "robot_paus", "robot_stopp", "robot_docka", "robot_rum"):
        if ROBOT is None:
            raise RuntimeError(ROBOT_FEL or "robotmodulen är inte igång")
        kmd = namn[len("robot_"):]
        rum = data.get("rum") if kmd == "rum" else None
        if kmd == "rum" and (not isinstance(rum, list) or len(rum) > 20):
            raise ValueError("rum måste vara en lista")
        try:
            res = ROBOT.kommando(kmd, rum)
        except RobotFel as e:
            raise RuntimeError(str(e))
        text = {"start": "städning startad", "paus": "pausad", "stopp": "stoppad", "docka": "på väg till dockan", "rum": f"städar rum {rum}"}[kmd]
        return {"ok": True, "text": "🤖 " + text, "svar": res.get("svar")}
    
    if namn == "dator_tangent":
        knapp = str(data.get("knapp") or "")
        if knapp not in TANGENT_KNAPPAR:
            raise ValueError("okand tangent")
        if fonster:
            fonster.tryck(*TANGENT_KNAPPAR[knapp])
        return {"ok": True, "text": f"Skickade tangent: {knapp}"}
    if namn == "dator_app":
        app = str(data.get("app") or "")
        kmd = {
            "claude": r'start cmd /k "C:\Users\PC\.local\bin\claude.exe"',
            "codex": r'start cmd /k "codex exec"',
            "antigravity": r'start cmd /k "C:\Users\PC\.gemini\antigravity\bin\agentapi.bat"'
        }.get(app)
        if not kmd:
            raise ValueError("okand app")
        subprocess.Popen(kmd, shell=True)
        return {"ok": True, "text": f"Startade app: {app}"}
    if namn == "dator_meddelande":
        text = str(data.get("meddelande") or "").strip()
        if not text:
            raise ValueError("tomt meddelande")
        meddelandelogg = os.path.join(DATA, "meddelanden.log")
        with open(meddelandelogg, "a", encoding="utf-8") as fh:
            fh.write(f"{time.strftime('%Y-%m-%dT%H:%M:%S')} {text}\n")
        return {"ok": True, "text": f"Mottog meddelande: {text}"}

    if namn == "enhet":
        enhet = _enhet(konfig, data.get("id"))
        kommando = str(data.get("kommando") or "")
        if kommando not in enhet["kommandon"]:
            raise ValueError("kommandot är inte tillåtet för enheten")
        _kor_enhet(konfig, enhet, kommando)
        return {"ok": True, "text": f"{enhet['ikon']} {enhet['namn']}: {KOMMANDOTEXT.get(kommando, kommando)}"}
    if namn == "scen":
        sid = str(data.get("id") or "")
        scen = next((s for s in konfig["scener"] if s["id"] == sid), None)
        if scen is None:
            raise ValueError("okänd scen")
        gjort, fel = [], []
        for st in scen["steg"]:
            enhet = _enhet(konfig, st["enhet"])
            try:
                if st["kommando"] not in enhet["kommandon"]:
                    raise ValueError("kommandot är inte tillåtet för enheten")
                _kor_enhet(konfig, enhet, st["kommando"], vanta=True)
                gjort.append(enhet["namn"])
            except (ValueError, RuntimeError) as e:
                fel.append(f"{enhet['namn']}: {e}")
        if fel and not gjort:
            raise RuntimeError("; ".join(fel)[:300])
        return {"ok": True, "text": f"{scen['ikon']} {scen['namn']}: {', '.join(gjort)}" + (f" (fel: {'; '.join(fel)})" if fel else "")}
    raise ValueError("okänd åtgärd")


KOMMANDOTEXT = {"press": "tryckt", "turnOn": "på", "turnOff": "av", "toggle": "växlad"}


def _enhet(konfig: dict, eid) -> dict:
    e = next((x for x in konfig["enheter"] if x["id"] == eid), None) if isinstance(eid, str) else None
    if e is None:
        raise ValueError("okänd enhet")
    return e


def _kor_enhet(konfig: dict, enhet: dict, kommando: str, vanta: bool = False) -> None:
    sb = sbmod.fran_konfig(konfig={"switchbot": konfig["sb"]}) if konfig["switchbot"] else None
    if sb is None:
        raise RuntimeError("SwitchBot är inte konfigurerad (token/secret i ~/.husvakten/hem.json)")
    paus = BOT_PAUS_SEK if enhet["deviceType"] == "Bot" else ENHET_PAUS_SEK
    sedan = time.time() - _enhet_senast.get(enhet["id"], 0.0)
    if sedan < paus:
        if not vanta:
            raise ValueError(f"vänta {paus - sedan:.0f} s innan {enhet['namn']} styrs igen")
        time.sleep(paus - sedan)
    try:
        sb.kommando(enhet["deviceId"], kommando)
    except sbmod.SwitchBotFel as e:
        raise RuntimeError(str(e))
    _enhet_senast[enhet["id"]] = time.time()
    _sb_cache.pop(enhet["id"], None)


# ---------------------------------------------------------------- statiska filer (Husvaktens sida)
STATISKA_RE = re.compile(r"^/(index\.html|robots\.txt|css/[\w.-]+\.css|js/[\w.-]+\.js|data/valv/(?:[\w.-]+/)*[\w.-]+\.(?:json|enc))$")


def statisk_fil(vag: str) -> tuple[bytes, str] | None:
    if vag == "/":
        vag = "/index.html"
    if not STATISKA_RE.match(vag) or ".." in vag:
        return None
    full = os.path.normpath(os.path.join(ROT, vag.lstrip("/")))
    if not full.startswith(ROT + os.sep) or not os.path.isfile(full):
        return None
    with open(full, "rb") as fh:
        body = fh.read()
    typ = "application/octet-stream" if full.endswith(".enc") else (mimetypes.guess_type(full)[0] or "application/octet-stream")
    if typ.startswith("text/") or typ in ("application/javascript", "application/json"):
        typ += "; charset=utf-8"
    return body, typ


# ---------------------------------------------------------------- HTTP
class Hanterare(BaseHTTPRequestHandler):
    protocol_version = "HTTP/1.1"
    server_version = "HusvaktenHem/1.0"
    sys_version = ""

    def log_message(self, fmt, *args):
        forsta = str(args[0]) if args else ""  # send_error skickar en HTTPStatus, inte en sträng
        if "/api/status" in forsta or "/api/halsa" in forsta:
            return
        sys.stderr.write("%s - %s\n" % (self.address_string(), fmt % args))

    # ------------------------------------------------------------ hjälpare
    def _proxad(self) -> bool:
        return any(self.headers.get(h) for h in PROXYHUVUDEN)

    def _ar_lokal(self) -> bool:
        return self.client_address[0] in ("127.0.0.1", "::1") and not self._proxad()

    def _klient_ip(self) -> str:
        xff = (self.headers.get("X-Forwarded-For") or "").split(",")[0].strip()
        return xff[:64] or self.client_address[0]

    def _https(self) -> bool:
        if (self.headers.get("X-Forwarded-Proto") or "").lower() == "https":
            return True
        return (self.headers.get("Host") or "").split(":")[0].lower().endswith(".ts.net")

    def _vag(self) -> tuple[str, str]:
        vag = urlsplit(self.path).path or "/"
        if vag == PREFIX or vag.startswith(PREFIX + "/"):
            return (vag[len(PREFIX):] or "/"), PREFIX
        return vag, (PREFIX if self._proxad() else "")

    def _eget_origin(self) -> str:
        vard = (self.headers.get("X-Forwarded-Host") or self.headers.get("Host") or "").split(",")[0].strip().lower()
        return ("https://" if self._https() else "http://") + vard

    def _origin_ok(self) -> bool:
        """Origin saknas (curl, samma-origin GET utan CORS) eller är GitHub-sidan / servern själv."""
        origin = (self.headers.get("Origin") or "").strip().lower()
        if not origin:
            return True
        return origin in (GITHUB_ORIGIN, self._eget_origin())  # "null" och allt annat nekas

    def _cors(self) -> list[tuple[str, str]]:
        origin = (self.headers.get("Origin") or "").strip()
        if origin and origin.lower() in (GITHUB_ORIGIN, self._eget_origin()):
            return [("Access-Control-Allow-Origin", origin), ("Vary", "Origin"),
                    ("Access-Control-Allow-Headers", "Authorization, Content-Type"),
                    ("Access-Control-Allow-Methods", "GET, POST, OPTIONS"), ("Access-Control-Max-Age", "600"),
                    # Chrome Private Network Access: GitHub-sidan (publik) anropar en tailnet-adress (privat).
                    # Nyare Chrome (Local Network Access) kräver dessutom att användaren godkänner i en ruta;
                    # iPad-Safari frågar inte. Enklast: öppna https://<dator>.ts.net/hem/ direkt (samma origin).
                    ("Access-Control-Allow-Private-Network", "true")]
        return []

    def _token(self) -> str | None:
        a = self.headers.get("Authorization") or ""
        if a.startswith("Bearer ") and len(a) < 300:
            return a[7:].strip() or None
        return None

    def _skicka(self, kod: int, body: bytes, ctype: str, extra: list | None = None) -> None:
        self.send_response(kod)
        self.send_header("Content-Type", ctype)
        self.send_header("Cache-Control", "no-store")
        self.send_header("X-Content-Type-Options", "nosniff")
        self.send_header("X-Frame-Options", "DENY")
        self.send_header("Referrer-Policy", "no-referrer")
        self.send_header("Content-Length", str(len(body)))
        for k, v in (extra or []) + self._cors():
            self.send_header(k, v)
        self.end_headers()
        if self.command != "HEAD":
            self.wfile.write(body)

    def _json(self, kod: int, obj) -> None:
        self._skicka(kod, json.dumps(obj, ensure_ascii=False).encode("utf-8"), "application/json; charset=utf-8")

    def _identitet(self) -> str:
        return "lokal" if self._ar_lokal() else _th(self._token() or "")

    def _las_json(self, max_byte: int = 20_000) -> dict:
        n = int(self.headers.get("Content-Length") or 0)
        if n > max_byte:
            raise ValueError("för stort")
        d = json.loads(self.rfile.read(n).decode("utf-8") or "{}")
        if not isinstance(d, dict):
            raise ValueError("fel format")
        return d

    def _inloggad(self) -> bool:
        return self._ar_lokal() or giltig_session(self._token())

    # ------------------------------------------------------------ metoder
    def do_OPTIONS(self):
        if not self._origin_ok():
            return self._skicka(403, b"", "text/plain; charset=utf-8")
        self._skicka(204, b"", "text/plain; charset=utf-8")

    def do_HEAD(self):
        self.do_GET()

    def do_GET(self):
        vag, prefix = self._vag()
        if vag == "/api/halsa":
            return self._json(200, {"ok": True})
        if vag.startswith("/api/"):
            if not self._origin_ok():
                return self._json(403, {"fel": "origin"})
            if not self._inloggad():
                return self._json(401, {"fel": "inloggning krävs"})
            if vag == "/api/status":
                farsk = "farsk=1" in (urlsplit(self.path).query or "")
                try:
                    return self._json(200, status(las_konfig(), farsk))
                except Exception as e:  # noqa: BLE001
                    return self._json(500, {"fel": str(e)[:300]})
            if vag == "/api/logg":
                return self._json(200, {"rader": las_logg()})
            return self._json(404, {"fel": "okänd väg"})
        fil = statisk_fil(vag)
        if fil is None:
            return self._skicka(404, b"404", "text/plain; charset=utf-8")
        return self._skicka(200, fil[0], fil[1])

    def do_POST(self):
        vag, prefix = self._vag()
        if not vag.startswith("/api/"):
            return self._json(404, {"fel": "okänd väg"})
        if not self._origin_ok():
            return self._json(403, {"fel": "origin"})
        ip = self._klient_ip()
        if vag == "/api/logga-in":
            if sparrad(ip):
                sys.stderr.write(f"inloggning SPARRAD {ip}\n")
                return self._json(429, {"fel": "För många felaktiga försök. Vänta 15 minuter."})
            try:
                d = self._las_json(10_000)
            except (ValueError, OSError):
                return self._json(400, {"fel": "ogiltig JSON"})
            epost = str(d.get("epost") or "")[:200]
            losen = str(d.get("losen") or "")[:500]
            if not kontrollera(epost, losen):
                notera_fel(ip)
                sys.stderr.write(f"inloggning NEKAD {ip}\n")
                return self._json(401, {"fel": "Fel e-post eller lösenord."})
            with AUTH_LOCK:
                _fel.pop(ip, None)
            sys.stderr.write(f"inloggning OK {ip}\n")
            return self._json(200, {"token": ny_session(), "giltig_sek": SESSION_SEK})
        if vag == "/api/logga-ut":
            ta_bort_session(self._token())
            return self._json(200, {"ok": True})
        if not self._inloggad():
            return self._json(401, {"fel": "inloggning krävs"})
        if vag != "/api/atgard":
            return self._json(404, {"fel": "okänd väg"})
        try:
            data = self._las_json()
            namn = str(data.get("atgard") or "")[:40]
        except (ValueError, OSError):
            return self._json(400, {"fel": "ogiltig JSON"})
        if for_manga_atgarder(self._identitet()):
            logga_atgard(ip, f"{namn} NEKAD (för många åtgärder)")
            return self._json(429, {"fel": "För många knapptryck – vänta en minut."})
        try:
            with ATGARD_LOCK:
                res = atgard(namn, data, las_konfig())
            logga_atgard(ip, f"{namn} {json.dumps({k: v for k, v in data.items() if k != 'atgard'}, ensure_ascii=False)[:200]} -> {res.get('text', '')[:160]}")
            return self._json(200, res)
        except ValueError as e:
            logga_atgard(ip, f"{namn} AVVISAD {e}")
            return self._json(400, {"fel": str(e)[:200]})
        except (RuntimeError, OSError) as e:
            logga_atgard(ip, f"{namn} FEL {e}")
            return self._json(500, {"fel": str(e)[:300]})


def main() -> int:
    global ROBOT, ROBOT_FEL
    os.makedirs(DATA, exist_ok=True)
    if not las_inlogg():
        sys.stderr.write(f"VARNING: {INLOGG} saknas eller är tom - ingen kommer in utifrån\n")
    try:
        ROBOT = RobotStyr()
    except Exception as e:  # noqa: BLE001
        ROBOT_FEL = f"{type(e).__name__}: {e}"
        sys.stderr.write(f"VARNING: robotmodulen startade inte: {ROBOT_FEL}\n")
    k = las_konfig()
    sys.stderr.write(f"Husvakten hem: http://{BIND}:{PORT}{PREFIX}  switchbot={'ja' if k['switchbot'] else 'nej'} enheter={len(k['enheter'])} scener={len(k['scener'])}\n")
    srv = ThreadingHTTPServer((BIND, PORT), Hanterare)
    srv.daemon_threads = True
    try:
        srv.serve_forever()
    except KeyboardInterrupt:
        pass
    return 0


if __name__ == "__main__":
    sys.exit(main())

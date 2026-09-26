"""Husvakten – automatisk robotsynk (körs av Schemalagd uppgift "Husvakten Robotsynk").

1. Läser roboten (bara läskommandon, samma som `robo.py publicera`) och bygger robot.json utanför repot.
2. Jämför en hash av innehållet UTAN tidsstämplar med förra publiceringen (~/.roborock/synk-state.json).
3. Bara om något faktiskt ändrats OCH senaste robotcommit är minst 60 min gammal:
   git pull --rebase --autostash → kryptera in i data/valv/robot/ → commit (bara robotfilerna) → push.

Loggar till ~/.roborock/synk.log. Fel loggas och skriptet avslutar ALLTID med 0 så schemat aldrig hänger.
Körs med pythonw.exe (inget fönster); alla barnprocesser startas med CREATE_NO_WINDOW.
    python verktyg/roborock/synka.py            # vanlig körning
    python verktyg/roborock/synka.py --tvinga   # publicera även om inget ändrats / timmen inte gått
"""
from __future__ import annotations

import asyncio
import contextlib
import io
import json
import logging
import os
import pathlib
import subprocess
import sys
import time
import traceback

HAR = pathlib.Path(__file__).resolve().parent
ROT = HAR.parents[1]
HEM = pathlib.Path.home() / ".roborock"
LOGG = HEM / "synk.log"
TILLSTAND = HEM / "synk-state.json"
LAS = HEM / "synk.lock"
MIN_MELLAN_COMMITS_S = 3600
LAS_GAMMALT_S = 20 * 60
DOLT = subprocess.CREATE_NO_WINDOW if sys.platform == "win32" else 0
MEDDELANDE = ("Husvakten: robotdata synkad\n\n"
              "Co-Authored-By: Claude Opus 5.5 (1M context) <noreply@anthropic.com>")


def logg(text: str) -> None:
    HEM.mkdir(parents=True, exist_ok=True)
    try:
        if LOGG.exists() and LOGG.stat().st_size > 1_000_000:  # enkel rotation
            LOGG.replace(LOGG.with_suffix(".log.1"))
        with LOGG.open("a", encoding="utf-8") as f:
            f.write(time.strftime("%Y-%m-%d %H:%M:%S ") + text.rstrip() + "\n")
    except OSError:
        pass  # loggen får aldrig stoppa synken


def git(*args: str, kontroll: bool = True) -> str:
    r = subprocess.run(["git", *args], cwd=ROT, capture_output=True, text=True, encoding="utf-8",
                       errors="replace", creationflags=DOLT, timeout=180)
    if kontroll and r.returncode != 0:
        raise RuntimeError(f"git {' '.join(args)}: {(r.stderr or r.stdout).strip()[:400]}")
    return r.stdout.strip()


def las_tillstand() -> dict:
    try:
        return json.loads(TILLSTAND.read_text(encoding="utf-8"))
    except (OSError, ValueError):
        return {}


@contextlib.contextmanager
def las_fil():
    """Hindra två samtidiga synkar (ett lås äldre än 20 min räknas som kvarlämnat)."""
    if LAS.exists() and time.time() - LAS.stat().st_mtime < LAS_GAMMALT_S:
        raise RuntimeError("en annan synk kör redan (synk.lock)")
    LAS.write_text(str(os.getpid()), encoding="utf-8")
    try:
        yield
    finally:
        with contextlib.suppress(OSError):
            LAS.unlink()


def hamta() -> None:
    import robo  # noqa: E402 – ligger i samma mapp

    if sys.platform == "win32":
        asyncio.set_event_loop_policy(asyncio.WindowsSelectorEventLoopPolicy())
    utdata = io.StringIO()
    with contextlib.redirect_stdout(utdata):
        kod = asyncio.run(robo.main("alla"))  # bara läskommandon
    if kod:
        raise RuntimeError(f"robo.py alla gav slutkod {kod}")


def starta_live_om_aktiv(live) -> str:
    """Roboten igång (enligt nyss hämtade status.json) → starta livebevakaren (Vaktloggen) i bakgrunden."""
    try:
        st = (json.loads((HEM / "data" / "status.json").read_text(encoding="utf-8")) or {}).get("status") or {}
    except (OSError, ValueError):
        return ""
    if not live.ar_aktiv(st):
        return ""
    return " · livebevakaren startad" if live.starta_bakgrund() else " · livebevakaren kör redan"


def synka(tvinga: bool) -> str:
    sys.path.insert(0, str(HAR))
    import live  # noqa: E402
    import publicera  # noqa: E402

    if live.kor_redan() and not tvinga:  # färre robotanrop – live.py publicerar själv när körningen är klar
        return "livebevakaren kör – hoppar över synken"
    hamta()
    startad = starta_live_om_aktiv(live)
    return _synka(tvinga, publicera, live) + startad


def _synka(tvinga: bool, publicera, live) -> str:
    info = publicera.bygg()
    ny = publicera.innehallshash()
    tillst = las_tillstand()
    if ny == tillst.get("hash") and not tvinga:
        return "oförändrat – ingen commit"
    senast = git("log", "-1", "--format=%ct", "--", "data/valv/robot", kontroll=False)
    sedan = time.time() - int(senast) if senast.isdigit() else 1e9
    if sedan < MIN_MELLAN_COMMITS_S and not tvinga:
        return f"ändrat, men senaste robotcommit är bara {round(sedan / 60)} min gammal – väntar"

    with live.git_las():
        return _publicera(info, ny, publicera)


def _publicera(info: dict, ny: str, publicera) -> str:
    git("pull", "--rebase", "--autostash")
    utdata = io.StringIO()
    with contextlib.redirect_stdout(utdata):
        publicera.kryptera_in(info)
    git("add", "data/valv/robot")
    # Säkerhetsspärr: bara krypterade filer under data/valv/robot/ får följa med.
    staged = [f for f in git("diff", "--cached", "--name-only", "--", "data/valv/robot").splitlines() if f]
    fel = [f for f in staged if not f.endswith(".enc")]
    if fel:
        git("reset", "-q", "--", "data/valv/robot", kontroll=False)
        raise RuntimeError(f"vägrar commita okrypterade filer: {fel}")
    if not staged:
        TILLSTAND.write_text(json.dumps({"hash": ny, "tid": time.time()}), encoding="utf-8")
        return "inga filändringar att commita"
    git("commit", "-q", "-m", MEDDELANDE, "--", "data/valv/robot")
    try:
        git("push", "-q")
    except RuntimeError:
        git("pull", "--rebase", "--autostash")
        git("push", "-q")
    hashen = git("rev-parse", "--short", "HEAD")
    TILLSTAND.write_text(json.dumps({"hash": ny, "tid": time.time(), "commit": hashen}), encoding="utf-8")
    return f"publicerat och pushat {hashen} ({len(staged)} filer, {info.get('json_kb')} kB json)"


def main() -> int:
    logging.basicConfig(level=logging.ERROR, stream=io.StringIO())  # robo-varningar ska inte skriva någonstans
    t0 = time.time()
    try:
        with las_fil():
            resultat = synka("--tvinga" in sys.argv)
        logg(f"OK ({time.time() - t0:.0f} s): {resultat}")
    except BaseException as e:  # noqa: BLE001 – SystemExit från robo/publicera ska också loggas, inte krascha schemat
        logg(f"FEL ({time.time() - t0:.0f} s): {type(e).__name__}: {e}")
        if not isinstance(e, (SystemExit, RuntimeError)) and not type(e).__module__.startswith("roborock"):
            logg(traceback.format_exc(limit=4))
    return 0


if __name__ == "__main__":
    if sys.stdout is not None and hasattr(sys.stdout, "reconfigure"):
        sys.stdout.reconfigure(encoding="utf-8")
    sys.exit(main())

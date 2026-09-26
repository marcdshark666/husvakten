"""Husvakten – Roborock-inloggning via textfil (alternativ till roborock_login.py).

Läser %USERPROFILE%/.roborock/login.txt: epost=… → skickar kod; kod=… → loggar in.
Token sparas i %USERPROFILE%/.roborock/husvakten-userdata.json (aldrig i repot).
Koden raderas ur filen efter användning.
"""
import asyncio
import json
import pathlib
import re

from roborock.web_api import RoborockApiClient

VALV = pathlib.Path.home() / ".roborock"
FIL = VALV / "login.txt"
TOKENFIL = VALV / "husvakten-userdata.json"
ENHETFIL = VALV / "enhets-id.txt"


def enhets_id() -> str:
    """Roborock binder koden till klientens enhets-id – samma id måste användas vid omstart."""
    if ENHETFIL.exists():
        return ENHETFIL.read_text(encoding="utf-8").strip()
    import secrets
    ny = secrets.token_urlsafe(16)
    ENHETFIL.write_text(ny, encoding="utf-8")
    return ny


def ny_klient(epost: str) -> RoborockApiClient:
    k = RoborockApiClient(username=epost)
    k._device_identifier = enhets_id()  # privat fält i python-roborock; slumpas annars per start
    return k


def las(nyckel: str) -> str:
    m = re.search(rf"^{nyckel}=(.*)$", FIL.read_text(encoding="utf-8-sig", errors="replace"), re.M)
    return m.group(1).strip() if m else ""


def satt(nyckel: str, varde: str) -> None:
    t = FIL.read_text(encoding="utf-8-sig", errors="replace")
    t = re.sub(rf"^{nyckel}=.*$", f"{nyckel}={varde}", t, flags=re.M)
    FIL.write_text(t, encoding="utf-8")


async def main() -> None:
    klient = None
    epost = ""
    while True:
        await asyncio.sleep(2)
        try:
            e = las("epost")
            if not e:
                epost = ""  # tömd e-post → nästa sparning skickar ny kod
            if e and e != epost:
                epost = e  # sätts före anropet så ett fel inte ger en kodstorm
                if not re.fullmatch(r"[^@\s]+@[^@\s]+\.[^@\s]+", e):
                    satt("status", "ogiltig e-post – rätta och spara igen")
                    continue
                klient = ny_klient(epost)
                try:
                    await klient.request_code_v4()
                except Exception as fel4:
                    print("request_code_v4:", repr(fel4))
                    await klient.request_code()
                satt("status", "kod skickad till mejlen – skriv den efter kod= och spara")
                print("KOD SKICKAD")
            k = las("kod")
            if klient and k.isdigit():
                try:
                    ud = await klient.code_login_v4(k)
                except Exception as fel4:
                    print("code_login_v4:", repr(fel4))
                    ud = await klient.code_login(k)
                TOKENFIL.write_text(json.dumps({"epost": epost, "user_data": ud.as_dict()}), encoding="utf-8")
                satt("kod", "")
                satt("status", "INLOGGAD ✅ – du kan stänga filen")
                print("INLOGGAD")
                return
        except Exception as fel:
            print("misslyckades:", repr(fel))
            try:
                satt("kod", "")  # samma kod provas inte igen
                satt("status", f"fel: {fel} – skriv en ny kod, eller töm och skriv e-posten igen för ny kod")
            except Exception as fel2:
                print("kunde inte skriva status:", repr(fel2))


if __name__ == "__main__":
    asyncio.run(main())

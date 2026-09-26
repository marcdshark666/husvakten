"""Husvakten – lokal inloggning till Roborock-kontot (python-roborock, inofficiellt).

Kör:  python verktyg/roborock_login.py   → öppna http://127.0.0.1:5230
Servern lyssnar BARA på 127.0.0.1. Inloggningstoken sparas utanför repot i
%USERPROFILE%/.roborock/husvakten-userdata.json (repot är publikt – aldrig där).
"""
import asyncio
import html
import json
import pathlib
import re

from aiohttp import web
from roborock.web_api import RoborockApiClient

VALV = pathlib.Path.home() / ".roborock"
TOKENFIL = VALV / "husvakten-userdata.json"
HEMFIL = VALV / "husvakten-hem.json"
PORT = 5230

klienter: dict[str, RoborockApiClient] = {}

SIDA = """<!doctype html><html lang="sv"><head><meta charset="utf-8">
<meta name="viewport" content="width=device-width,initial-scale=1"><title>Husvakten · Roborock</title>
<style>
body{{font-family:system-ui,sans-serif;background:#f4f7fb;color:#152033;max-width:560px;margin:40px auto;padding:0 16px;font-size:18px}}
h1{{font-size:1.6rem}} .kort{{background:#fff;border:2px solid #cfd8e6;box-shadow:0 2px 8px rgba(0,0,0,.06);border-radius:12px;padding:18px;margin:14px 0}}
input{{width:100%;box-sizing:border-box;padding:12px;border-radius:8px;border:2px solid #9fb0c8;background:#fff;color:#152033;font-size:1.1rem;margin:6px 0 12px}}
button{{background:#1f9d55;color:#fff;border:0;border-radius:8px;padding:12px 18px;font-weight:700;font-size:1rem;cursor:pointer}}
.fel{{color:#c0223a}} .ok{{color:#1f7a44}} small{{color:#5b6b85}} li{{margin:4px 0}}
</style></head><body><h1>🏠 Husvakten · Roborock-inloggning</h1>{innehall}
<p><small>Körs bara lokalt på din dator (127.0.0.1). Lösenord behövs inte – Roborock mejlar en kod.
Token sparas i {tokenfil}, aldrig i det publika repot.</small></p></body></html>"""


def sida(innehall: str) -> web.Response:
    return web.Response(text=SIDA.format(innehall=innehall, tokenfil=html.escape(str(TOKENFIL))), content_type="text/html")


def epostform(fel: str = "") -> str:
    f = f'<p class="fel">{html.escape(fel)}</p>' if fel else ""
    return f"""<div class="kort"><b>Steg 1 av 2 – din Roborock-e-post</b>{f}
<form method="post" action="/kod"><input type="email" name="epost" required placeholder="namn@exempel.se" autocomplete="email">
<button>Skicka kod till mejlen</button></form></div>"""


async def start(_req: web.Request) -> web.Response:
    if TOKENFIL.exists():
        return sida('<div class="kort ok">✅ Redan inloggad. <a href="/hem" style="color:#1a5fd0">Visa hemmet</a></div>' + epostform())
    return sida(epostform())


async def kod(req: web.Request) -> web.Response:
    data = await req.post()
    epost = str(data.get("epost", "")).strip()
    if not re.fullmatch(r"[^@\s]+@[^@\s]+\.[^@\s]+", epost):
        return sida(epostform("Ogiltig e-postadress."))
    try:
        k = RoborockApiClient(username=epost)
        try:
            await k.request_code_v4()
        except Exception:
            await k.request_code()
        klienter[epost] = k
    except Exception as e:  # visa felet för användaren, logga i terminalen
        print("request_code misslyckades:", repr(e))
        return sida(epostform(f"Kunde inte skicka kod: {e}"))
    e = html.escape(epost)
    return sida(f"""<div class="kort"><b>Steg 2 av 2 – koden från mejlet</b>
<p>Roborock har skickat en kod till <b>{e}</b> (kolla skräpposten också).</p>
<form method="post" action="/logga-in"><input type="hidden" name="epost" value="{e}">
<input name="kod" required inputmode="numeric" pattern="[0-9]{{4,8}}" placeholder="123456" autocomplete="one-time-code">
<button>Logga in</button></form></div>""")


async def logga_in(req: web.Request) -> web.Response:
    data = await req.post()
    epost = str(data.get("epost", "")).strip()
    kodtext = str(data.get("kod", "")).strip()
    k = klienter.get(epost)
    if not k or not kodtext.isdigit():
        return sida(epostform("Sessionen tappades eller koden var ogiltig – börja om."))
    try:
        try:
            ud = await k.code_login_v4(kodtext)
        except Exception as e4:
            print("code_login_v4 misslyckades, provar code_login:", repr(e4))
            ud = await k.code_login(kodtext)
        VALV.mkdir(exist_ok=True)
        TOKENFIL.write_text(json.dumps({"epost": epost, "user_data": ud.as_dict()}), encoding="utf-8")
    except Exception as e:
        print("inloggning misslyckades:", repr(e))
        return sida(epostform(f"Inloggningen misslyckades: {e}"))
    raise web.HTTPFound("/hem")


async def hem(_req: web.Request) -> web.Response:
    if not TOKENFIL.exists():
        raise web.HTTPFound("/")
    try:
        from roborock.data.containers import UserData

        sparat = json.loads(TOKENFIL.read_text(encoding="utf-8"))
        k = RoborockApiClient(username=sparat["epost"])
        ud = UserData.from_dict(sparat["user_data"])
        hd = await k.get_home_data_v3(ud)
        HEMFIL.write_text(json.dumps(hd.as_dict(), default=str), encoding="utf-8")
        enheter = "".join(f"<li>🤖 {html.escape(d.name or '?')} <small>({html.escape(str(d.product_id))})</small></li>" for d in (hd.devices or []) + (hd.received_devices or []))
        rum = "".join(f"<li>{html.escape(r.name or '?')} <small>id {r.id}</small></li>" for r in (hd.rooms or []))
    except Exception as e:
        print("hemdata misslyckades:", repr(e))
        return sida(f'<div class="kort fel">Inloggad, men kunde inte hämta hemmet: {html.escape(str(e))}</div>')
    return sida(f"""<div class="kort ok">✅ Inloggad! Du kan stänga sidan – säg till Vakthund 10 att det är klart.</div>
<div class="kort"><b>Robotar</b><ul>{enheter or '<li>inga</li>'}</ul><b>Rum i appen</b><ul>{rum or '<li>inga</li>'}</ul></div>""")


def main() -> None:
    app = web.Application()
    app.add_routes([web.get("/", start), web.post("/kod", kod), web.post("/logga-in", logga_in), web.get("/hem", hem)])
    print(f"Husvakten Roborock-inloggning: http://127.0.0.1:{PORT}")
    web.run_app(app, host="127.0.0.1", port=PORT, print=None)


if __name__ == "__main__":
    main()

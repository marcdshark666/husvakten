"""Fönster- och skärmhjälpare för Spelkontroll (Win32 via ctypes + MSAA via comtypes).

Används av de skriptade sekvenserna i server.py (Netflix, Film (AVG), Hitta film). ALLT här är
fasta sekvenser - inget ur en HTTP-förfrågan når hit utom en färdigbyggd, validerad URL som
skickas som argument till en exe (aldrig till ett skal).

Regler:
  * Fönster MINIMERAS bara (ShowWindow SW_MINIMIZE) - aldrig stängda, inga processer dödas.
  * Sidinnehåll läses via MSAA/IAccessible (samma väg som skärmläsare) - aldrig kakor, Login Data,
    Local State eller andra profilfiler.
  * Tangenttryck skickas bara när mål-fönstret verifierats vara i förgrunden.
"""
from __future__ import annotations

import ctypes
import sys
import time
from ctypes import wintypes

user32 = ctypes.windll.user32
kernel32 = ctypes.windll.kernel32
dwmapi = ctypes.windll.dwmapi

# Riktiga pixlar (skärmen kör 150 %): utan detta är alla rektanglar skalade 1/1,5.
try:
    user32.SetProcessDpiAwarenessContext(ctypes.c_void_p(-4))  # PER_MONITOR_AWARE_V2
except (AttributeError, OSError):
    try:
        user32.SetProcessDPIAware()
    except (AttributeError, OSError):
        pass

SW_MINIMIZE, SW_MAXIMIZE, SW_RESTORE = 6, 3, 9
GWL_EXSTYLE = -20
WS_EX_TOOLWINDOW = 0x00000080
WS_EX_NOACTIVATE = 0x08000000
DWMWA_CLOAKED = 14
OBJID_CLIENT = 0xFFFFFFFC
ROLE_DOCUMENT, ROLE_LINK = 15, 30
SELFLAG_TAKEFOCUS = 1
INPUT_KEYBOARD, INPUT_MOUSE = 1, 0
KEYEVENTF_KEYUP, KEYEVENTF_UNICODE = 0x0002, 0x0004
MOUSEEVENTF_MOVE, MOUSEEVENTF_ABSOLUTE = 0x0001, 0x8000
MOUSEEVENTF_LEFTDOWN, MOUSEEVENTF_LEFTUP = 0x0002, 0x0004
VK = {"alt": 0x12, "ctrl": 0x11, "shift": 0x10, "esc": 0x1B, "end": 0x23, "home": 0x24, "pgdn": 0x22,
      "pgup": 0x21, "enter": 0x0D, "f": 0x46, "f11": 0x7A, "down": 0x28, "up": 0x26, "left": 0x25,
      "right": 0x27, "tab": 0x09, "win": 0x5B, "f10": 0x79, "space": 0x20}

# Fönsterklasser/titlar som aldrig minimeras (skalet, aktivitetsfältet, skrivbordet).
SKAL_KLASSER = {"Progman", "WorkerW", "Shell_TrayWnd", "Shell_SecondaryTrayWnd", "Button",
                "Windows.UI.Core.CoreWindow", "ApplicationFrameWindow_hidden", "NotifyIconOverflowWindow",
                "XamlExplorerHostIslandWindow", "TopLevelWindowForOverflowXamlIsland"}

user32.GetWindowTextLengthW.restype = ctypes.c_int
user32.GetWindowLongW.restype = ctypes.c_long
user32.GetForegroundWindow.restype = wintypes.HWND
EnumWindowsProc = ctypes.WINFUNCTYPE(ctypes.c_bool, wintypes.HWND, wintypes.LPARAM)


# ---------------------------------------------------------------- grundläsning
def klass(h: int) -> str:
    b = ctypes.create_unicode_buffer(256)
    user32.GetClassNameW(h, b, 256)
    return b.value


def titel(h: int) -> str:
    n = user32.GetWindowTextLengthW(h) + 1
    b = ctypes.create_unicode_buffer(n)
    user32.GetWindowTextW(h, b, n)
    return b.value


def pid_for(h: int) -> int:
    p = wintypes.DWORD()
    user32.GetWindowThreadProcessId(h, ctypes.byref(p))
    return int(p.value)


def cloaked(h: int) -> bool:
    v = wintypes.DWORD()
    try:
        if dwmapi.DwmGetWindowAttribute(h, DWMWA_CLOAKED, ctypes.byref(v), ctypes.sizeof(v)) == 0:
            return bool(v.value)
    except OSError:
        pass
    return False


def rekt(h: int) -> tuple[int, int, int, int]:
    r = wintypes.RECT()
    user32.GetWindowRect(h, ctypes.byref(r))
    return r.left, r.top, r.right, r.bottom


def synliga_fonster() -> list[dict]:
    """Topnivåfönster i z-ordning (överst först): synliga, med titel, inte cloaked/verktygsfönster."""
    ut: list[dict] = []

    def cb(h, _):
        if not user32.IsWindowVisible(h):
            return True
        t = titel(h)
        if not t:
            return True
        ex = user32.GetWindowLongW(h, GWL_EXSTYLE)
        if ex & WS_EX_TOOLWINDOW or cloaked(h):
            return True
        k = klass(h)
        if k in SKAL_KLASSER:
            return True
        ut.append({"hwnd": int(h), "titel": t, "klass": k, "pid": pid_for(h), "iconic": bool(user32.IsIconic(h))})
        return True
    user32.EnumWindows(EnumWindowsProc(cb), 0)
    return ut


def hitta_fonster(titeldel: str, klassnamn: str | None = None, undanta: set[int] | None = None) -> int | None:
    """Översta synliga fönstret vars titel innehåller titeldel (och ev. klass). None om inget."""
    for f in synliga_fonster():
        if titeldel.lower() in f["titel"].lower() and (klassnamn is None or f["klass"] == klassnamn) \
                and f["hwnd"] not in (undanta or set()):
            return f["hwnd"]
    return None


def vanta_fonster(titeldel: str, klassnamn: str | None, fore: set[int], timeout: float = 25.0) -> int | None:
    """Väntar på ett NYTT fönster (inte i `fore`); efter halva tiden duger även ett gammalt."""
    slut = time.time() + timeout
    while time.time() < slut:
        h = hitta_fonster(titeldel, klassnamn, fore)
        if h:
            return h
        if time.time() > slut - timeout / 2:
            h = hitta_fonster(titeldel, klassnamn)
            if h:
                return h
        time.sleep(0.5)
    return None


# ---------------------------------------------------------------- styrning av fönster (SendInput)
# INPUT måste vara exakt 40 byte på x64 (DWORD type + 4 byte padding + 32 byte union) - annars
# avvisar SendInput allt tyst (ERROR_INVALID_PARAMETER). Därför riktiga Win32-strukturer här.
ULONG_PTR = ctypes.c_size_t


class MOUSEINPUT(ctypes.Structure):
    _fields_ = [("dx", ctypes.c_long), ("dy", ctypes.c_long), ("mouseData", wintypes.DWORD),
                ("dwFlags", wintypes.DWORD), ("time", wintypes.DWORD), ("dwExtraInfo", ULONG_PTR)]


class KEYBDINPUT(ctypes.Structure):
    _fields_ = [("wVk", wintypes.WORD), ("wScan", wintypes.WORD), ("dwFlags", wintypes.DWORD),
                ("time", wintypes.DWORD), ("dwExtraInfo", ULONG_PTR)]


class HARDWAREINPUT(ctypes.Structure):
    _fields_ = [("uMsg", wintypes.DWORD), ("wParamL", wintypes.WORD), ("wParamH", wintypes.WORD)]


class _INPUTUNION(ctypes.Union):
    _fields_ = [("mi", MOUSEINPUT), ("ki", KEYBDINPUT), ("hi", HARDWAREINPUT)]


class INPUT(ctypes.Structure):
    _anonymous_ = ("u",)
    _fields_ = [("type", wintypes.DWORD), ("u", _INPUTUNION)]


assert ctypes.sizeof(INPUT) == 40, ctypes.sizeof(INPUT)
user32.SendInput.argtypes = (wintypes.UINT, ctypes.POINTER(INPUT), ctypes.c_int)
user32.SendInput.restype = wintypes.UINT


def _send(i: INPUT) -> None:
    if user32.SendInput(1, ctypes.byref(i), ctypes.sizeof(INPUT)) != 1:
        raise OSError(f"SendInput avvisades (fel {ctypes.get_last_error() or kernel32.GetLastError()})")


def _skicka_tangent(vk: int, upp: bool = False) -> None:
    i = INPUT()
    i.type = INPUT_KEYBOARD
    i.ki.wVk = vk
    i.ki.dwFlags = KEYEVENTF_KEYUP if upp else 0
    _send(i)


def _skicka_unicode(tecken: str) -> None:
    for flags in (KEYEVENTF_UNICODE, KEYEVENTF_UNICODE | KEYEVENTF_KEYUP):
        i = INPUT()
        i.type = INPUT_KEYBOARD
        i.ki.wScan = ord(tecken)
        i.ki.dwFlags = flags
        _send(i)


def _mus(dx: int, dy: int, flags: int, data: int = 0) -> None:
    i = INPUT()
    i.type = INPUT_MOUSE
    i.mi.dx, i.mi.dy, i.mi.dwFlags = dx, dy, flags
    i.mi.mouseData = ctypes.c_uint32(data & 0xFFFFFFFF).value
    _send(i)


def _abs(x: int, y: int) -> tuple[int, int]:
    sw, sh = user32.GetSystemMetrics(0), user32.GetSystemMetrics(1)
    return int(x * 65535 / max(1, sw - 1)), int(y * 65535 / max(1, sh - 1))


def tryck(*namn: str) -> None:
    """tryck('ctrl', 'f') = kombination; tryck('esc') = en tangent."""
    vks = [VK[n] for n in namn]
    for vk in vks:
        _skicka_tangent(vk)
        time.sleep(0.02)
    for vk in reversed(vks):
        _skicka_tangent(vk, upp=True)
        time.sleep(0.02)


def skriv(text: str) -> None:
    for t in text:
        _skicka_unicode(t)
        time.sleep(0.02)


MOUSEEVENTF_RIGHTDOWN, MOUSEEVENTF_RIGHTUP = 0x0008, 0x0010


def klicka(x: int, y: int, hoger: bool = False) -> None:
    """Vänster-/högerklick på skärmkoordinat (absolut, primär skärm)."""
    ax, ay = _abs(x, y)
    ned, upp = (MOUSEEVENTF_RIGHTDOWN, MOUSEEVENTF_RIGHTUP) if hoger else (MOUSEEVENTF_LEFTDOWN, MOUSEEVENTF_LEFTUP)
    for flags in (MOUSEEVENTF_MOVE | MOUSEEVENTF_ABSOLUTE, ned | MOUSEEVENTF_ABSOLUTE, upp | MOUSEEVENTF_ABSOLUTE):
        _mus(ax, ay, flags)
        time.sleep(0.05)


MOUSEEVENTF_WHEEL = 0x0800


def rulla(x: int, y: int, hack: int) -> None:
    """Mushjul över punkten (x, y): hack < 0 = nedåt, > 0 = uppåt. Kräver inget tangentbordsfokus."""
    ax, ay = _abs(x, y)
    _mus(ax, ay, MOUSEEVENTF_MOVE | MOUSEEVENTF_ABSOLUTE)
    time.sleep(0.05)
    _mus(0, 0, MOUSEEVENTF_WHEEL, 120 * hack)


def till_forgrund(h: int, forsok: int = 4) -> bool:
    """Maximerar och lägger fönstret överst. Alt-trycket låter en bakgrundsprocess sätta förgrund;
    reserv: AttachThreadInput mot den tråd som har förgrunden just nu."""
    for i in range(forsok):
        if user32.IsIconic(h):
            user32.ShowWindow(h, SW_RESTORE)
        user32.ShowWindow(h, SW_MAXIMIZE)
        _skicka_tangent(VK["alt"])
        _skicka_tangent(VK["alt"], upp=True)
        fg = user32.GetForegroundWindow()
        bunden = False
        if i >= 1 and fg and fg != h:
            t_fg = user32.GetWindowThreadProcessId(fg, None)
            t_me = kernel32.GetCurrentThreadId()
            bunden = bool(user32.AttachThreadInput(t_me, t_fg, True))
        user32.SetForegroundWindow(h)
        user32.BringWindowToTop(h)
        user32.SetFocus(h)
        if bunden:
            user32.AttachThreadInput(kernel32.GetCurrentThreadId(), user32.GetWindowThreadProcessId(fg, None), False)
        time.sleep(0.4)
        if user32.GetForegroundWindow() == h:
            return True
    return user32.GetForegroundWindow() == h


def ar_maximerat(h: int) -> bool:
    return bool(user32.IsZoomed(h))


def minimera_ovriga(behall: int) -> tuple[int, list[str]]:
    """Minimerar alla andra synliga topnivåfönster (aldrig stänger). Returnerar (antal, titlar)."""
    n, titlar = 0, []
    for f in synliga_fonster():
        if f["hwnd"] == behall or f["iconic"]:
            continue
        if user32.GetWindowLongW(f["hwnd"], GWL_EXSTYLE) & WS_EX_NOACTIVATE:
            continue
        user32.ShowWindow(f["hwnd"], SW_MINIMIZE)
        n += 1
        titlar.append(f["titel"][:60])
    return n, titlar


# ---------------------------------------------------------------- MSAA (IAccessible) - läsning av sidinnehåll
_acc_mod = None


def _acc():
    global _acc_mod
    if _acc_mod is None:
        import comtypes
        import comtypes.client
        comtypes.client.GetModule("oleacc.dll")
        from comtypes.gen import Accessibility  # noqa: F401
        _acc_mod = Accessibility
    return _acc_mod


EnumChildProc = ctypes.WINFUNCTYPE(ctypes.c_bool, wintypes.HWND, wintypes.LPARAM)


def render_fonster(h: int) -> list[int]:
    """Chromiums synliga Chrome_RenderWidgetHostHWND-barn (ett per laddad flik)."""
    ut: list[int] = []

    def cb(c, _):
        if klass(c) == "Chrome_RenderWidgetHostHWND" and user32.IsWindowVisible(c):
            ut.append(int(c))
        return True
    user32.EnumChildWindows(h, EnumChildProc(cb), 0)
    return ut


class Sida:
    """Ett laddat dokument i ett Chromium-fönster, läst via MSAA."""

    def __init__(self, acc):
        self.acc = acc
        self.namn = _p(acc.accName, 0) or ""
        self.url = str(_p(acc.accValue, 0) or "")

    def _barn(self, acc):
        from comtypes import automation
        oleacc = ctypes.oledll.oleacc
        try:
            n = acc.accChildCount
        except Exception:  # noqa: BLE001
            return []
        if not n:
            return []
        arr = (automation.VARIANT * n)()
        got = ctypes.c_long()
        oleacc.AccessibleChildren(acc, 0, n, arr, ctypes.byref(got))
        ut = []
        A = _acc()
        for i in range(got.value):
            v = arr[i]
            if v.vt == automation.VT_DISPATCH:
                try:
                    ut.append((v.value.QueryInterface(A.IAccessible), 0))
                except Exception:  # noqa: BLE001
                    pass
            else:
                ut.append((acc, v.value))
        return ut

    def element(self, roll: int | None = None, maxantal: int = 30000) -> list[dict]:
        """Alla element (ev. bara en roll): {namn, varde, roll, acc, barn, rekt}."""
        ut: list[dict] = []
        stack = [(self.acc, 0, 0)]
        n = 0
        while stack and n < maxantal:
            acc, child, djup = stack.pop()
            n += 1
            r = _p(acc.accRole, child)
            if roll is None or r == roll:
                ut.append({"namn": _p(acc.accName, child) or "", "varde": str(_p(acc.accValue, child) or ""),
                           "roll": r, "acc": acc, "barn": child})
            if child == 0 and djup < 60:
                for a, c in reversed(self._barn(acc)):
                    stack.append((a, c, djup + 1))
        return ut

    @staticmethod
    def plats(el: dict) -> tuple[int, int, int, int] | None:
        """(left, top, width, height) i skärmpixlar. comtypes returnerar [out]-parametrarna som tuple."""
        try:
            l, t, w, h = el["acc"].accLocation(el["barn"])
            if w <= 0 or h <= 0:
                return None
            return int(l), int(t), int(w), int(h)
        except Exception:  # noqa: BLE001
            return None

    @staticmethod
    def fokusera(el: dict) -> bool:
        """Ger elementet fokus -> webbläsaren rullar det i bild."""
        try:
            el["acc"].accSelect(SELFLAG_TAKEFOCUS, el["barn"])
            return True
        except Exception:  # noqa: BLE001
            return False

    @staticmethod
    def aktivera(el: dict) -> bool:
        """Standardåtgärd (= klick på länk/knapp) utan mus."""
        try:
            el["acc"].accDoDefaultAction(el["barn"])
            return True
        except Exception:  # noqa: BLE001
            return False


def _p(fn, child):
    try:
        return fn(child)
    except Exception:  # noqa: BLE001
        return None


def sidor(h: int, urldel: str = "") -> list[Sida]:
    """Laddade dokument i fönstret vars URL innehåller urldel."""
    A = _acc()
    oleacc = ctypes.oledll.oleacc
    iid = A.IAccessible._iid_
    ut = []
    for c in render_fonster(h):
        p = ctypes.POINTER(A.IAccessible)()
        try:
            oleacc.AccessibleObjectFromWindow(c, OBJID_CLIENT, ctypes.byref(iid), ctypes.byref(p))
        except OSError:
            continue
        s = Sida(p)
        if urldel.lower() in s.url.lower() and s.url:
            ut.append(s)
    return ut


def dokument(h: int, urldel: str, maxantal: int = 6000) -> tuple[str, list[dict]] | None:
    """Webbdokumentet (via topnivåfönstrets MSAA-träd) vars URL innehåller urldel: (url, element).
    Chrome bygger sidträdet lätt/stegvis; anropa upprepat tills elementen finns."""
    A = _acc()
    oleacc = ctypes.oledll.oleacc
    p = ctypes.POINTER(A.IAccessible)()
    try:
        oleacc.AccessibleObjectFromWindow(h, OBJID_CLIENT, ctypes.byref(A.IAccessible._iid_), ctypes.byref(p))
    except OSError:
        return None
    for e in Sida(p).element(ROLE_DOCUMENT, maxantal=4000):
        if urldel.lower() in e["varde"].lower():
            # "använd" dokumentets egenskaper så Chrome slår på fullt träd för fliken
            _p(e["acc"].accName, 0), _p(e["acc"].accValue, 0), _p(lambda _: e["acc"].accChildCount, 0)
            return e["varde"], Sida(e["acc"]).element(maxantal=maxantal)
    return None


def omnibox_url(h: int) -> str | None:
    """Adressfältets text i ett Chromium-fönster (webbläsarens eget UI)."""
    A = _acc()
    oleacc = ctypes.oledll.oleacc
    p = ctypes.POINTER(A.IAccessible)()
    try:
        oleacc.AccessibleObjectFromWindow(h, OBJID_CLIENT, ctypes.byref(A.IAccessible._iid_), ctypes.byref(p))
    except OSError:
        return None
    for e in Sida(p).element(42, maxantal=4000):
        if "address" in e["namn"].lower() or "adres" in e["namn"].lower():
            return e["varde"]
    return None


def vanta_sida(h: int, urldel: str, timeout: float = 25.0) -> Sida | None:
    slut = time.time() + timeout
    while time.time() < slut:
        try:
            s = sidor(h, urldel)
        except Exception as e:  # noqa: BLE001
            sys.stderr.write(f"msaa: {e}\n")
            return None
        if s:
            return s[0]
        time.sleep(0.7)
    return None


def synlig_i(h: int, plats: tuple[int, int, int, int] | None) -> bool:
    if not plats:
        return False
    l, t, w, hh = plats
    L, T, R, B = rekt(h)
    return w > 0 and hh > 0 and l >= L - 2 and t >= T and l + w <= R + 2 and t + hh <= B


if __name__ == "__main__":  # liten självtest: lista fönster
    for f in synliga_fonster()[:40]:
        print(f)

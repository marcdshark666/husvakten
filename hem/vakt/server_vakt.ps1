# server_vakt.ps1 - haller Husvaktens hemserver (hem/server.py, 127.0.0.1:5193) uppe.
#
# Kors av Schemalaggarens uppgift Husvakten-Hem-Server (vid inloggning + var 5:e minut,
# dold via C:\Users\PC\.claude\tools\hidden-launchers\Husvakten-Hem-Server.vbs).
# Lyssnar nagon redan pa 127.0.0.1:5193 gors ingenting - en server som redan kor dodas aldrig.
# Saknas den startas `python -u server.py` dolt fran projektmappen (server.py binder bara
# 127.0.0.1; utat nas den bara via tailscale serve --set-path /hem). Logg: data\vakt\server.log
#
#   powershell -NoProfile -ExecutionPolicy Bypass -File server_vakt.ps1          # laga
#   powershell -NoProfile -ExecutionPolicy Bypass -File server_vakt.ps1 -Status  # bara visa
#
# (Speglar spelkontroll\vakt\server_vakt.ps1. Ren ASCII + UTF-8 BOM for PS 5.1.)
param(
  [switch]$Status,
  [int]$Port = 5193
)
$ErrorActionPreference = 'Continue'
$Root = Split-Path -Parent (Split-Path -Parent $MyInvocation.MyCommand.Path)  # husvakten\hem
$LogDir = Join-Path $Root 'data\vakt'
$Log = Join-Path $LogDir 'server.log'
$ServerLog = Join-Path $LogDir 'server-stdout.log'
New-Item -ItemType Directory -Force -Path $LogDir | Out-Null

function Logga($text) {
  $rad = "{0} {1}" -f (Get-Date -Format 'yyyy-MM-dd HH:mm:ss'), $text
  Add-Content -Path $Log -Value $rad -Encoding UTF8
  Write-Output $rad
}

function Lyssnar {
  $c = Get-NetTCPConnection -LocalPort $Port -State Listen -ErrorAction SilentlyContinue | Where-Object { $_.LocalAddress -eq '127.0.0.1' -or $_.LocalAddress -eq '0.0.0.0' }
  if ($c) { return [int]($c | Select-Object -First 1).OwningProcess }
  return 0
}

function Svarar {
  try {
    $r = Invoke-WebRequest -UseBasicParsing -Uri ("http://127.0.0.1:{0}/api/halsa" -f $Port) -TimeoutSec 5
    return ($r.StatusCode -eq 200)
  } catch { return $false }
}

$pid0 = Lyssnar
if ($Status) {
  if ($pid0) { Logga ("STATUS: servern lyssnar pa {0} (pid {1}), svarar: {2}" -f $Port, $pid0, (Svarar)) } else { Logga ("STATUS: ingen server pa {0}" -f $Port) }
  exit 0
}

if ($pid0) {
  if (-not (Svarar)) { Logga ("VARNING: port {0} lyssnar (pid {1}) men /api/halsa svarar inte - ror den inte" -f $Port, $pid0) }
  exit 0
}

$python = (Get-Command python.exe -ErrorAction SilentlyContinue).Source
if (-not $python) { $python = 'C:\Users\PC\AppData\Local\Programs\Python\Python312\python.exe' }
if (-not (Test-Path $python)) { Logga "FEL: hittar ingen python.exe"; exit 1 }
if (-not (Test-Path (Join-Path $Root 'server.py'))) { Logga ("FEL: server.py saknas i {0}" -f $Root); exit 1 }

# Trimma stdout-loggen sa den inte vaxer for evigt.
try { if ((Test-Path $ServerLog) -and (Get-Item $ServerLog).Length -gt 2MB) { Remove-Item $ServerLog -Force } } catch {}

# cmd /c med omdirigering, dolt: python far ingen synlig konsol och stdout hamnar i loggen.
# -X utf8: utan den skriver python till omdirigerad stdout i cp1250 och kraschar pa
# "a-ring" i startraden (UnicodeEncodeError) - servern dog vid varje start fran Schemalaggaren.
$cmdArg = '/c ""{0}" -X utf8 -u server.py >> "{1}" 2>&1"' -f $python, $ServerLog
try {
  $p = Start-Process -FilePath "$env:SystemRoot\System32\cmd.exe" -ArgumentList $cmdArg -WorkingDirectory $Root -WindowStyle Hidden -PassThru
  Start-Sleep -Seconds 3
  $pid1 = Lyssnar
  if ($pid1) { Logga ("STARTADE servern pa {0} (cmd pid {1}, lyssnar pid {2})" -f $Port, $p.Id, $pid1); exit 0 }
  Start-Sleep -Seconds 4
  $pid1 = Lyssnar
  if ($pid1) { Logga ("STARTADE servern pa {0} (lyssnar pid {1})" -f $Port, $pid1); exit 0 }
  Logga ("FEL: servern startades men lyssnar inte pa {0} - se {1}" -f $Port, $ServerLog)
  exit 1
} catch {
  Logga ("FEL vid start: {0}" -f $_.Exception.Message)
  exit 1
}

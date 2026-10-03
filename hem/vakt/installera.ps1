# installera.ps1 - registrerar Husvaktens hemservers schemalagda jobb (ren ASCII + UTF-8 BOM, PS 5.1).
#
#   Husvakten-Hem-Server   vid inloggning (+1 min) och var 5:e minut: server_vakt.ps1 haller
#                         hem/server.py uppe pa 127.0.0.1:5193
#
# Startas via dold VBS-launcher i C:\Users\PC\.claude\tools\hidden-launchers (aldrig
# powershell direkt - konsolfonstret blinkar annars). Register-ScheduledTask sa att argumenten
# hamnar ordagrant i XML:en. Ingen -RepetitionDuration: [TimeSpan]::MaxValue gar inte att
# registrera. Uppgiften lases tillbaka efterat.
#
# Speglar spelkontroll\vakt\installera.ps1 (Husvakten-Hem-Server).
#
#   powershell -NoProfile -ExecutionPolicy Bypass -File installera.ps1
#   powershell -NoProfile -ExecutionPolicy Bypass -File installera.ps1 -Remove
param([switch]$Remove)
$ErrorActionPreference = 'Stop'
$Here = Split-Path -Parent $MyInvocation.MyCommand.Path
$Root = Split-Path -Parent $Here
$Launchers = 'C:\Users\PC\.claude\tools\hidden-launchers'
$Wscript = Join-Path $env:SystemRoot 'System32\wscript.exe'
$Jag = "$env:USERDOMAIN\$env:USERNAME"
$Namn = 'Husvakten-Hem-Server'

if ($Remove) {
  schtasks.exe /delete /tn $Namn /f 2>$null | Out-Null
  Write-Output ("{0}: borttagen" -f $Namn)
  exit 0
}

New-Item -ItemType Directory -Force -Path $Launchers | Out-Null

function Skriv-Vbs($namn, $kommentar, $kommando) {
  $vbsRad = $kommando.Replace('"', '""')
  $text = @"
' Dold startare: $namn - $kommentar
Option Explicit
Dim sh, rc
Set sh = CreateObject("WScript.Shell")
rc = sh.Run("$vbsRad", 0, True)
WScript.Quit rc
"@
  $fil = Join-Path $Launchers "$namn.vbs"
  [IO.File]::WriteAllText($fil, $text.Replace("`n", "`r`n"), [Text.Encoding]::ASCII)
  return $fil
}

$vbs = Skriv-Vbs $Namn 'haller Husvaktens hemserver (127.0.0.1:5193, /hem via Tailscale) uppe utan konsolfonster' `
  ('powershell.exe -NoProfile -ExecutionPolicy Bypass -File "{0}"' -f (Join-Path $Here 'server_vakt.ps1'))

$a = New-ScheduledTaskAction -Execute $Wscript -Argument ('//B //Nologo "' + $vbs + '"') -WorkingDirectory $Root
$tLogon = New-ScheduledTaskTrigger -AtLogOn -User $Jag
$tLogon.Delay = 'PT1M'
$tRep = New-ScheduledTaskTrigger -Once -At (Get-Date).Date -RepetitionInterval (New-TimeSpan -Minutes 5)
$s = New-ScheduledTaskSettingsSet -MultipleInstances IgnoreNew -AllowStartIfOnBatteries -DontStopIfGoingOnBatteries -StartWhenAvailable -ExecutionTimeLimit (New-TimeSpan -Minutes 5) -Priority 7
Register-ScheduledTask -TaskName $Namn -Action $a -Trigger @($tLogon, $tRep) -Settings $s -Force `
  -Description 'Husvakten: haller hemservern (husvakten\hem\server.py, 127.0.0.1:5193, /hem via Tailscale) uppe. Ror aldrig en server som redan lyssnar. Omregistreras av husvakten\hem\vakt\installera.ps1.' | Out-Null

# --- Las tillbaka och verifiera ---
$t = Get-ScheduledTask -TaskName $Namn -ErrorAction SilentlyContinue
if (-not $t) { throw "$Namn saknas i Schemalaggaren" }
$argu = $t.Actions[0].Arguments
if ($argu -match '\\"') { throw "$Namn fick literala \\`" i argumenten: $argu" }
if ($t.Actions[0].Execute -notmatch 'wscript\.exe$') { throw "$Namn kor inte via wscript: $($t.Actions[0].Execute)" }
$info = Get-ScheduledTaskInfo -TaskName $Namn
$rep = $t.Triggers | Where-Object { $_.Repetition -and $_.Repetition.Interval } | Select-Object -First 1
$repText = if ($rep) { " upprepning $($rep.Repetition.Interval) / [$($rep.Repetition.Duration)]" } else { '' }
Write-Output ("{0}: {1}, nasta korning {2}{3}" -f $Namn, $t.State, $info.NextRunTime, $repText)
Write-Output 'Klart.'

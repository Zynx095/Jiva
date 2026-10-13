@echo off
setlocal
title JIVA Launcher
cd /d "%~dp0"

rem Usage: start-jiva.bat [--no-browser]
rem Starts the API (:4000) and all six apps (:5173-:5178), then opens them in the browser.
set "OPEN_BROWSER=1"
if /i "%~1"=="--no-browser" set "OPEN_BROWSER="

where node >nul 2>nul
if errorlevel 1 (
  echo [ERROR] Node.js not found. Install it from https://nodejs.org and retry.
  pause
  exit /b 1
)

rem Install on the first run, and whenever an app has no Vite of its own yet
rem (for example the doctor workspace and the demo portal after switching branches).
set "NEED_INSTALL="
if not exist "node_modules" set "NEED_INSTALL=1"
for %%A in (management-web ambulance-web hospital-web patient-web doctor-web demo-portal) do (
  if not exist "apps\%%A\node_modules\vite\bin\vite.js" set "NEED_INSTALL=1"
)
if defined NEED_INSTALL (
  echo Installing dependencies...
  call npm install
  if errorlevel 1 (
    echo [ERROR] npm install failed.
    pause
    exit /b 1
  )
)

rem The API loads the shared packages from their compiled dist folders. Rebuild them when a
rem dist is missing or older than its sources (new event contracts, clinical models, catalogue).
node -e "const fs=require('fs'),path=require('path');const newest=d=>{let m=0;for(const e of fs.readdirSync(d,{withFileTypes:true})){const p=path.join(d,e.name);m=Math.max(m,e.isDirectory()?newest(p):fs.statSync(p).mtimeMs)}return m};const stale=['config','event-schema','domain-models','auth','feasibility','intelligence','mapping','realtime'].filter(n=>{const out=path.join('packages',n,'dist','index.js');return !fs.existsSync(out)||newest(path.join('packages',n,'src'))>fs.statSync(out).mtimeMs});if(stale.length){console.log('Shared packages out of date: '+stale.join(', '));process.exit(1)}"
if errorlevel 1 (
  echo Building shared packages...
  for %%P in (config event-schema domain-models auth feasibility intelligence mapping realtime) do (
    call npm run build --silent -w packages/%%P
    if errorlevel 1 (
      echo [ERROR] Building packages/%%P failed.
      pause
      exit /b 1
    )
  )
)

echo Starting the JIVA API and all six apps in a new window...
start "JIVA Dev Servers" /D "%~dp0." cmd /k npm run dev

rem Vite listens on ::1 and the API on all interfaces: probe both loopback addresses, each with a short
rem timeout (a refused connection on Windows otherwise takes about two seconds).
echo Waiting for the API (:4000) and the apps (:5173-:5178)...
powershell -NoProfile -Command ^
  "function Up($p) { foreach ($a in '::1', '127.0.0.1') { $c = New-Object Net.Sockets.TcpClient ([Net.IPAddress]::Parse($a).AddressFamily); try { if ($c.ConnectAsync($a, $p).Wait(400)) { return $true } } catch { } finally { $c.Dispose() } }; return $false };" ^
  "$ports = 4000,5173,5174,5175,5176,5177,5178; $deadline = (Get-Date).AddSeconds(120); $down = @();" ^
  "foreach ($p in $ports) { $up = $false; do { $up = Up $p; if (-not $up) { Start-Sleep -Milliseconds 500 } } while (-not $up -and ((Get-Date) -lt $deadline)); if (-not $up) { $down += $p } };" ^
  "if ($down.Count) { Write-Host ('[WARN] Not answering on port(s): ' + ($down -join ', ') + '. Check the JIVA Dev Servers window.') } else { Write-Host 'The API and all six apps are answering.' }"

if defined OPEN_BROWSER (
  echo Opening interfaces...
  start "" "http://localhost:5173"
  start "" "http://localhost:5174"
  start "" "http://localhost:5175"
  start "" "http://localhost:5176"
  start "" "http://localhost:5177"
  start "" "http://localhost:5178"
)

echo.
echo JIVA is running.
echo   Management       : http://localhost:5173
echo   Ambulance        : http://localhost:5174
echo   Hospital         : http://localhost:5175
echo   Patient          : http://localhost:5176
echo   Doctor workspace : http://localhost:5177   (clinicians: ?as=demo-doc-1 to demo-doc-5)
echo   Demo portal      : http://localhost:5178   (scenarios, controls, timeline, asset library)
echo   API              : http://localhost:4000   (health: /api/health)
echo.
echo Readiness report: npm run demo:check
echo Close the "JIVA Dev Servers" window to stop everything.
timeout /t 5 >nul
endlocal

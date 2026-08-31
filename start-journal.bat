@echo off
setlocal enabledelayedexpansion
title QuantRails Trading Journal

REM Run from the folder this file lives in, so it works from a desktop shortcut.
cd /d "%~dp0"

echo ==================================================
echo    QuantRails Trading Journal
echo ==================================================
echo.

REM ---- Check Node.js is installed -------------------------------------------
where node >nul 2>nul
if errorlevel 1 (
  echo [ERROR] Node.js was not found.
  echo.
  echo Install the LTS version from https://nodejs.org
  echo then close this window and run this file again.
  echo.
  pause
  exit /b 1
)

for /f "tokens=1 delims=." %%v in ('node -p "process.versions.node"') do set NODEMAJOR=%%v
if !NODEMAJOR! LSS 20 (
  echo [ERROR] Node.js !NODEMAJOR! is too old - this project needs version 20 or newer.
  echo Install the current LTS from https://nodejs.org
  echo.
  pause
  exit /b 1
)
for /f %%v in ('node -p "process.versions.node"') do echo Using Node.js %%v
echo.

REM ---- Pull the latest code, if this is a git checkout ----------------------
where git >nul 2>nul
if not errorlevel 1 (
  if exist ".git\" (
    echo [1/4] Checking for updates...
    call git pull --ff-only
    if errorlevel 1 echo       Could not update automatically - carrying on with the current code.
    echo.
  )
)

REM ---- Install dependencies -------------------------------------------------
REM Always run this: an update can add a new dependency, and npm install is a
REM fast no-op when everything is already present.
echo [2/4] Checking dependencies. The first run takes a few minutes...
call npm install
if errorlevel 1 goto failed
echo.

REM ---- Build ----------------------------------------------------------------
echo [3/4] Building the app...
call npm run build
if errorlevel 1 goto failed
echo.

REM ---- Start ----------------------------------------------------------------
echo [4/4] Starting the server on http://localhost:5000
echo.
echo     Log in with the username and password from your .env file,
echo     or the defaults in .env.example if you have not made one.
echo.
echo     Leave this window open while you use the journal.
echo     Press Ctrl+C here to stop it.
echo.

REM Open the browser once the server has had a moment to come up.
start "" powershell -NoProfile -WindowStyle Hidden -Command "Start-Sleep -Seconds 4; Start-Process 'http://localhost:5000'"

call npm start
if errorlevel 1 goto failed

echo.
echo Server stopped.
pause
exit /b 0

:failed
echo.
echo ==================================================
echo    Something went wrong - see the messages above.
echo ==================================================
echo.
pause
exit /b 1

@echo off
title ModelBridge - Local AI API Chat
pushd "%~dp0"

echo [ModelBridge] Checking runtime...

where node >nul 2>nul
if errorlevel 1 (
  echo.
  echo [ERROR] Node.js was not found in PATH.
  echo Install Node.js and double-click this file again.
  goto :failed
)

if not exist "server.mjs" (
  echo.
  echo [ERROR] server.mjs was not found.
  echo Keep this launcher inside the project folder.
  goto :failed
)

if not exist "scripts\check-runtime.mjs" (
  echo.
  echo [ERROR] scripts\check-runtime.mjs was not found.
  echo Keep the complete project folder together.
  goto :failed
)

if not exist "scripts\choose-port.mjs" (
  echo.
  echo [ERROR] scripts\choose-port.mjs was not found.
  echo Keep the complete project folder together.
  goto :failed
)

node "scripts\check-runtime.mjs"
if errorlevel 1 goto :failed

set "MODELBRIDGE_ACTION="
for /f "tokens=1,2" %%A in ('node "scripts\choose-port.mjs"') do (
  set "MODELBRIDGE_ACTION=%%A"
  set "MODELBRIDGE_PORT=%%B"
)

if "%MODELBRIDGE_ACTION%"=="ERROR" (
  echo.
  echo [ERROR] No available local port was found.
  echo Close an older ModelBridge window or set MODELBRIDGE_PORT to a free port.
  goto :failed
)

if "%MODELBRIDGE_ACTION%"=="REUSE" (
  echo [ModelBridge] Current version is already running.
  echo [ModelBridge] URL: http://127.0.0.1:%MODELBRIDGE_PORT%
  start "" powershell.exe -NoProfile -WindowStyle Hidden -Command "Start-Process 'http://127.0.0.1:%MODELBRIDGE_PORT%'"
  goto :end
)

if not "%MODELBRIDGE_ACTION%"=="START" goto :failed
echo [ModelBridge] URL: http://127.0.0.1:%MODELBRIDGE_PORT%
echo [ModelBridge] Keep this window open while using the app.
echo.

if not defined MODELBRIDGE_NO_BROWSER (
  start "" powershell.exe -NoProfile -WindowStyle Hidden -Command "Start-Sleep -Milliseconds 1200; Start-Process 'http://127.0.0.1:%MODELBRIDGE_PORT%'"
)

node "server.mjs"
if errorlevel 1 goto :failed
goto :end

:failed
echo.
echo Startup failed. Please send a screenshot of the error above.
pause

:end
popd

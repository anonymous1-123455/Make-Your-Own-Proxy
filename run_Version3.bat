@echo off
:: Windows launcher for server.js. Double-click this file to run (requires node in PATH).
setlocal
pushd "%~dp0"
if not defined NODE_ENV (
  echo Starting Simple Search Proxy...
)
node "%~dp0server.js"
if errorlevel 1 (
  echo.
  echo Node encountered an error or exited. Press any key to close.
  pause >nul
)
popd
endlocal
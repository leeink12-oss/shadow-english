@echo off
title Shadow English - Mobile Access
cd /d "%~dp0"

where node >nul 2>nul
if errorlevel 1 goto NONODE

set HOST=0.0.0.0
set NO_OPEN=1

echo.
echo   Shadow English - phone / tablet access
echo   Keep this window open while using the app.
echo.
echo   Connect the phone to the same Wi-Fi as this computer.
echo   Open the LAN address printed below in the phone browser.
echo   If Windows Firewall asks, allow Node.js on private networks.
echo.

node "%~dp0server.js"
set "CODE=%ERRORLEVEL%"
echo.
echo   Server stopped.
pause
exit /b %CODE%

:NONODE
echo.
echo   [!] Node.js not found.
echo       Install the LTS version from https://nodejs.org
pause
exit /b 1

@echo off
title Shadow English - Local Server
cd /d "%~dp0"

where node >nul 2>nul
if errorlevel 1 goto NONODE

echo.
echo   Shadow English - starting local server, please wait...
echo   (Keep this window open while you study. Close it to stop.)
echo.
node "%~dp0server.js"
set "CODE=%ERRORLEVEL%"
echo.
echo   Server stopped.
echo.
pause
exit /b %CODE%

:NONODE
echo.
echo   [!] Node.js not found.
echo       Install the LTS version from https://nodejs.org
echo       then double-click this file again.
echo.
pause
exit /b 1

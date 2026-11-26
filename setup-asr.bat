@echo off
title Shadow English - Setup Speech Recognition
cd /d "%~dp0"

echo.
echo   ================================================
echo    Shadow English - local speech recognition setup
echo   ================================================
echo.
echo   This installs a private Python environment for
echo   turning videos into subtitles on this computer.
echo   It downloads about 500 MB and needs internet once.
echo.

where py >nul 2>nul
if errorlevel 1 goto NOPY

if exist ".venv\Scripts\python.exe" goto HAVEVENV

echo   [1/3] Creating Python environment...
py -3.11 -m venv .venv
if errorlevel 1 py -3 -m venv .venv
if not exist ".venv\Scripts\python.exe" goto VENVFAIL
goto PIP

:HAVEVENV
echo   [1/3] Python environment already exists, skipping.

:PIP
echo   [2/3] Installing recognition engine...
".venv\Scripts\python.exe" -m pip install -U pip -i https://pypi.tuna.tsinghua.edu.cn/simple
".venv\Scripts\python.exe" -m pip install faster-whisper edge-tts -i https://pypi.tuna.tsinghua.edu.cn/simple
if errorlevel 1 goto PIPFAIL

echo   [3/3] Installing GPU acceleration (optional)...
".venv\Scripts\python.exe" -m pip install nvidia-cublas-cu12 nvidia-cudnn-cu12 -i https://pypi.tuna.tsinghua.edu.cn/simple

echo.
echo   ================================================
echo    Done. You can start the app now.
echo    The first video will download the AI model
echo    once (about 1.5 GB), then it works offline.
echo   ================================================
echo.
pause
exit /b 0

:NOPY
echo.
echo   [!] Python not found.
echo       Install Python 3.11 from https://www.python.org/downloads/
echo       IMPORTANT: tick "Add Python to PATH" during install.
echo.
pause
exit /b 1

:VENVFAIL
echo.
echo   [!] Could not create the Python environment.
echo       Try installing Python 3.11 and run this again.
echo.
pause
exit /b 1

:PIPFAIL
echo.
echo   [!] Installing the recognition engine failed.
echo       Check your internet connection and run this again.
echo.
pause
exit /b 1

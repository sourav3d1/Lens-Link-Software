@echo off
setlocal enabledelayedexpansion

echo ==================================================
echo   LensLink Windows Virtual Camera Bridge
echo ==================================================
echo.

where python >nul 2>nul
if %errorlevel% neq 0 (
    echo [ERROR] Python 3.10+ is required on PATH. Download from https://www.python.org/
    pause
    exit /b 1
)

if not exist ".venv" (
    echo Creating local Python virtual environment...
    python -m venv .venv
)

call .venv\Scripts\activate.bat

echo Installing/verifying virtual camera dependencies...
pip install --quiet --upgrade pip
pip install --quiet -r requirements.txt

set /p PAIR_CODE=Enter the 6-character LensLink Pairing Code: 
set /p SERVER_URL=Server URL [Press Enter for ws://127.0.0.1:3000]: 
if "%SERVER_URL%"=="" set SERVER_URL=ws://127.0.0.1:3000

echo.
echo Starting virtual webcam bridge for room %PAIR_CODE%...
echo Keep the LensLink PC Receiver tab open with "Virtual Cam Bridge" enabled.
echo.

python lenslink_vcam.py --code %PAIR_CODE% --server %SERVER_URL%
pause

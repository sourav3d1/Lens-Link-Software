@echo off
setlocal
title LensLink Wireless Webcam — Live Virtual Camera Bridge

set "WS_ORIGIN=ws://127.0.0.1:3000"
set "APP_URL=https://ais-dev-uezvraxz5h2xsf4xr5nkjk-789221242334.asia-southeast1.run.app/?mode=desktop"

echo ================================================================
echo   LensLink Wireless Webcam — System Virtual Camera Service
echo ================================================================
echo.
set /p ROOM_CODE=Enter 6-character LensLink Session Code (from LensLink Desktop window): 
if "%ROOM_CODE%"=="" (
  echo Launching LensLink Desktop window first...
  start "" "%APP_URL%"
  pause
  exit /b 0
)

echo Starting virtual webcam bridge for session %ROOM_CODE%...
python "%~dp0client\lenslink_windows_client.py" --server "%WS_ORIGIN%/ws" --room "%ROOM_CODE%" --width 1920 --height 1080 --fps 30
pause

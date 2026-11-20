@echo off
setlocal
title LensLink Wireless Webcam — Clean Uninstaller

net session >nul 2>&1
if %errorlevel% neq 0 (
  echo Requesting Administrator privileges to cleanly unregister Virtual Webcam...
  powershell -NoProfile -Command "Start-Process -FilePath '%~f0' -Verb RunAs"
  exit /b 0
)

set "INSTALL_DIR=%~dp0"

echo [1/3] Unregistering LensLink Wireless Webcam DirectShow Driver...
if exist "%INSTALL_DIR%driver\LensLinkVirtualCam.ax" (
  regsvr32 /u /s "%INSTALL_DIR%driver\LensLinkVirtualCam.ax"
)
if exist "%INSTALL_DIR%driver\unity" (
  for /r "%INSTALL_DIR%driver\unity" %%F in (UnityCaptureFilter64.dll) do (
    regsvr32 /u /s "%%F"
  )
)

echo [2/3] Removing Windows Firewall rules...
netsh advfirewall firewall delete rule name="LensLink Wireless Webcam (LAN)" >nul 2>&1
netsh advfirewall firewall delete rule name="LensLink Wireless Webcam (mDNS)" >nul 2>&1

echo [3/3] Removing Desktop and Start Menu shortcuts...
powershell -NoProfile -ExecutionPolicy Bypass -Command ^
  "$d = Join-Path ([Environment]::GetFolderPath('Desktop')) 'LensLink Wireless Webcam.lnk'; " ^
  "$s = Join-Path ([Environment]::GetFolderPath('Programs')) 'LensLink Wireless Webcam.lnk'; " ^
  "Remove-Item -Force -ErrorAction SilentlyContinue $d, $s"

echo.
echo LensLink Wireless Webcam has been cleanly unregistered and removed from Windows.
pause

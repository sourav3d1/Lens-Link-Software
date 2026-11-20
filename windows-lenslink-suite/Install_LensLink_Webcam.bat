@echo off
setlocal EnableExtensions
title LensLink Wireless Webcam — Windows Installer

echo ================================================================
echo   LensLink Wireless Webcam — Windows 10 / 11 Installer
echo   Installs Desktop App, Virtual Camera Driver & Firewall Rules
echo ================================================================
echo.

:: Check for Administrator privileges
net session >nul 2>&1
if %errorlevel% neq 0 (
  echo Requesting Administrator privileges to register Virtual Webcam Driver...
  powershell -NoProfile -Command "Start-Process -FilePath '%~f0' -Verb RunAs"
  exit /b 0
)

set "INSTALL_DIR=%~dp0"
set "APP_URL=https://ais-dev-uezvraxz5h2xsf4xr5nkjk-789221242334.asia-southeast1.run.app/?mode=desktop"

echo [1/4] Configuring Windows Firewall for local Wi-Fi auto-discovery...
netsh advfirewall firewall delete rule name="LensLink Wireless Webcam (LAN)" >nul 2>&1
netsh advfirewall firewall add rule name="LensLink Wireless Webcam (LAN)" dir=in action=allow protocol=TCP localport=3000 profile=private >nul 2>&1
netsh advfirewall firewall delete rule name="LensLink Wireless Webcam (mDNS)" >nul 2>&1
netsh advfirewall firewall add rule name="LensLink Wireless Webcam (mDNS)" dir=in action=allow protocol=UDP localport=5353 profile=private >nul 2>&1

echo [2/4] Registering LensLink Wireless Webcam DirectShow Driver...
if exist "%INSTALL_DIR%driver\LensLinkVirtualCam.ax" (
  regsvr32 /s "%INSTALL_DIR%driver\LensLinkVirtualCam.ax"
  echo       Registered LensLinkVirtualCam.ax as "LensLink Wireless Webcam".
) else (
  echo       LensLinkVirtualCam.ax not yet compiled; installing lightweight UnityCapture DirectShow filter...
  powershell -NoProfile -ExecutionPolicy Bypass -Command ^
    "$tmp = Join-Path $env:TEMP 'lenslink_uc.zip'; " ^
    "try { Invoke-WebRequest -UseBasicParsing -Uri 'https://github.com/schellingb/UnityCapture/releases/download/v1.0/UnityCaptureFilter.zip' -OutFile $tmp; " ^
    "Expand-Archive -Path $tmp -DestinationPath '%INSTALL_DIR%driver\unity' -Force; " ^
    "$dll = Get-ChildItem '%INSTALL_DIR%driver\unity' -Recurse -Filter 'UnityCaptureFilter64.dll' | Select-Object -First 1; " ^
    "if ($dll) { regsvr32 /s $dll.FullName; Write-Host '       Registered DirectShow virtual camera filter.' } } catch { Write-Host '       Offline mode: build driver\CMakeLists.txt with Visual Studio to register LensLinkVirtualCam.ax.' }"
)

echo [3/4] Installing Python runtime dependencies (if Python 3 is installed)...
where python >nul 2>&1
if %errorlevel% equ 0 (
  python -m pip install --quiet -r "%INSTALL_DIR%requirements.txt"
) else (
  echo       Python 3 not detected. Desktop shortcut will still launch LensLink Desktop Client.
)

echo [4/4] Creating Desktop & Start Menu shortcuts for LensLink Wireless Webcam...
set "BROWSER_EXE="
if exist "%ProgramFiles(x86)%\Microsoft\Edge\Application\msedge.exe" set "BROWSER_EXE=%ProgramFiles(x86)%\Microsoft\Edge\Application\msedge.exe"
if not defined BROWSER_EXE if exist "%ProgramFiles%\Microsoft\Edge\Application\msedge.exe" set "BROWSER_EXE=%ProgramFiles%\Microsoft\Edge\Application\msedge.exe"
if not defined BROWSER_EXE if exist "%ProgramFiles%\Google\Chrome\Application\chrome.exe" set "BROWSER_EXE=%ProgramFiles%\Google\Chrome\Application\chrome.exe"
if not defined BROWSER_EXE if exist "%ProgramFiles(x86)%\Google\Chrome\Application\chrome.exe" set "BROWSER_EXE=%ProgramFiles(x86)%\Google\Chrome\Application\chrome.exe"

if defined BROWSER_EXE (
  powershell -NoProfile -ExecutionPolicy Bypass -Command ^
    "$ws = New-Object -ComObject WScript.Shell; " ^
    "$desktop = Join-Path ([Environment]::GetFolderPath('Desktop')) 'LensLink Wireless Webcam.lnk'; " ^
    "$start = Join-Path ([Environment]::GetFolderPath('Programs')) 'LensLink Wireless Webcam.lnk'; " ^
    "foreach ($p in @($desktop, $start)) { $s = $ws.CreateShortcut($p); $s.TargetPath = '%BROWSER_EXE%'; $s.Arguments = '--app=%APP_URL% --new-window'; $s.Description = 'LensLink Wireless Webcam'; $s.Save() }"
)

echo.
echo ================================================================
echo   Installation Complete!
echo   - Open "LensLink Wireless Webcam" from your Desktop shortcut.
echo   - Run Start_LensLink_Webcam.bat to feed live video into Windows apps
echo     (Google Meet, Zoom, Teams, WhatsApp Desktop, OBS, VLC, Chrome, Edge).
echo ================================================================
echo.
pause

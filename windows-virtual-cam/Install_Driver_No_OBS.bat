@echo off
setlocal

echo ==================================================
echo   LensLink Standalone Virtual Camera Driver Setup
echo   (DirectShow Filter — No OBS Studio Required)
echo ==================================================
echo.
echo Downloading and registering the standalone DirectShow virtual camera driver...
echo You will see one Windows Administrator prompt to register the camera driver.
echo.

powershell -NoProfile -ExecutionPolicy Bypass -Command ^
  "$ErrorActionPreference = 'Stop';" ^
  "$ProgressPreference = 'SilentlyContinue';" ^
  "$zip = Join-Path $env:TEMP 'lenslink-unitycapture.zip';" ^
  "$extract = Join-Path $env:TEMP 'lenslink-unitycapture';" ^
  "$dest = Join-Path $env:LOCALAPPDATA 'LensLink\Driver';" ^
  "New-Item -ItemType Directory -Force -Path $dest | Out-Null;" ^
  "Invoke-WebRequest -Uri 'https://github.com/schellingb/UnityCapture/archive/refs/heads/master.zip' -OutFile $zip -UseBasicParsing;" ^
  "if (Test-Path $extract) { Remove-Item $extract -Recurse -Force };" ^
  "Expand-Archive -Path $zip -DestinationPath $extract -Force;" ^
  "Copy-Item (Join-Path $extract 'UnityCapture-master\Install\UnityCaptureFilter64.dll') $dest -Force;" ^
  "Copy-Item (Join-Path $extract 'UnityCapture-master\Install\UnityCaptureFilter32.dll') $dest -Force;" ^
  "$dll64 = Join-Path $dest 'UnityCaptureFilter64.dll';" ^
  "$dll32 = Join-Path $dest 'UnityCaptureFilter32.dll';" ^
  "$syswow = Join-Path $env:WINDIR 'SysWOW64\regsvr32.exe';" ^
  "$cmd = '/c regsvr32 /s \"' + $dll64 + '\"';" ^
  "if (Test-Path $syswow) { $cmd += ' && \"' + $syswow + '\" /s \"' + $dll32 + '\"' };" ^
  "$p = Start-Process -FilePath 'cmd.exe' -ArgumentList $cmd -Verb RunAs -Wait -PassThru;" ^
  "if ($p.ExitCode -ne 0) { throw ('Driver registration failed with exit code ' + $p.ExitCode) }"

if %errorlevel% neq 0 (
    echo.
    echo [ERROR] Could not install the standalone DirectShow driver.
    echo Make sure you have internet access and accept the Windows Administrator prompt.
    pause
    exit /b 1
)

echo.
echo [OK] Standalone DirectShow driver installed!
echo Device name in Zoom / Teams / Windows Camera: "Unity Video Capture"
echo No OBS Studio is needed. You can now run start_virtual_cam.bat.
echo.
pause
exit /b 0

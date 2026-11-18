@echo off
setlocal

echo Unregistering LensLink standalone DirectShow driver...
powershell -NoProfile -ExecutionPolicy Bypass -Command ^
  "$dest = Join-Path $env:LOCALAPPDATA 'LensLink\Driver';" ^
  "$dll64 = Join-Path $dest 'UnityCaptureFilter64.dll';" ^
  "$dll32 = Join-Path $dest 'UnityCaptureFilter32.dll';" ^
  "$syswow = Join-Path $env:WINDIR 'SysWOW64\regsvr32.exe';" ^
  "$cmd = '/c if exist \"' + $dll64 + '\" regsvr32 /u /s \"' + $dll64 + '\"';" ^
  "if (Test-Path $syswow) { $cmd += ' & if exist \"' + $dll32 + '\" \"' + $syswow + '\" /u /s \"' + $dll32 + '\"' };" ^
  "Start-Process -FilePath 'cmd.exe' -ArgumentList $cmd -Verb RunAs -Wait"

echo Done.
pause

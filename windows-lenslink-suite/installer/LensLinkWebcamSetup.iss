; LensLink Wireless Webcam — Windows Installer Script (Inno Setup 6)
; Builds a signed Windows installer that installs the LensLink desktop client,
; registers the DirectShow virtual webcam driver ("LensLink Wireless Webcam"),
; opens the Windows Firewall port for local Wi-Fi discovery, creates shortcuts,
; and cleanly unregisters the virtual webcam on uninstall.

#define MyAppName "LensLink Wireless Webcam"
#define MyAppVersion "2.0.0"
#define MyAppPublisher "LensLink Imaging Systems"
#define MyAppExeName "Start_LensLink_Webcam.bat"

[Setup]
AppId={{8E4F1C3A-7B9D-4A2E-9F14-6C5B2D8E3A10}
AppName={#MyAppName}
AppVersion={#MyAppVersion}
AppPublisher={#MyAppPublisher}
DefaultDirName={autopf}\LensLink Wireless Webcam
DefaultGroupName={#MyAppName}
PrivilegesRequired=admin
ArchitecturesAllowed=x64compatible
ArchitecturesInstallIn64BitMode=x64compatible
OutputBaseFilename=LensLink_Wireless_Webcam_Setup_2.0.0
Compression=lzma
SolidCompression=yes
WizardStyle=modern
UninstallDisplayName={#MyAppName}

[Tasks]
Name: "desktopicon"; Description: "Create a &Desktop shortcut"; GroupDescription: "Additional icons:"
Name: "firewall"; Description: "Allow LensLink local Wi-Fi discovery through Windows Firewall"; GroupDescription: "Network:"

[Files]
Source: "..\Start_LensLink_Webcam.bat"; DestDir: "{app}"; Flags: ignoreversion
Source: "..\Install_LensLink_Webcam.bat"; DestDir: "{app}"; Flags: ignoreversion
Source: "..\Uninstall_LensLink_Webcam.bat"; DestDir: "{app}"; Flags: ignoreversion
Source: "..\requirements.txt"; DestDir: "{app}"; Flags: ignoreversion
Source: "..\client\lenslink_windows_client.py"; DestDir: "{app}\client"; Flags: ignoreversion
Source: "..\driver\*"; DestDir: "{app}\driver"; Flags: ignoreversion recursesubdirs
; When LensLinkVirtualCam.ax is compiled via CMake/MSVC x64, include it here:
; Source: "..\driver\build\Release\LensLinkVirtualCam.ax"; DestDir: "{app}\driver"; Flags: ignoreversion regserver 64bit

[Icons]
Name: "{group}\{#MyAppName}"; Filename: "{app}\{#MyAppExeName}"
Name: "{group}\Uninstall {#MyAppName}"; Filename: "{uninstallexe}"
Name: "{autodesktop}\{#MyAppName}"; Filename: "{app}\{#MyAppExeName}"; Tasks: desktopicon

[Run]
; Register compiled DirectShow filter if present
Filename: "{sys}\regsvr32.exe"; Parameters: "/s ""{app}\driver\LensLinkVirtualCam.ax"""; Flags: runhidden; Check: FileExists(ExpandConstant('{app}\driver\LensLinkVirtualCam.ax'))
; Allow mDNS & LAN WebRTC signaling through Windows Firewall
Filename: "{sys}\netsh.exe"; Parameters: "advfirewall firewall add rule name=""LensLink Wireless Webcam (LAN)"" dir=in action=allow protocol=TCP localport=3000 profile=private"; Flags: runhidden; Tasks: firewall
Filename: "{sys}\netsh.exe"; Parameters: "advfirewall firewall add rule name=""LensLink Wireless Webcam (mDNS)"" dir=in action=allow protocol=UDP localport=5353 profile=private"; Flags: runhidden; Tasks: firewall
Filename: "{app}\{#MyAppExeName}"; Description: "Launch {#MyAppName}"; Flags: nowait postinstall skipifsilent shellexec

[UninstallRun]
; Cleanly unregister LensLink Wireless Webcam from Windows DirectShow so it disappears immediately
Filename: "{sys}\regsvr32.exe"; Parameters: "/u /s ""{app}\driver\LensLinkVirtualCam.ax"""; Flags: runhidden; Check: FileExists(ExpandConstant('{app}\driver\LensLinkVirtualCam.ax'))
Filename: "{sys}\netsh.exe"; Parameters: "advfirewall firewall delete rule name=""LensLink Wireless Webcam (LAN)"""; Flags: runhidden
Filename: "{sys}\netsh.exe"; Parameters: "advfirewall firewall delete rule name=""LensLink Wireless Webcam (mDNS)"""; Flags: runhidden

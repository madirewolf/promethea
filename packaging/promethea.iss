; Inno Setup script for Promethea. Build with packaging\build.ps1, which passes /DAppVersion=...
#ifndef AppVersion
  #define AppVersion "0.0.0"
#endif

[Setup]
AppId={{6F1C9E52-3A4B-4D8E-9C7A-5B2E1F0D8A3C}
AppName=Promethea
AppVersion={#AppVersion}
AppVerName=Promethea {#AppVersion}
AppPublisher=Promethea
VersionInfoVersion={#AppVersion}
DefaultDirName={autopf}\Promethea
DisableProgramGroupPage=yes
; Installs for the current user without asking for admin rights; the first page offers all users.
PrivilegesRequired=lowest
PrivilegesRequiredOverridesAllowed=dialog
ArchitecturesAllowed=x64compatible
ArchitecturesInstallIn64BitMode=x64compatible
MinVersion=10.0
OutputDir=..\dist
OutputBaseFilename=Promethea-{#AppVersion}-Setup
SetupIconFile=..\promethea\assets\promethea.ico
UninstallDisplayIcon={app}\Promethea.exe
UninstallDisplayName=Promethea
LicenseFile=..\LICENSE
WizardStyle=modern
Compression=lzma2/ultra64
SolidCompression=yes
; Restart Manager closes a running Promethea before files are replaced.
CloseApplications=yes
ChangesAssociations=yes

[Tasks]
Name: "desktopicon"; Description: "{cm:CreateDesktopIcon}"; GroupDescription: "{cm:AdditionalIcons}"
Name: "torrentfiles"; Description: "Open .torrent files with Promethea"; GroupDescription: "Open with Promethea:"
Name: "magnetlinks"; Description: "Open magnet links with Promethea"; GroupDescription: "Open with Promethea:"

[InstallDelete]
; The previous version's bundled libraries, so nothing stale is left beside the new ones.
Type: filesandordirs; Name: "{app}\_internal"

[Files]
Source: "..\dist\Promethea\*"; DestDir: "{app}"; Flags: ignoreversion recursesubdirs createallsubdirs
Source: "..\LICENSE"; DestDir: "{app}"; DestName: "LICENSE.txt"; Flags: ignoreversion
Source: "..\build\THIRD-PARTY-NOTICES.txt"; DestDir: "{app}"; Flags: ignoreversion

[Icons]
Name: "{autoprograms}\Promethea"; Filename: "{app}\Promethea.exe"
Name: "{autodesktop}\Promethea"; Filename: "{app}\Promethea.exe"; Tasks: desktopicon

[Registry]
; The same keys Promethea's own "associate" setting writes (promethea/platform.py).
Root: HKA; Subkey: "Software\Classes\Promethea.Torrent"; ValueType: string; ValueData: "Torrent file"; Flags: uninsdeletekey; Tasks: torrentfiles
Root: HKA; Subkey: "Software\Classes\Promethea.Torrent\DefaultIcon"; ValueType: string; ValueData: """{app}\Promethea.exe"",0"; Tasks: torrentfiles
Root: HKA; Subkey: "Software\Classes\Promethea.Torrent\shell\open\command"; ValueType: string; ValueData: """{app}\Promethea.exe"" ""%1"""; Tasks: torrentfiles
Root: HKA; Subkey: "Software\Classes\.torrent"; ValueType: string; ValueData: "Promethea.Torrent"; Flags: uninsdeletevalue; Tasks: torrentfiles
Root: HKA; Subkey: "Software\Classes\.torrent"; ValueType: string; ValueName: "Content Type"; ValueData: "application/x-bittorrent"; Tasks: torrentfiles
Root: HKA; Subkey: "Software\Classes\.torrent\OpenWithProgids"; ValueType: string; ValueName: "Promethea.Torrent"; ValueData: ""; Flags: uninsdeletevalue; Tasks: torrentfiles
Root: HKA; Subkey: "Software\Classes\magnet"; ValueType: string; ValueData: "URL:Magnet link"; Flags: uninsdeletekey; Tasks: magnetlinks
Root: HKA; Subkey: "Software\Classes\magnet"; ValueType: string; ValueName: "URL Protocol"; ValueData: ""; Tasks: magnetlinks
Root: HKA; Subkey: "Software\Classes\magnet\DefaultIcon"; ValueType: string; ValueData: """{app}\Promethea.exe"",0"; Tasks: magnetlinks
Root: HKA; Subkey: "Software\Classes\magnet\shell\open\command"; ValueType: string; ValueData: """{app}\Promethea.exe"" ""%1"""; Tasks: magnetlinks

[Run]
Filename: "{app}\Promethea.exe"; Description: "{cm:LaunchProgram,Promethea}"; Flags: nowait postinstall skipifsilent

[Code]
const
  WebView2Key = 'Microsoft\EdgeUpdate\Clients\{F3017226-FE2A-4295-8BDF-00C3A9A7E4C5}';

function HasWebView2(Root: Integer; Key: String): Boolean;
var
  Version: String;
begin
  Result := RegQueryStringValue(Root, Key, 'pv', Version) and (Version <> '') and (Version <> '0.0.0.0');
end;

function InitializeSetup: Boolean;
begin
  Result := True;
  // Promethea's window is a WebView2 page. Windows 11 always has the runtime; some Windows 10 PCs don't.
  if not (HasWebView2(HKLM32, 'SOFTWARE\' + WebView2Key) or HasWebView2(HKCU, 'Software\' + WebView2Key)) then
    Result := MsgBox('Promethea needs the Microsoft Edge WebView2 Runtime, which this PC doesn''t have.' + #13#10#13#10 +
      'Get it free from Microsoft (search for "WebView2 Runtime"), then run this setup again.' + #13#10#13#10 +
      'Install Promethea anyway?', mbConfirmation, MB_YESNO) = IDYES;
end;

; Inno Setup script for Remote Whisper (Windows). See issue 168.
;
;   iscc /DAppVersion=<version> /DSourceDir=<folder made by build.ps1> /DOutputDir=<out> installer.iss
;
; - Per-user install (no administrator rights): %LOCALAPPDATA%\Programs\Remote Whisper
; - Start menu shortcut, optional desktop shortcut, optional "start at sign-in" task
; - The data folder (~/.remote-whisper) is never touched by the installer or the uninstaller
; - Not code-signed: Windows SmartScreen will show a warning (see docs/install-windows.md)

#ifndef AppVersion
  #define AppVersion "0.0.0"
#endif
#ifndef SourceDir
  #error SourceDir is required (the app folder made by build.ps1)
#endif
#ifndef OutputDir
  #define OutputDir "out"
#endif

#define AppName "Remote Whisper"
; Starts without a console window. The status is shown in the task tray icon.
#define AppExe "python\pythonw.exe"
#define AppArgs "-m remote_whisper"

[Setup]
; Keep this GUID fixed: it identifies the app for upgrades and uninstall.
AppId={{6B0C3F7E-5C1E-4D1B-9A6B-2D5E8B7A1168}
AppName={#AppName}
AppVersion={#AppVersion}
AppPublisher=Studio-Takumi
AppPublisherURL=https://github.com/Studio-Takumi/remote-whisper
DefaultDirName={autopf}\{#AppName}
DefaultGroupName={#AppName}
DisableProgramGroupPage=yes
PrivilegesRequired=lowest
ArchitecturesAllowed=x64compatible
ArchitecturesInstallIn64BitMode=x64compatible
OutputDir={#OutputDir}
OutputBaseFilename=remote-whisper-setup-{#AppVersion}
Compression=lzma2/fast
SolidCompression=no
WizardStyle=modern
UninstallDisplayName={#AppName}
CloseApplications=no

[Languages]
Name: "english"; MessagesFile: "compiler:Default.isl"
#if FileExists(CompilerPath + "Languages\Japanese.isl")
Name: "japanese"; MessagesFile: "compiler:Languages\Japanese.isl"
#endif

[Tasks]
Name: "startup"; Description: "Start {#AppName} when I sign in to Windows"; Flags: unchecked
Name: "desktopicon"; Description: "Create a desktop shortcut"; Flags: unchecked

[Files]
Source: "{#SourceDir}\*"; DestDir: "{app}"; Flags: ignoreversion recursesubdirs createallsubdirs

[Icons]
Name: "{autoprograms}\{#AppName}"; Filename: "{app}\{#AppExe}"; Parameters: "{#AppArgs}"; WorkingDir: "{app}"; Comment: "Pseudo-real-time transcription"
Name: "{autodesktop}\{#AppName}"; Filename: "{app}\{#AppExe}"; Parameters: "{#AppArgs}"; WorkingDir: "{app}"; Tasks: desktopicon

[Registry]
; Start at sign-in (chosen in the installer). Removed by the uninstaller.
Root: HKCU; Subkey: "Software\Microsoft\Windows\CurrentVersion\Run"; ValueType: string; ValueName: "RemoteWhisper"; ValueData: """{app}\{#AppExe}"" {#AppArgs}"; Flags: uninsdeletevalue; Tasks: startup

[Run]
Filename: "{app}\{#AppExe}"; Parameters: "{#AppArgs}"; WorkingDir: "{app}"; Description: "Start {#AppName} now"; Flags: nowait postinstall skipifsilent

[UninstallDelete]
; Files created after the install (byte-code caches and so on). The data folder is outside {app}.
Type: filesandordirs; Name: "{app}"

[Code]
// Stop the server and cloudflared that run from the install folder, so that files can be replaced or removed.
procedure StopRunningApp();
var
  ResultCode: Integer;
  Command: String;
begin
  Command := '-NoProfile -NonInteractive -Command "Get-CimInstance Win32_Process | ' +
    'Where-Object { $_.ExecutablePath -and $_.ExecutablePath.StartsWith(''' + ExpandConstant('{app}') + '\'', ' +
    '[System.StringComparison]::OrdinalIgnoreCase) } | ' +
    'ForEach-Object { Stop-Process -Id $_.ProcessId -Force }"';
  Exec('powershell.exe', Command, '', SW_HIDE, ewWaitUntilTerminated, ResultCode);
end;

function PrepareToInstall(var NeedsRestart: Boolean): String;
begin
  StopRunningApp();
  Result := '';
end;

function InitializeUninstall(): Boolean;
begin
  StopRunningApp();
  Result := True;
end;

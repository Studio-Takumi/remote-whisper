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
; Files created after the install (byte-code caches, packages added later with pip). Only the
; folders this installer owns are removed. {app} itself is removed only when it is empty, so a
; folder the user chose (such as an existing one) is never wiped.
; The data folder (~/.remote-whisper) is outside {app} and is never touched.
Type: filesandordirs; Name: "{app}\python"
Type: filesandordirs; Name: "{app}\web"

[Code]
// Stop the server and cloudflared that run from the install folder, so that files can be replaced or removed.
// The uninstaller itself (unins*.exe) also lives there, so it must be left alone.
procedure StopRunningApp();
var
  ResultCode: Integer;
  AppDir: String;
  Command: String;
begin
  // Double a single quote so that a user name such as O'Brien does not break the PowerShell string.
  AppDir := ExpandConstant('{app}');
  StringChangeEx(AppDir, '''', '''''', True);
  Command := '-NoProfile -NonInteractive -Command "Get-CimInstance Win32_Process | ' +
    'Where-Object { $_.ExecutablePath -and $_.Name -notlike ''unins*'' -and $_.ExecutablePath.StartsWith(''' + AppDir + '\'', ' +
    '[System.StringComparison]::OrdinalIgnoreCase) } | ' +
    'ForEach-Object { Stop-Process -Id $_.ProcessId -Force }"';
  if not Exec('powershell.exe', Command, '', SW_HIDE, ewWaitUntilTerminated, ResultCode) or (ResultCode <> 0) then
    Log('Could not stop the running app (exit code ' + IntToStr(ResultCode) + ')');
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

// True if the folder exists, has something in it, and is not a previous install of this app.
function IsForeignNonEmptyDir(Dir: String): Boolean;
var
  FindRec: TFindRec;
begin
  Result := False;
  if not DirExists(Dir) then Exit;
  if FileExists(AddBackslash(Dir) + 'bundle.json') then Exit;
  if FindFirst(AddBackslash(Dir) + '*', FindRec) then
  begin
    try
      repeat
        if (FindRec.Name <> '.') and (FindRec.Name <> '..') then
        begin
          Result := True;
          Exit;
        end;
      until not FindNext(FindRec);
    finally
      FindClose(FindRec);
    end;
  end;
end;

function NextButtonClick(CurPageID: Integer): Boolean;
begin
  Result := True;
  // An existing folder that has other files: offer a sub folder instead (not asked in silent installs).
  if (CurPageID = wpSelectDir) and IsForeignNonEmptyDir(WizardDirValue) then
  begin
    if MsgBox('The folder already contains other files:' + #13#10 + WizardDirValue + #13#10#13#10 +
      'Install into a "{#AppName}" sub folder instead?', mbConfirmation, MB_YESNO) = IDYES then
    begin
      WizardForm.DirEdit.Text := AddBackslash(WizardDirValue) + '{#AppName}';
      Result := False;
    end;
  end;
end;

// Re-installing without the "start at sign-in" task removes the entry made by an earlier install.
procedure CurStepChanged(CurStep: TSetupStep);
begin
  if (CurStep = ssPostInstall) and not WizardIsTaskSelected('startup') then
    RegDeleteValue(HKEY_CURRENT_USER, 'Software\Microsoft\Windows\CurrentVersion\Run', 'RemoteWhisper');
end;

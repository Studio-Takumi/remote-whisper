; Inno Setup script for Remote Whisper (Windows). See issue 168.
;
;   iscc /DAppVersion=<version> /DSourceDir=<folder made by build.ps1> /DOutputDir=<out> installer.iss
;
; - Per-user install (no administrator rights): %LOCALAPPDATA%\Programs\Remote Whisper
; - Start menu shortcut, optional desktop shortcut, optional "start at sign-in" task
; - The data folder (~/.remote-whisper) is never touched by the installer or the uninstaller
; - Not code-signed: Windows SmartScreen will show a warning (see docs/install-windows.md)
; - The wizard texts are Japanese (written for people who are not familiar with technology). Japanese.isl
;   is the first language, so it is used whatever the language of Windows is (LanguageDetectionMethod=none)
; - The icon (icon\remote-whisper.ico) is made from the logo by make-icon.py (issue 290)

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
#define AppArgs "-m remote_whisper --auto-port"

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
SetupIconFile=icon\remote-whisper.ico
UninstallDisplayIcon={app}\remote-whisper.ico
LanguageDetectionMethod=none
ShowLanguageDialog=no
CloseApplications=no

[Languages]
; The first language is the one that is used (Japanese when this Inno Setup has it)
#if FileExists(CompilerPath + "Languages\Japanese.isl")
Name: "japanese"; MessagesFile: "compiler:Languages\Japanese.isl"
#endif
Name: "english"; MessagesFile: "compiler:Default.isl"

[Messages]
SelectTasksLabel2=必要なものを選んでから、「次へ」を押してください

[CustomMessages]
StartupTask=ログオン時に自動で起動
DesktopTask=デスクトップにショートカットを作成
StartupGroup=起動の設定
RunNow=Remote Whisper を今すぐ起動
ShortcutComment=リアルタイムの文字起こし
FolderNotEmpty=このフォルダには、すでにほかのファイルがあります%n%n%1%n%n「{#AppName}」フォルダを作って、その中にインストールしますか
DataPageTitle=データの保存場所
DataPageDescription=録音と文字起こしの記録の保存先です
DataPageBody=録音と文字起こしの記録は、次のフォルダに保存します%n%n%1%n%nアンインストールしても、このフォルダは消えません%n記録も消したいときは、アンインストールのあとで、このフォルダを自分で削除してください
UninstalledBody=アンインストールしました%n%n録音と文字起こしの記録は、次のフォルダに残してあります%n%n%1%n%n不要なときは、このフォルダを自分で削除してください

[Tasks]
Name: "startup"; Description: "{cm:StartupTask}"; GroupDescription: "{cm:StartupGroup}"; Flags: unchecked
Name: "desktopicon"; Description: "{cm:DesktopTask}"; Flags: unchecked

[Files]
Source: "{#SourceDir}\*"; DestDir: "{app}"; Flags: ignoreversion recursesubdirs createallsubdirs
Source: "{#SourcePath}icon\remote-whisper.ico"; DestDir: "{app}"; Flags: ignoreversion

[Icons]
Name: "{autoprograms}\{#AppName}"; Filename: "{app}\{#AppExe}"; Parameters: "{#AppArgs}"; WorkingDir: "{app}"; IconFilename: "{app}\remote-whisper.ico"; Comment: "{cm:ShortcutComment}"
Name: "{autodesktop}\{#AppName}"; Filename: "{app}\{#AppExe}"; Parameters: "{#AppArgs}"; WorkingDir: "{app}"; IconFilename: "{app}\remote-whisper.ico"; Tasks: desktopicon

[Registry]
; Start at sign-in (chosen in the installer). Removed by the uninstaller.
Root: HKCU; Subkey: "Software\Microsoft\Windows\CurrentVersion\Run"; ValueType: string; ValueName: "RemoteWhisper"; ValueData: """{app}\{#AppExe}"" {#AppArgs}"; Flags: uninsdeletevalue; Tasks: startup

[Run]
Filename: "{app}\{#AppExe}"; Parameters: "{#AppArgs}"; WorkingDir: "{app}"; Description: "{cm:RunNow}"; Flags: nowait postinstall skipifsilent

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
    if MsgBox(FmtMessage(CustomMessage('FolderNotEmpty'), [WizardDirValue]), mbConfirmation, MB_YESNO) = IDYES then
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

// The data folder (the same one the app uses: REMOTE_WHISPER_HOME, or .remote-whisper in the user folder).
function DataDir(): String;
begin
  Result := GetEnv('REMOTE_WHISPER_HOME');
  if Result = '' then
    Result := ExpandConstant('{%USERPROFILE}\.remote-whisper');
end;

// Tell where the records are kept, and that uninstalling does not remove them.
procedure InitializeWizard();
begin
  CreateOutputMsgPage(wpSelectTasks, CustomMessage('DataPageTitle'), CustomMessage('DataPageDescription'),
    FmtMessage(CustomMessage('DataPageBody'), [DataDir()]));
end;

procedure CurUninstallStepChanged(CurUninstallStep: TUninstallStep);
begin
  if (CurUninstallStep = usDone) and (not UninstallSilent()) and DirExists(DataDir()) then
    MsgBox(FmtMessage(CustomMessage('UninstalledBody'), [DataDir()]), mbInformation, MB_OK);
end;

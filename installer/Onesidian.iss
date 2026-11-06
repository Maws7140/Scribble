; Onesidian's ink helper installer: for the current user only (no admin prompt), into %LOCALAPPDATA%\Programs\Onesidian,
; where the plugin looks for it. Built by build.ps1, once per architecture.
;   iscc /DAppVersion=1.0.0 /DArch=arm64 /DSource=..\helper\publish-arm64 Onesidian.iss

#ifndef AppVersion
  #define AppVersion "0.0.0"
#endif
#ifndef Arch
  #define Arch "x64"
#endif
#ifndef Source
  #define Source "..\helper\publish"
#endif

[Setup]
AppId={{49E864C6-8CA3-4040-B7F9-AC907FDE7847}
AppName=Onesidian ink helper
AppPublisher=Maws7140
AppPublisherURL=https://github.com/Maws7140/Onesidian
AppVersion={#AppVersion}
AppVerName=Onesidian ink helper {#AppVersion}
DefaultDirName={localappdata}\Programs\Onesidian
; Always there: it's where the plugin looks.
UsePreviousAppDir=no
DisableDirPage=yes
DisableProgramGroupPage=yes
DisableReadyPage=yes
PrivilegesRequired=lowest
; Only on its own kind of Windows: the ARM build on ARM, the x64 build on x64 (not emulated on ARM).
#if Arch == "arm64"
ArchitecturesAllowed=arm64
ArchitecturesInstallIn64BitMode=arm64
#else
ArchitecturesAllowed=x64os
ArchitecturesInstallIn64BitMode=x64os
#endif
MinVersion=10.0.17763
OutputDir=output
OutputBaseFilename=Onesidian-helper-{#AppVersion}-{#Arch}
Compression=lzma2/ultra64
SolidCompression=yes
; Obsidian keeps the helper running: close it to replace it, and let the plugin start the new one.
CloseApplications=force
RestartApplications=no
UninstallDisplayName=Onesidian ink helper
UninstallDisplayIcon={app}\InkOverlay.exe
WizardStyle=modern

[Files]
; Its log and the backups of ink it replaced when pulling from OneNote stay across updates and uninstalls.
Source: "{#Source}\*"; DestDir: "{app}"; Excludes: "helper.log*,backups,*.pdb,*.old"; Flags: ignoreversion recursesubdirs createallsubdirs

[Messages]
FinishedLabelNoIcons=The ink helper is installed. Onesidian picks it up within a few seconds; nothing else to do.

[Code]
// While installing or uninstalling, a ".updating" file in the helper's folder tells the plugin to stop its helper
// (it saves on the way out) and not to start one until the file's gone (plugin/src/helperinstall.ts). Without it
// the plugin restarts a helper the moment it's closed, and the new one locks the files being replaced.
var
  MarkerPath: String;

// The helpers running from this folder (not development builds elsewhere), by process id.
function HelperPids(): TArrayOfInteger;
var
  Locator, Service, Procs, P: Variant;
  I, N: Integer;
  Dir, Exe: String;
begin
  SetArrayLength(Result, 0);
  Dir := Lowercase(AddBackslash(ExpandConstant('{app}')));
  try
    Locator := CreateOleObject('WbemScripting.SWbemLocator');
    Service := Locator.ConnectServer('.', 'root\CIMV2');
    Procs := Service.ExecQuery('SELECT ProcessId, ExecutablePath FROM Win32_Process WHERE Name = ''InkOverlay.exe''');
    for I := 0 to Procs.Count - 1 do
    begin
      P := Procs.ItemIndex(I);
      if not VarIsNull(P.ExecutablePath) then
      begin
        Exe := P.ExecutablePath;
        if Pos(Dir, Lowercase(Exe)) = 1 then
        begin
          N := GetArrayLength(Result);
          SetArrayLength(Result, N + 1);
          Result[N] := P.ProcessId;
        end;
      end;
    end;
  except
    Log('Listing running helpers failed: ' + GetExceptionMessage);
  end;
end;

// Ask the plugin to stop the helper, give it 10 s to save and exit, then stop any that's left.
procedure StopHelpers();
var
  I, Code: Integer;
  Pids: TArrayOfInteger;
begin
  ForceDirectories(ExpandConstant('{app}'));
  MarkerPath := ExpandConstant('{app}\.updating');
  SaveStringToFile(MarkerPath, 'Onesidian helper installer', False);
  for I := 1 to 40 do
  begin
    if GetArrayLength(HelperPids()) = 0 then
      Exit;
    Sleep(250);
  end;
  Pids := HelperPids();
  for I := 0 to GetArrayLength(Pids) - 1 do
  begin
    Log('Helper ' + IntToStr(Pids[I]) + ' still running; stopping it');
    Exec(ExpandConstant('{sys}\taskkill.exe'), '/F /PID ' + IntToStr(Pids[I]), '', SW_HIDE, ewWaitUntilTerminated, Code);
  end;
  for I := 1 to 20 do
  begin
    if GetArrayLength(HelperPids()) = 0 then
      Exit;
    Sleep(250);
  end;
end;

procedure ClearMarker();
begin
  if (MarkerPath <> '') and FileExists(MarkerPath) then
    DeleteFile(MarkerPath);
end;

function PrepareToInstall(var NeedsRestart: Boolean): String;
begin
  StopHelpers();
  Result := '';
end;

procedure CurStepChanged(CurStep: TSetupStep);
begin
  if CurStep = ssPostInstall then
    ClearMarker();
end;

// Also after a failed or cancelled install, so the plugin goes back to the helper that's there.
procedure DeinitializeSetup();
begin
  ClearMarker();
end;

procedure CurUninstallStepChanged(CurUninstallStep: TUninstallStep);
begin
  if CurUninstallStep = usUninstall then
    StopHelpers();
  if CurUninstallStep = usPostUninstall then
  begin
    ClearMarker();
    RemoveDir(ExpandConstant('{app}'));
  end;
end;

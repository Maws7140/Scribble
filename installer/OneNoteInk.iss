; The ink helper's installer: for the current user only (no admin prompt), into %LOCALAPPDATA%\Programs\OneNote Ink,
; where the plugin looks for it. Built by build.ps1, once per architecture.
;   iscc /DAppVersion=0.0.1 /DArch=arm64 /DSource=..\helper\publish-arm64 OneNoteInk.iss

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
AppName=OneNote Ink helper
AppVersion={#AppVersion}
AppVerName=OneNote Ink helper {#AppVersion}
DefaultDirName={localappdata}\Programs\OneNote Ink
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
OutputBaseFilename=OneNoteInkHelper-{#AppVersion}-{#Arch}
Compression=lzma2/ultra64
SolidCompression=yes
; Obsidian keeps the helper running: close it to replace it, and let the plugin start the new one.
CloseApplications=force
RestartApplications=no
UninstallDisplayName=OneNote Ink helper
UninstallDisplayIcon={app}\InkOverlay.exe
WizardStyle=modern

[Files]
; Its log and the backups of ink it replaced when pulling from OneNote stay across updates and uninstalls.
Source: "{#Source}\*"; DestDir: "{app}"; Excludes: "helper.log*,backups,*.pdb,*.old"; Flags: ignoreversion recursesubdirs createallsubdirs

[Messages]
FinishedLabelNoIcons=The ink helper is installed. OneNote Ink in Obsidian picks it up within a few seconds; nothing else to do.

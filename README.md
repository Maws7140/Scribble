# Scribble

Write and draw on your Obsidian notes with a pen, using Windows Ink (the same inking OneNote uses), and keep notes and ink in sync with OneNote.

Write on any note, canvas, PDF or picture. Each note can get its own OneNote page: text and ink go to OneNote, and edits made in OneNote come back to the note.

## Features

- Pen, pencil, highlighter and effect pens; eraser, lasso, ruler, shapes, laser pointer, ink replay
- Ink stays with its text as you type, scroll and switch views
- Scribble to erase, draw-and-hold to make clean shapes
- Ink to Text, Ink to Math (solve, steps, graphs, practice quizzes), handwriting search
- Ruled lines and grids on notes and canvases
- Background two-way sync with OneNote (text, ink and equations)
- Choose which folders, tags or notes get the ink tools
- Obsidian's **Export to PDF** includes the note's ink, with text and handwriting scaled together to fit the paper

## Requirements

- Windows 10 (1809 or later) or Windows 11, x64 or ARM, with a pen or touchscreen
- Obsidian 1.7.2 or later (desktop)
- For syncing: OneNote for Windows (desktop)

## Install

1. Install **Scribble** from Obsidian's Community plugins and enable it.
2. Install the ink helper. Scribble asks for it on first start, with a link to its download. Or get it from the [latest release](https://github.com/Maws7140/Scribble/releases/latest): `Scribble-helper-<version>-arm64.exe` for ARM PCs (such as Surface Pro X or Copilot+ PCs), `-x64.exe` for the rest. It installs for you alone, without an admin prompt. Scribble picks it up within a few seconds.

The helper installer isn't code-signed yet, so Windows may show "Windows protected your PC". Choose **More info**, then **Run anyway**.

Update the helper with each new version of the plugin: Scribble says when the helper doesn't match, and an installer run while Obsidian is open replaces it in place.

## What it does on your computer

Obsidian asks plugins to say so when they do any of the following.

- **A separate program.** The pen ink is drawn by the ink helper (`InkOverlay.exe`), a Windows program you install separately, since plugins can't install software themselves. Scribble starts and stops it with Obsidian. Its source is in [`helper/`](helper) in this repository.
- **Files outside your vault.** The helper lives in `%LOCALAPPDATA%\Programs\Scribble`. Next to it are its log (`helper.log`) and `backups\`, where it keeps a copy of a note's ink before a pull from OneNote replaces it. It uses Windows' temp folder while importing from OneNote.
- **Files in your vault.** Each note's ink is saved next to it as a `.ink` file (OneNote's ink format), for example `Lecture 3.ink` beside `Lecture 3.md`.
- **Other apps.** Syncing talks to OneNote for Windows on this computer through its own programming interface (COM). OneNote then syncs with your Microsoft account as usual. Scribble never signs in to anything itself.
- **Network.** Neither the plugin nor the helper connects to the internet. The only link opens the helper's download page in your browser.
- **No telemetry, ads or accounts.**

## Uninstall

Disable and remove Scribble in Obsidian, then uninstall **Scribble ink helper** from Windows' Installed apps. The helper's log and ink backups stay in `%LOCALAPPDATA%\Programs\Scribble` until you delete that folder. The `.ink` files next to your notes stay too.

## Build from source

The helper needs the .NET 10 SDK to build (it then runs without .NET installed, since it carries its own). The installers need [Inno Setup 6](https://jrsoftware.org/isinfo.php).

```bash
cd plugin && npm install && npm run build
node install.mjs "C:\path\to\your\vault"   # the plugin into the vault, a helper build into %LOCALAPPDATA%\Programs\Scribble
```

```powershell
cd helper; dotnet publish -c Release -r win-x64 -o publish   # or -r win-arm64; install.mjs copies it from here
.\installer\build.ps1                                        # both helper installers, into installer\output
```

Releases are built by GitHub Actions when a version tag is pushed (`.github/workflows/release.yml`).

## License

[MIT](LICENSE) © Maws7140

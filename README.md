# OneNote Ink for Obsidian

1:1 sync between Obsidian Markdown notes and OneNote, with OneNote-style pen ink on top of your notes.

Write on any note, PDF or picture in Obsidian with a pen, using Windows Ink (the same inking OneNote uses). Each note gets its own OneNote page: text and ink go to OneNote, and edits made in OneNote come back to the note.

## Features

- Pen, pencil, highlighter and effect pens; eraser, lasso, ruler, shapes, laser pointer, ink replay
- Ink stays with its text as you type, scroll and switch views
- Scribble to erase, draw-and-hold to make clean shapes
- Ink to Text, Ink to Math (solve, steps, graphs, practice quizzes), handwriting search
- Background two-way sync with OneNote (text, ink and equations)
- Choose which folders, tags or notes get the ink tools
- Obsidian's **Export to PDF** includes the note's ink, with text and handwriting scaled together to fit the paper

## Requirements

- Windows 10 or 11 with a pen
- Obsidian (desktop)
- OneNote for Windows (desktop) for syncing

## Build and install

Building the helper needs the .NET 10 SDK. Running it needs no .NET: it carries its own.

```bash
cd helper && dotnet publish -c Release -r win-x64 -o publish   # or -r win-arm64
cd ../plugin && npm install && npm run build
node install.mjs "C:\path\to\your\vault"
```

Then enable **OneNote Ink** under Settings → Community plugins.

## License

MIT

using System;
using System.Collections.Generic;
using System.IO;
using System.Linq;
using System.Xml.Linq;

namespace InkOverlay;

/// <summary>A notebook, section group, section or page, for choosing what to import.</summary>
public sealed class OneNoteNode
{
    public string Kind { get; set; } = "";        // notebook | group | section | page
    public string Id { get; set; } = "";
    public string Name { get; set; } = "";
    public string? Modified { get; set; }         // page: last changed
    public int Level { get; set; } = 1;           // page: 1, or 2-3 for a subpage
    public bool Locked { get; set; }              // section: password-protected and locked, so its pages can't be read
    public List<OneNoteNode>? Children { get; set; }
}

/// <summary>What a page would make best: a note, a canvas, or nothing (it's empty), and why.</summary>
public sealed class PageKind
{
    public string Id { get; set; } = "";
    public string Kind { get; set; } = "note";    // note | canvas | empty
    public string Reason { get; set; } = "";
    public string? Error { get; set; }
    // What reading the page will take: OneNote hands over each drawing's ink (one per stroke, often thousands)
    // and each picture at about 17 ms apiece, so a page of handwriting can take a minute or more.
    public int Strokes { get; set; }
    public int Pictures { get; set; }
}

/// <summary>
/// "Import from OneNote": the notebooks to choose from, what each page is like, and a page read for a note.
/// (A page for a canvas is read by <see cref="OneNoteImport.Read"/>.) Reads only: OneNote isn't changed.
/// </summary>
public static class OneNoteVaultImport
{
    static readonly XNamespace one = OneNote.Ns;

    static bool Binned(XElement e) =>
        e.Attribute("isRecycleBin")?.Value == "true" || e.Attribute("isInRecycleBin")?.Value == "true" || e.Attribute("isDeletedPages")?.Value == "true";

    /// <summary>Every notebook, with its section groups, sections and pages, in OneNote's order. Recycle bins left out.</summary>
    internal static List<OneNoteNode> Tree(IOneNoteApplication app)
    {
        var root = OneNote.Hierarchy(app, "", OneNote.HsPages).Root!;
        List<OneNoteNode> Children(XElement parent)
        {
            var list = new List<OneNoteNode>();
            foreach (var e in parent.Elements())
            {
                if (Binned(e)) continue;
                string id = e.Attribute("ID")?.Value ?? "", name = e.Attribute("name")?.Value ?? "";
                if (e.Name == one + "SectionGroup")
                    list.Add(new OneNoteNode { Kind = "group", Id = id, Name = name, Children = Children(e) });
                else if (e.Name == one + "Section")
                    list.Add(new OneNoteNode { Kind = "section", Id = id, Name = name, Locked = e.Attribute("locked")?.Value == "true", Children = Children(e) });
                else if (e.Name == one + "Page")
                    list.Add(new OneNoteNode
                    {
                        Kind = "page", Id = id, Name = name, Modified = e.Attribute("lastModifiedTime")?.Value,
                        Level = int.TryParse(e.Attribute("pageLevel")?.Value, out var l) ? l : 1,
                    });
            }
            return list;
        }
        return root.Elements(one + "Notebook")
            .Select(nb => new OneNoteNode { Kind = "notebook", Id = nb.Attribute("ID")?.Value ?? "", Name = nb.Attribute("nickname")?.Value ?? nb.Attribute("name")?.Value ?? "", Children = Children(nb) })
            .ToList();
    }

    readonly record struct Box(double X, double Y, double W, double H)
    {
        public double Right => X + W;
        public double Bottom => Y + H;
    }

    static Box BoxOf(XElement e)
    {
        var pos = e.Element(one + "Position");
        var size = e.Element(one + "Size");
        return new Box(Num(pos?.Attribute("x")), Num(pos?.Attribute("y")), Num(size?.Attribute("width"), 100), Num(size?.Attribute("height"), 14));
    }

    /// <summary>Side by side: they share a good part of their height but not their width.</summary>
    static bool SideBySide(Box a, Box b)
    {
        double shared = Math.Min(a.Bottom, b.Bottom) - Math.Max(a.Y, b.Y);
        double apart = Math.Max(a.X, b.X) - Math.Min(a.Right, b.Right);
        return shared > 0.3 * Math.Min(Math.Max(a.H, 14), Math.Max(b.H, 14)) && apart > -10;
    }

    static bool HasText(XElement outline) =>
        outline.Descendants(one + "OE").Any(oe => OneNoteToMarkdown.PlainText(oe).Trim().Length > 0) || outline.Descendants(one + "Table").Any();

    /// <summary>
    /// Note or canvas? A note is one column, read top to bottom: text boxes stacked, pictures between them, a few
    /// marks of ink. Anything laid out across the page (text boxes or pictures side by side, handwriting or
    /// drawings, a printout to write on) keeps its layout only on a canvas.
    /// </summary>
    internal static PageKind Classify(IOneNoteApplication app, string pageId)
    {
        app.GetPageContent(pageId, out var xml, 0 /* piBasic: no binary data */, OneNote.Xs2013);
        var root = XDocument.Parse(xml).Root!;
        var outlines = root.Elements(one + "Outline").ToList();
        var texts = outlines.Where(HasText).Select(BoxOf).ToList();
        int inkWords = outlines.Sum(o => o.Descendants(one + "InkWord").Count());
        // One drawing can hold one stroke or hundreds, so it's the space they take that tells: an underline or a
        // tick is a little ink on a note; a block of handwriting or a sketch needs the page's layout.
        var drawn = root.Elements(one + "InkDrawing").Select(BoxOf).ToList();
        int drawings = drawn.Count;
        double inkArea = drawn.Sum(b => b.W * b.H), textArea = texts.Sum(b => b.W * b.H);
        bool muchInk = drawings >= 10 || drawn.Any(b => b.W > 100 && b.H > 60) || inkArea > 0.25 * Math.Max(textArea, 1);
        var pictures = root.Elements(one + "Image").ToList();
        int printouts = pictures.Count(i => i.Attribute("isPrintOut")?.Value == "true");
        int files = root.Elements(one + "InsertedFile").Count() + root.Elements(one + "MediaFile").Count();
        int inside = outlines.Sum(o => o.Descendants(one + "Image").Count() + o.Descendants(one + "InsertedFile").Count());
        PageKind Kind(string kind, string reason) => new()
        {
            Id = pageId, Kind = kind, Reason = reason, Strokes = drawings + inkWords, Pictures = pictures.Count + inside + files,
        };

        if (texts.Count == 0 && inkWords == 0 && drawings == 0 && pictures.Count == 0 && files == 0 && inside == 0)
            return Kind("empty", "Nothing on the page");
        if (printouts > 0)
            return Kind("canvas", printouts == 1 ? "A printout to write on" : $"{printouts} printout pages to write on");
        if (drawings > 0 && (texts.Count == 0 || muchInk))
            return Kind("canvas", texts.Count == 0 ? "Handwriting or drawings" : "Text with handwriting or drawings around it");
        for (int i = 0; i < texts.Count; i++)
            for (int j = i + 1; j < texts.Count; j++)
                if (SideBySide(texts[i], texts[j])) return Kind("canvas", "Text boxes side by side");
        foreach (var p in pictures.Select(BoxOf))
            if (texts.Any(t => SideBySide(p, t))) return Kind("canvas", "Pictures beside the text");

        var parts = new List<string>();
        int pics = pictures.Count + inside;
        if (texts.Count > 0) parts.Add(texts.Count == 1 ? "One text box" : "Text boxes in one column");
        if (pics > 0) parts.Add(pics == 1 ? "a picture" : $"{pics} pictures");
        if (files > 0) parts.Add(files == 1 ? "an attached file" : $"{files} attached files");
        if (drawings > 0 || inkWords > 0) parts.Add("a little ink");
        var reason = string.Join(", ", parts);
        return Kind("note", reason.Length > 0 ? char.ToUpperInvariant(reason[0]) + reason[1..] : "Text");
    }

    public sealed record NoteResult(string Title, List<ImportCard> Cards, int InkStrokes, string InkSig, string LastModified, string TempDir);

    /// <summary>
    /// A page for a note: its objects top to bottom (text as Markdown, pictures and files as temporary copies for the
    /// plugin to take), and how much ink it has. The ink is placed once the note is first open and laid out, by
    /// an ordinary pull: where it goes depends on the note's text column, which only Obsidian knows.
    /// </summary>
    internal static NoteResult ReadForNote(IOneNoteApplication app, string pageId)
    {
        app.GetPageContent(pageId, out var xml, 1 /* piBinaryData */, OneNote.Xs2013);
        var root = XDocument.Parse(xml).Root!;
        var temp = Path.Combine(Path.GetTempPath(), "scribble-import-" + Guid.NewGuid().ToString("N"));
        Directory.CreateDirectory(temp);
        var cards = OneNoteImport.BuildCards(root, temp)
            .Where(c => c.ObjectId != "title")
            .OrderBy(c => Math.Round(c.PageY)).ThenBy(c => c.PageX)
            .ToList();
        var (ink, sig, _) = OneNoteSync.ReadInk(app, pageId, OneNoteSync.Page(app, pageId), null);
        return new NoteResult(root.Attribute("name")?.Value ?? "", cards, ink.Count, sig, OneNoteSync.LastModified(app, pageId), temp);
    }

    static double Num(XAttribute? a, double fallback = 0) =>
        a != null && double.TryParse(a.Value, System.Globalization.NumberStyles.Float, System.Globalization.CultureInfo.InvariantCulture, out var v) ? v : fallback;
}

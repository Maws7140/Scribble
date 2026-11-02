using System;
using System.Collections.Generic;
using System.IO;
using System.Linq;
using System.Windows.Ink;
using System.Windows.Media;
using System.Xml.Linq;

namespace InkOverlay;

/// <summary>"Open a OneNote page as a canvas": what the plugin asks for, and what comes back.</summary>
public sealed class ImportRequest
{
    public int Id { get; set; }
    public string PageId { get; set; } = "";
    public string InkPath { get; set; } = "";     // where the canvas's ink goes
    public double Origin { get; set; }            // ink units on a canvas are canvas px + this (see targets.ts)
}

public sealed class ImportCard
{
    public string Kind { get; set; } = "text";    // text | image | file
    public double X { get; set; }                 // canvas px
    public double Y { get; set; }
    public double W { get; set; }
    public double H { get; set; }
    public string? Markdown { get; set; }         // text
    public string? File { get; set; }             // image, file: a temporary copy for the plugin to take
    public string? Name { get; set; }             // what to call it
}

public sealed class OneNotePageInfo
{
    public string Id { get; set; } = "";
    public string Title { get; set; } = "";
    public string Where { get; set; } = "";       // notebook / section
    public string Modified { get; set; } = "";
}

/// <summary>
/// Reads a OneNote page for a canvas, where it can keep its shape: a page's objects sit at free positions,
/// which a note's single column can't hold. Text boxes become cards, pictures (printouts too) and attached
/// files go to the vault, and the ink comes over where it was. It only reads: the page isn't changed.
/// </summary>
public static class OneNoteImport
{
    const double PxPerPt = 1 / 0.75;
    // The ink layer reaches 50,000 px each way from the canvas's 0,0: a page running past this is centred on it.
    const double Reach = 45_000;
    static readonly XNamespace one = OneNote.Ns;

    /// <summary>Every page not in a recycle bin, most recently changed first.</summary>
    internal static List<OneNotePageInfo> ListPages(IOneNoteApplication app) =>
        OneNote.Hierarchy(app, "", OneNote.HsPages).Descendants(one + "Page")
            .Where(p => p.Attribute("isInRecycleBin")?.Value != "true"
                && !p.Ancestors().Any(a => a.Attribute("isRecycleBin")?.Value == "true" || a.Attribute("isInRecycleBin")?.Value == "true"))
            .Select(p => new OneNotePageInfo
            {
                Id = p.Attribute("ID")!.Value,
                Title = p.Attribute("name")?.Value ?? "",
                Where = string.Join(" / ", p.Ancestors().Reverse().Select(a => a.Attribute("name")?.Value).Where(n => !string.IsNullOrEmpty(n))),
                Modified = p.Attribute("lastModifiedTime")?.Value ?? "",
            })
            .OrderByDescending(p => p.Modified, StringComparer.Ordinal).ToList();

    public sealed record Result(string Title, List<ImportCard> Cards, int Strokes, string TempDir);

    /// <summary>
    /// Read the page and write its ink to `InkPath`. One read with all the page's data in it: about 12 ms per
    /// drawing, where asking for each drawing took up to 74 ms each (real pages have thousands, one per stroke).
    /// </summary>
    internal static Result Read(IOneNoteApplication app, ImportRequest req)
    {
        app.GetPageContent(req.PageId, out var xml, 1 /* piBinaryData */, OneNote.Xs2013);
        var page = XDocument.Parse(xml);
        var root = page.Root!;
        var temp = Path.Combine(Path.GetTempPath(), "onenote-ink-import-" + Guid.NewGuid().ToString("N"));
        Directory.CreateDirectory(temp);

        var title = root.Attribute("name")?.Value ?? "";
        var cards = new List<ImportCard>();
        int number = 0;
        string Save(byte[] bytes, string ext)
        {
            var path = Path.Combine(temp, $"{++number}{ext}");
            File.WriteAllBytes(path, bytes);
            return path;
        }
        ImportCard? Picture(XElement image, double x, double y)
        {
            var data = image.Element(one + "Data")?.Value;
            if (string.IsNullOrEmpty(data)) return null;
            var bytes = Convert.FromBase64String(data);
            var size = image.Element(one + "Size");
            return new ImportCard
            {
                Kind = "image", X = x * PxPerPt, Y = y * PxPerPt,
                W = Num(size?.Attribute("width"), 100) * PxPerPt, H = Num(size?.Attribute("height"), 100) * PxPerPt,
                File = Save(bytes, PictureType(bytes)), Name = "image",
            };
        }
        ImportCard? Attached(XElement file, double x, double y)
        {
            var cache = file.Attribute("pathCache")?.Value;
            var name = file.Attribute("preferredName")?.Value ?? "attachment";
            // Small, as OneNote shows it: a printout's pages often lie under it, and it mustn't cover them.
            var card = new ImportCard { X = x * PxPerPt, Y = y * PxPerPt, W = 320, H = 60, Name = name };
            if (cache != null && File.Exists(cache))
            {
                card.Kind = "file";
                card.File = Path.Combine(temp, $"{++number}{Path.GetExtension(name)}");
                File.Copy(cache, card.File);
                File.SetAttributes(card.File, FileAttributes.Normal); // OneNote's cached copies are read-only
                return card;
            }
            // Not on this machine: say so where it was, rather than leave a gap.
            card.Markdown = $"Attached in OneNote: {name}";
            return card;
        }

        // Pictures first, so they lie under the text and the ink over them.
        foreach (var image in root.Elements(one + "Image"))
        {
            var pos = image.Element(one + "Position");
            if (Picture(image, Num(pos?.Attribute("x")), Num(pos?.Attribute("y"))) is { } card) cards.Add(card);
        }
        foreach (var file in root.Elements(one + "InsertedFile"))
        {
            var pos = file.Element(one + "Position");
            if (Attached(file, Num(pos?.Attribute("x")), Num(pos?.Attribute("y"))) is { } card) cards.Add(card);
        }
        if (title.Trim().Length > 0)
            cards.Add(TextCard("# " + title, 36, 24, 500, 30));
        foreach (var outline in root.Elements(one + "Outline"))
        {
            var pos = outline.Element(one + "Position");
            var size = outline.Element(one + "Size");
            double x = Num(pos?.Attribute("x")), y = Num(pos?.Attribute("y"));
            double w = Num(size?.Attribute("width"), 300), h = Num(size?.Attribute("height"), 14);
            var markdown = OneNoteToMarkdown.Convert(outline);
            // Pictures and files inside a text box have no place of their own: in order, under its text.
            var inside = outline.Descendants().Where(e => e.Name == one + "Image" || e.Name == one + "InsertedFile").ToList();
            double below = y;
            if (markdown.Trim().Length > 0)
            {
                double textHeight = inside.Count == 0 ? h : markdown.Split('\n').Length * 18;
                cards.Add(TextCard(markdown, x, y, w, textHeight));
                below += textHeight;
            }
            foreach (var e in inside)
            {
                var card = e.Name == one + "Image" ? Picture(e, x, below) : Attached(e, x, below);
                if (card == null) continue;
                cards.Add(card);
                below += card.H / PxPerPt;
            }
        }

        // The ink, in canvas px: the same reading as a pull, with the page's own 0,0 as the canvas's.
        var (ink, _, _) = OneNoteSync.ReadInk(app, req.PageId, page, OneNoteSync.PageOrigin);
        var strokes = OverlayWindow.WithoutDuplicates(ink);

        // A very long page: centre it, so all of it is inside the ink layer.
        double left = cards.Count > 0 ? cards.Min(c => c.X) : 0, top = cards.Count > 0 ? cards.Min(c => c.Y) : 0;
        double right = cards.Count > 0 ? cards.Max(c => c.X + c.W) : 0, bottom = cards.Count > 0 ? cards.Max(c => c.Y + c.H) : 0;
        if (strokes.Count > 0)
        {
            var b = strokes.GetBounds();
            left = Math.Min(left, b.Left); top = Math.Min(top, b.Top);
            right = Math.Max(right, b.Right); bottom = Math.Max(bottom, b.Bottom);
        }
        double dx = left < -Reach || right > Reach ? -(left + right) / 2 : 0;
        double dy = top < -Reach || bottom > Reach ? -(top + bottom) / 2 : 0;
        foreach (var c in cards) { c.X += dx; c.Y += dy; }
        strokes.Transform(new Matrix(1, 0, 0, 1, dx + req.Origin, dy + req.Origin), false);
        if (req.InkPath.Length > 0 && strokes.Count > 0)
        {
            var tmp = req.InkPath + ".tmp";
            using (var fs = File.Create(tmp)) strokes.Save(fs, true);
            File.Move(tmp, req.InkPath, overwrite: true);
        }
        return new Result(title, cards, strokes.Count, temp);
    }

    /// <summary>A text box as a card: the text where it was, so handwriting beside it stays beside it (a card pads its text).</summary>
    static ImportCard TextCard(string markdown, double x, double y, double w, double h) => new()
    {
        Kind = "text", Markdown = markdown,
        X = x * PxPerPt - 24, Y = y * PxPerPt - 12,
        W = w * PxPerPt + 48,
        // Taller than OneNote's own: Obsidian's text is bigger, and a card that's too short only scrolls.
        H = Math.Max(60, h * PxPerPt * 1.3 + 24),
    };

    /// <summary>OneNote doesn't say what kind of picture it holds: the bytes do.</summary>
    internal static string PictureType(byte[] b)
    {
        if (b.Length > 3 && b[0] == 0x89 && b[1] == 0x50) return ".png";
        if (b.Length > 3 && b[0] == 0xFF && b[1] == 0xD8) return ".jpg";
        if (b.Length > 3 && b[0] == 0x47 && b[1] == 0x49) return ".gif";
        if (b.Length > 3 && b[0] == 0x42 && b[1] == 0x4D) return ".bmp";
        if (b.Length > 11 && b[8] == 0x57 && b[9] == 0x45 && b[10] == 0x42 && b[11] == 0x50) return ".webp";
        return ".png";
    }

    static double Num(XAttribute? a, double fallback = 0) =>
        a != null && double.TryParse(a.Value, System.Globalization.NumberStyles.Float, System.Globalization.CultureInfo.InvariantCulture, out var v) ? v : fallback;
}

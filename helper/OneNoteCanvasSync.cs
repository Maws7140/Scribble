using System;
using System.Collections.Generic;
using System.IO;
using System.Linq;
using System.Net;
using System.Text.Json;
using System.Windows;
using System.Windows.Ink;
using System.Windows.Media;
using System.Xml.Linq;

namespace InkOverlay;

/// <summary>One card on the canvas as it is now.</summary>
public sealed class CanvasNode
{
    public string Id { get; set; } = "";
    public string Kind { get; set; } = "text";    // text | image | file
    public double X { get; set; }
    public double Y { get; set; }
    public double W { get; set; }
    public double H { get; set; }
    public string Text { get; set; } = "";        // text: its Markdown
    public List<ExportBlock> Blocks { get; set; } = new();
    public string? File { get; set; }             // image, file: the full path
    public string? Name { get; set; }
}

public sealed class CanvasSendRequest
{
    public string CanvasPath { get; set; } = "";
    public string Title { get; set; } = "";
    public string Section { get; set; } = "Obsidian";
    public string InkPath { get; set; } = "";
    public string StatePath { get; set; } = "";
    public double Origin { get; set; }
    public bool WhiteInkToBlack { get; set; } = true;
    public bool Navigate { get; set; }
    public List<CanvasNode> Nodes { get; set; } = new();
}

public sealed class CanvasPullRequest
{
    public string CanvasPath { get; set; } = "";
    public string InkPath { get; set; } = "";
    public string StatePath { get; set; } = "";
    public double Origin { get; set; }
    /// <summary>Asked for by hand: an object gone from the page takes its card along. Background pulls never remove a card.</summary>
    public bool Manual { get; set; }
    public List<CanvasNode> Nodes { get; set; } = new();
}

/// <summary>A card and the OneNote object it is, as the two last agreed.</summary>
public sealed class CanvasSyncCard
{
    public string NodeId { get; set; } = "";
    public string ObjectId { get; set; } = "";    // "title": the page's title
    public string Kind { get; set; } = "text";    // text | image | file | title
    public bool Inside { get; set; }              // inside a text box, with no position of its own
    public string Hash { get; set; } = "";
    public string Text { get; set; } = "";
    public double X { get; set; }                 // on the canvas
    public double Y { get; set; }
    public double W { get; set; }
    public double H { get; set; }
    public double PageX { get; set; }             // on the page (pt)
    public double PageY { get; set; }
    public double PageW { get; set; }
    public double PageH { get; set; }
}

/// <summary>
/// What the canvas and the page last agreed on. Kept in a file of its own, not the plugin's settings: a real
/// page has about 1,100 drawings. `Strokes` is each stroke of ours and the drawing it's in, `Drawings` what
/// each drawing looked like.
/// </summary>
public sealed class CanvasSyncState
{
    public string PageId { get; set; } = "";
    public double Dx { get; set; }                // canvas px = page px + this (a very long page is centred)
    public double Dy { get; set; }
    public string LastModified { get; set; } = "";
    public List<CanvasSyncCard> Cards { get; set; } = new();
    public Dictionary<string, string> Drawings { get; set; } = new();
    public Dictionary<string, string> Strokes { get; set; } = new();
}

/// <summary>A card to change, add or remove after a pull. Null fields stay as they are.</summary>
public sealed class CanvasCardChange
{
    public string Op { get; set; } = "update";    // update | new | delete
    public string NodeId { get; set; } = "";
    public string? OldText { get; set; }
    public string? Markdown { get; set; }
    public double? X { get; set; }
    public double? Y { get; set; }
    public double? W { get; set; }
    public double? H { get; set; }
    public ImportCard? Card { get; set; }         // new
}

public sealed class CanvasPageChangedException() : Exception("The OneNote page has changes that haven't been pulled");

/// <summary>
/// Keeps a canvas and a OneNote page the same, one object at a time. A note's page is ours and is rewritten on
/// every send; this page may be one you've had for years, with printouts, tables and formatting that Markdown
/// can't hold, and thousands of drawings. So a card you haven't edited never has its object rewritten (moving
/// one only changes its position), and ink is merged stroke by stroke rather than replaced.
/// </summary>
public static class OneNoteCanvasSync
{
    const double PtPerPx = 0.75, Slop = 0.5;
    static readonly XNamespace one = OneNote.Ns;
    static readonly JsonSerializerOptions Json = new() { PropertyNameCaseInsensitive = true };

    internal static CanvasSyncState? Load(string path)
    {
        try { return File.Exists(path) ? JsonSerializer.Deserialize<CanvasSyncState>(File.ReadAllText(path), Json) : null; }
        catch (Exception e)
        {
            Protocol.Log($"canvas sync state {path} can't be read: {e.Message}");
            return null;
        }
    }

    internal static void Save(string path, CanvasSyncState state)
    {
        Directory.CreateDirectory(Path.GetDirectoryName(path)!);
        File.WriteAllText(path + ".tmp", JsonSerializer.Serialize(state));
        File.Move(path + ".tmp", path, overwrite: true);
    }

    static string F(double v) => v.ToString("0.##", System.Globalization.CultureInfo.InvariantCulture);

    static double Num(XAttribute? a) =>
        a != null && double.TryParse(a.Value, System.Globalization.NumberStyles.Float, System.Globalization.CultureInfo.InvariantCulture, out var v) ? v : 0;

    /// <summary>
    /// Which stroke this is: its points as the ink file stores them (whole HIMETRIC units), so a stroke on
    /// screen and the same stroke read from its file agree. Not its colour, which depends on the theme.
    /// </summary>
    internal static string StrokeKey(Stroke s)
    {
        ulong h = 0xcbf29ce484222325;
        void Mix(long v)
        {
            for (int i = 0; i < 8; i++, v >>= 8) { h ^= (byte)v; h *= 0x100000001b3; }
        }
        foreach (var p in s.StylusPoints)
        {
            Mix((long)Math.Round(p.X * 2540 / 96));
            Mix((long)Math.Round(p.Y * 2540 / 96));
        }
        return h.ToString("x16");
    }

    /// <summary>What a drawing looks like without reading its ink: real edits move or resize it, or change its time.</summary>
    static string DrawingSig(XElement d)
    {
        var pos = d.Element(one + "Position");
        var size = d.Element(one + "Size");
        return $"{Num(pos?.Attribute("x")):0.##},{Num(pos?.Attribute("y")):0.##},{Num(size?.Attribute("width")):0.##},{Num(size?.Attribute("height")):0.##},{d.Attribute("lastModifiedTime")?.Value}";
    }

    /// <summary>A drawing's strokes in ink units.</summary>
    static StrokeCollection? DrawingInk(IOneNoteApplication app, string pageId, XElement d, double offsetX, double offsetY)
    {
        var strokes = OneNoteSync.InkData(app, pageId, d);
        if (strokes == null) return null;
        OneNoteExport.HighlightersFromOneNote(strokes);
        var pos = d.Element(one + "Position");
        double x = Num(pos?.Attribute("x")), y = Num(pos?.Attribute("y"));
        OneNoteSync.ToDrawingLocal(strokes, x, y);
        strokes.Transform(new Matrix(1, 0, 0, 1, x / PtPerPx + offsetX, y / PtPerPx + offsetY), false);
        return strokes;
    }

    /// <summary>All the page's ink for a new canvas, each stroke with the drawing it came from.</summary>
    internal static List<(string id, string sig, StrokeCollection strokes)> PageInk(IOneNoteApplication app, string pageId, XElement root)
    {
        var all = new List<(string, string, StrokeCollection)>();
        foreach (var d in root.Elements(one + "InkDrawing"))
        {
            var id = d.Attribute("objectID")?.Value;
            if (id == null || DrawingInk(app, pageId, d, 0, 0) is not { } strokes) continue;
            all.Add((id, DrawingSig(d), strokes));
        }
        // Handwriting inside text boxes: OneNote doesn't say where each word sits, so on its paragraph's line,
        // left to right. It's part of the box and can't be changed on its own: only ever read.
        foreach (var o in root.Elements(one + "Outline"))
        {
            var oes = o.Descendants(one + "OE").ToList();
            if (!oes.Any(oe => oe.Descendants(one + "InkWord").Any())) continue;
            var pos = o.Element(one + "Position");
            double ox = Num(pos?.Attribute("x")), oy = Num(pos?.Attribute("y"));
            double lineH = Math.Max(14, Num(o.Element(one + "Size")?.Attribute("height")) / Math.Max(1, oes.Count));
            for (int k = 0; k < oes.Count; k++)
            {
                double x = ox;
                int n = 0;
                foreach (var w in oes[k].Elements().Where(e => e.Name != one + "OEChildren").SelectMany(e => e.DescendantsAndSelf(one + "InkWord")))
                {
                    var strokes = OneNoteSync.InkData(app, pageId, w);
                    if (strokes == null || strokes.Count == 0) continue;
                    var b = strokes.GetBounds();
                    strokes.Transform(new Matrix(1, 0, 0, 1, x / PtPerPx - b.Left, (oy + k * lineH) / PtPerPx - b.Top), false);
                    all.Add(($"word:{o.Attribute("objectID")?.Value}:{k}:{n++}", "", strokes));
                    x += b.Width * PtPerPx + 4;
                }
            }
        }
        return all;
    }

    // ---------- canvas -> page ----------

    static XElement Position(double x, double y, int z) =>
        new(one + "Position", new XAttribute("x", F(x)), new XAttribute("y", F(y)), new XAttribute("z", z));

    static List<XElement> ToOEs(CanvasNode node, ref bool usesTodo)
    {
        var oes = new List<XElement>();
        foreach (var block in node.Blocks) oes.AddRange(OneNoteExport.BlockToOEs(block, ref usesTodo));
        if (oes.Count == 0) oes.Add(new XElement(one + "OE", new XElement(one + "T", new XCData(" "))));
        return oes;
    }

    /// <summary>Where a card's object goes on the page. A text card pads its text (see OneNoteImport.TextCard).</summary>
    static (double x, double y) PagePlace(string kind, double x, double y, CanvasSyncState s) => kind == "text"
        ? ((x + OneNoteImport.CardPadX - s.Dx) * PtPerPx, (y + OneNoteImport.CardPadY - s.Dy) * PtPerPx)
        : ((x - s.Dx) * PtPerPx, (y - s.Dy) * PtPerPx);

    static double PageWidth(string kind, double w) => kind == "text" ? (w - 2 * OneNoteImport.CardPadX) * PtPerPx : w * PtPerPx;

    /// <summary>
    /// Bring the page up to the canvas. Refuses if the page has edits of its own: those are pulled first, so
    /// nothing is overwritten. New things go in before old ones come out, so OneNote stopping halfway leaves too
    /// much rather than too little, and the next send finishes the job.
    /// </summary>
    public static CanvasSyncState Send(CanvasSendRequest req)
    {
        var app = OneNote.Connect();
        var state = Load(req.StatePath);
        if (state != null && !OneNoteSync.PageExists(app, state.PageId)) state = null; // deleted in OneNote: a new page
        if (state == null)
        {
            var pageId = OneNoteExport.NewPage(app, OneNoteExport.EnsureSection(app, req.Section));
            state = new CanvasSyncState { PageId = pageId };
            var titled = new XElement(one + "Page", new XAttribute("ID", pageId),
                new XElement(one + "Title", new XElement(one + "OE", new XElement(one + "T", new XCData(WebUtility.HtmlEncode(req.Title))))));
            app.UpdatePageContent(new XDocument(titled).ToString(SaveOptions.DisableFormatting), DateTime.MinValue, OneNote.Xs2013, false);
        }
        else if (OneNoteSync.LastModified(app, state.PageId) != state.LastModified) throw new CanvasPageChangedException();

        var root = OneNoteSync.Page(app, state.PageId).Root!;
        var byId = root.Descendants().Where(e => e.Attribute("objectID") != null)
            .GroupBy(e => e.Attribute("objectID")!.Value).ToDictionary(g => g.Key, g => g.First());
        int z = root.Elements().Select(e => (int)Num(e.Element(one + "Position")?.Attribute("z"))).DefaultIfEmpty(0).Max();
        var changes = new List<XElement>();
        var created = new List<(CanvasNode node, string name, double x, double y)>();
        bool usesTodo = false;
        var nodes = req.Nodes.ToDictionary(n => n.Id);
        var cards = state.Cards.ToDictionary(c => c.NodeId);

        foreach (var node in req.Nodes)
        {
            if (!cards.TryGetValue(node.Id, out var card))
            {
                if (node.Kind == "text" && node.Text.Trim().Length == 0) continue; // an empty card, for now
                var (x, y) = PagePlace(node.Kind, node.X, node.Y, state);
                XElement? e = node.Kind switch
                {
                    "text" => new XElement(one + "Outline", Position(x, y, ++z),
                        new XElement(one + "Size", new XAttribute("width", F(PageWidth("text", node.W))), new XAttribute("height", 14), new XAttribute("isSetByUser", "true")),
                        new XElement(one + "OEChildren", ToOEs(node, ref usesTodo))),
                    "image" when File.Exists(node.File) => new XElement(one + "Image", Position(x, y, ++z),
                        new XElement(one + "Size", new XAttribute("width", F(node.W * PtPerPx)), new XAttribute("height", F(node.H * PtPerPx)), new XAttribute("isSetByUser", "true")),
                        new XElement(one + "Data", Convert.ToBase64String(File.ReadAllBytes(node.File!)))),
                    "file" when File.Exists(node.File) => new XElement(one + "InsertedFile", new XAttribute("pathSource", node.File!), new XAttribute("preferredName", node.Name ?? Path.GetFileName(node.File!)), Position(x, y, ++z)),
                    _ => null,
                };
                if (e == null) continue;
                changes.Add(e);
                created.Add((node, e.Name.LocalName, x, y));
                continue;
            }
            if (card.Kind == "title")
            {
                var title = node.Text.Trim().TrimStart('#').Trim();
                if (node.Text != card.Text)
                {
                    changes.Add(new XElement(one + "Title", new XElement(one + "OE", new XElement(one + "T", new XCData(WebUtility.HtmlEncode(title))))));
                    card.Text = node.Text;
                    card.Hash = title;
                }
                continue;
            }
            if (!byId.TryGetValue(card.ObjectId, out var obj)) continue;
            bool edited = card.Kind == "text" && node.Text != card.Text;
            bool moved = !card.Inside && (Math.Abs(node.X - card.X) > 1 || Math.Abs(node.Y - card.Y) > 1);
            bool resized = !card.Inside && (card.Kind == "text" ? Math.Abs(node.W - card.W) > 1 : card.Kind == "image" && (Math.Abs(node.W - card.W) > 1 || Math.Abs(node.H - card.H) > 1));
            if (!edited && !moved && !resized) continue;
            if (edited)
            {
                // What Markdown can't hold in this box (pictures, files, handwriting) stays in it, after the text.
                var kept = obj.Element(one + "OEChildren")?.Elements(one + "OE")
                    .Where(oe => oe.Descendants().Any(d => d.Name == one + "Image" || d.Name == one + "InsertedFile" || d.Name == one + "InkWord")).ToList() ?? new();
                var children = new XElement(one + "OEChildren", ToOEs(node, ref usesTodo), kept);
                obj.Element(one + "OEChildren")?.ReplaceWith(children);
                card.Text = node.Text;
            }
            if (moved)
            {
                var (x, y) = PagePlace(card.Kind, node.X, node.Y, state);
                var pos = obj.Element(one + "Position");
                pos?.SetAttributeValue("x", F(x));
                pos?.SetAttributeValue("y", F(y));
                card.X = node.X;
                card.Y = node.Y;
            }
            if (resized)
            {
                var size = obj.Element(one + "Size");
                size?.SetAttributeValue("width", F(PageWidth(card.Kind, node.W)));
                if (card.Kind == "image") size?.SetAttributeValue("height", F(node.H * PtPerPx));
                size?.SetAttributeValue("isSetByUser", "true");
                card.W = node.W;
                card.H = node.H;
            }
            changes.Add(obj);
        }

        // The ink: strokes that are new here go over in one new drawing. A stroke erased (or moved) here takes
        // its drawing out, and the rest of that drawing go over again with the new ones.
        var local = OneNoteExport.LoadInk(req.InkPath);
        var localKeys = new Dictionary<string, Stroke>();
        foreach (var s in local) localKeys.TryAdd(StrokeKey(s), s);
        var gone = state.Strokes.Where(p => !localKeys.ContainsKey(p.Key)).ToList();
        var dropDrawings = gone.Select(p => p.Value).Where(id => !id.StartsWith("word:")).ToHashSet();
        foreach (var p in gone) state.Strokes.Remove(p.Key);
        var send = localKeys.Where(p => !state.Strokes.TryGetValue(p.Key, out var id) || dropDrawings.Contains(id)).ToList();
        foreach (var p in send) state.Strokes.Remove(p.Key);
        if (send.Count > 0)
        {
            var strokes = new StrokeCollection(send.Select(p => p.Value.Clone()));
            if (req.WhiteInkToBlack) OneNoteExport.WhiteToBlack(strokes);
            OneNoteExport.SeeThroughHighlighters(strokes);
            var b = strokes.GetBounds();
            strokes.Transform(new Matrix(1, 0, 0, 1, -b.Left, -b.Top), false);
            using var ms = new MemoryStream();
            strokes.Save(ms, false);
            changes.Add(new XElement(one + "InkDrawing",
                Position((b.Left - req.Origin - state.Dx) * PtPerPx, (b.Top - req.Origin - state.Dy) * PtPerPx, ++z),
                new XElement(one + "Size", new XAttribute("width", F(b.Width * PtPerPx)), new XAttribute("height", F(b.Height * PtPerPx))),
                new XElement(one + "Data", Convert.ToBase64String(ms.ToArray()))));
        }

        if (changes.Count > 0)
        {
            var page = new XElement(one + "Page", new XAttribute("ID", state.PageId));
            if (usesTodo) AddTodoTag(root, page, changes);
            page.Add(changes);
            app.UpdatePageContent(new XDocument(page).ToString(SaveOptions.DisableFormatting), DateTime.MinValue, OneNote.Xs2013, false);
        }

        // Cards removed here. (A card that's inside a box goes with its paragraph's object.)
        foreach (var card in state.Cards.Where(c => !nodes.ContainsKey(c.NodeId)).ToList())
        {
            state.Cards.Remove(card);
            if (card.Kind != "title") Delete(app, state.PageId, card.ObjectId);
        }
        foreach (var id in dropDrawings)
        {
            Delete(app, state.PageId, id);
            state.Drawings.Remove(id);
        }

        // Read back what OneNote made of it.
        var after = OneNoteSync.Page(app, state.PageId).Root!;
        var known = state.Cards.Select(c => c.ObjectId).ToHashSet();
        foreach (var (node, name, x, y) in created)
        {
            var e = after.Elements(one + name).Where(o => !known.Contains(o.Attribute("objectID")?.Value ?? ""))
                .OrderBy(o => Math.Abs(Num(o.Element(one + "Position")?.Attribute("x")) - x) + Math.Abs(Num(o.Element(one + "Position")?.Attribute("y")) - y)).FirstOrDefault();
            if (e == null) continue;
            var id = e.Attribute("objectID")!.Value;
            known.Add(id);
            state.Cards.Add(new CanvasSyncCard { NodeId = node.Id, ObjectId = id, Kind = node.Kind, Text = node.Text, X = node.X, Y = node.Y, W = node.W, H = node.H });
        }
        var drawings = after.Elements(one + "InkDrawing").Where(d => d.Attribute("objectID") != null).ToList();
        var added = drawings.Where(d => !state.Drawings.ContainsKey(d.Attribute("objectID")!.Value)).ToList();
        if (send.Count > 0 && added.Count > 0)
        {
            // Ours is the new one (nothing else can have appeared: the page had no edits of its own just now).
            var ours = added.OrderByDescending(d => Num(d.Element(one + "Position")?.Attribute("z"))).First().Attribute("objectID")!.Value;
            foreach (var p in send) state.Strokes[p.Key] = ours;
        }
        state.Drawings = drawings.ToDictionary(d => d.Attribute("objectID")!.Value, DrawingSig);
        foreach (var card in state.Cards) Remember(card, after);
        state.LastModified = OneNoteSync.LastModified(app, state.PageId);
        Save(req.StatePath, state);
        return state;
    }

    /// <summary>OneNote numbers a page's tags: use the page's To Do if it has one, else the next free number.</summary>
    static void AddTodoTag(XElement root, XElement page, List<XElement> objects)
    {
        var defs = root.Elements(one + "TagDef").ToList();
        var todo = defs.FirstOrDefault(d => d.Attribute("name")?.Value == "To Do");
        int index = todo != null ? (int)Num(todo.Attribute("index")) : defs.Select(d => (int)Num(d.Attribute("index"))).DefaultIfEmpty(-1).Max() + 1;
        if (todo == null)
        {
            page.Add(new XElement(one + "TagDef", new XAttribute("index", index), new XAttribute("type", 0), new XAttribute("symbol", 3),
                new XAttribute("fontColor", "automatic"), new XAttribute("highlightColor", "none"), new XAttribute("name", "To Do")));
        }
        foreach (var tag in objects.SelectMany(o => o.Descendants(one + "Tag")).Where(t => t.Attribute("objectID") == null && t.Attribute("creationDate") == null))
            tag.SetAttributeValue("index", index);
    }

    static void Delete(IOneNoteApplication app, string pageId, string objectId)
    {
        try { app.DeletePageContent(pageId, objectId, DateTime.MinValue, false); }
        catch (System.Runtime.InteropServices.COMException e) when ((uint)e.HResult is 0x80042014 or 0x80042002 or 0x80042012)
        {
            Protocol.Log($"canvas sync: object to delete is already gone ({e.HResult:X8})");
        }
    }

    /// <summary>What a card's object is like on the page now, to tell later edits in OneNote from this.</summary>
    static void Remember(CanvasSyncCard card, XElement root)
    {
        if (card.Kind == "title") return;
        var e = root.Descendants().FirstOrDefault(x => x.Attribute("objectID")?.Value == card.ObjectId);
        if (e == null) return;
        if (card.Kind == "text") card.Hash = OneNoteToMarkdown.Fingerprint(e);
        var pos = e.Element(one + "Position");
        var size = e.Element(one + "Size");
        card.PageX = Num(pos?.Attribute("x"));
        card.PageY = Num(pos?.Attribute("y"));
        card.PageW = Num(size?.Attribute("width"));
        card.PageH = Num(size?.Attribute("height"));
    }

    // ---------- page -> canvas ----------

    public sealed record PullResult(List<CanvasCardChange> Changes, CanvasSyncState State, string? TempDir, HashSet<string> RemoveStrokes, StrokeCollection AddStrokes, bool KeptInk);

    /// <summary>
    /// What the page has that the canvas doesn't. Text edited on both sides keeps the canvas's, which the next
    /// send puts on the page. A box the page no longer has only takes its card with it when asked by hand: a
    /// background pull leaves the card, and the next send puts it back on the page.
    /// </summary>
    public static PullResult Pull(CanvasPullRequest req)
    {
        var app = OneNote.Connect();
        var state = Load(req.StatePath) ?? throw new InvalidOperationException("This canvas isn't linked to a OneNote page.");
        var root = OneNoteSync.Page(app, state.PageId).Root!;
        var nodes = req.Nodes.ToDictionary(n => n.Id);
        var cardsById = state.Cards.Where(c => c.Kind != "title").GroupBy(c => c.ObjectId).ToDictionary(g => g.Key, g => g.First());
        var changes = new List<CanvasCardChange>();

        // Reading new pictures needs their data, and a page's full read takes a while: only when there are some.
        var known = cardsById.Keys.ToHashSet();
        var hasNew = root.Descendants().Any(e => (e.Name == one + "Image" || e.Name == one + "InsertedFile") && !known.Contains(OneNoteImport.ObjectIdOf(e)));
        string? temp = null;
        var read = root;
        if (hasNew)
        {
            app.GetPageContent(state.PageId, out var xml, 1 /* piBinaryData */, OneNote.Xs2013);
            read = XDocument.Parse(xml).Root!;
            temp = Path.Combine(Path.GetTempPath(), "onesidian-import-" + Guid.NewGuid().ToString("N"));
            Directory.CreateDirectory(temp);
        }
        var pageCards = OneNoteImport.BuildCards(read, temp);
        foreach (var c in pageCards) { c.X += state.Dx; c.Y += state.Dy; }

        var seen = new HashSet<string>();
        foreach (var pc in pageCards)
        {
            if (pc.ObjectId == "title")
            {
                var titleCard = state.Cards.FirstOrDefault(c => c.Kind == "title");
                seen.Add("title");
                if (titleCard == null || titleCard.Hash == pc.Hash) continue;
                bool bothEdited = nodes.TryGetValue(titleCard.NodeId, out var tn) && tn.Text != titleCard.Text;
                titleCard.Hash = pc.Hash;
                if (bothEdited) continue;
                changes.Add(new CanvasCardChange { NodeId = titleCard.NodeId, OldText = titleCard.Text, Markdown = pc.Markdown });
                titleCard.Text = pc.Markdown ?? "";
                continue;
            }
            seen.Add(pc.ObjectId);
            if (!cardsById.TryGetValue(pc.ObjectId, out var card))
            {
                var fresh = new CanvasSyncCard
                {
                    NodeId = pc.NodeId, ObjectId = pc.ObjectId, Kind = pc.Kind, Inside = pc.Inside, Hash = pc.Hash, Text = pc.Markdown ?? "",
                    X = pc.X, Y = pc.Y, W = pc.W, H = pc.H, PageX = pc.PageX, PageY = pc.PageY, PageW = pc.PageW, PageH = pc.PageH,
                };
                state.Cards.Add(fresh);
                changes.Add(new CanvasCardChange { Op = "new", NodeId = pc.NodeId, Card = pc });
                continue;
            }
            var change = new CanvasCardChange { NodeId = card.NodeId };
            bool any = false;
            nodes.TryGetValue(card.NodeId, out var node);
            if (card.Kind == "text" && pc.Hash != card.Hash)
            {
                if (node == null || node.Text == card.Text)
                {
                    change.OldText = card.Text;
                    change.Markdown = pc.Markdown;
                    card.Text = pc.Markdown ?? "";
                    any = true;
                }
                card.Hash = pc.Hash;
            }
            bool pageMoved = !card.Inside && (Math.Abs(pc.PageX - card.PageX) > Slop || Math.Abs(pc.PageY - card.PageY) > Slop);
            if (pageMoved)
            {
                card.PageX = pc.PageX;
                card.PageY = pc.PageY;
                // Moved on both sides: this canvas's place wins, and the next send moves the object.
                if (node == null || (Math.Abs(node.X - card.X) <= 1 && Math.Abs(node.Y - card.Y) <= 1))
                {
                    change.X = pc.X;
                    change.Y = pc.Y;
                    card.X = pc.X;
                    card.Y = pc.Y;
                    any = true;
                }
            }
            bool pageResized = !card.Inside && card.Kind != "file" && (Math.Abs(pc.PageW - card.PageW) > Slop || (card.Kind == "image" && Math.Abs(pc.PageH - card.PageH) > Slop));
            if (pageResized)
            {
                card.PageW = pc.PageW;
                card.PageH = pc.PageH;
                if (node == null || Math.Abs(node.W - card.W) <= 1)
                {
                    change.W = pc.W;
                    card.W = pc.W;
                    if (card.Kind == "image") { change.H = pc.H; card.H = pc.H; }
                    any = true;
                }
            }
            if (any) changes.Add(change);
        }

        foreach (var card in state.Cards.Where(c => c.Kind != "title" && !seen.Contains(c.ObjectId)).ToList())
        {
            state.Cards.Remove(card);
            if (req.Manual) changes.Add(new CanvasCardChange { Op = "delete", NodeId = card.NodeId, OldText = card.Text });
        }

        // The ink, by drawing: read only those that are new or changed.
        var drawings = root.Elements(one + "InkDrawing").Where(d => d.Attribute("objectID") != null).ToList();
        var pageIds = drawings.Select(d => d.Attribute("objectID")!.Value).ToHashSet();
        var removed = state.Drawings.Keys.Where(id => !pageIds.Contains(id)).ToHashSet();
        var fresher = drawings.Where(d => !state.Drawings.TryGetValue(d.Attribute("objectID")!.Value, out var sig) || sig != DrawingSig(d)).ToList();
        var removeKeys = new HashSet<string>();
        var addStrokes = new StrokeCollection();
        // A page with no ink at all is far more often one OneNote didn't finish than one where it was all erased.
        bool keptInk = drawings.Count == 0 && state.Drawings.Count > 0;
        if (!keptInk)
        {
            foreach (var d in fresher)
            {
                var id = d.Attribute("objectID")!.Value;
                if (state.Drawings.ContainsKey(id)) removed.Add(id);
            }
            foreach (var p in state.Strokes.Where(p => removed.Contains(p.Value)).ToList())
            {
                removeKeys.Add(p.Key);
                state.Strokes.Remove(p.Key);
            }
            foreach (var id in removed) state.Drawings.Remove(id);
            foreach (var d in fresher)
            {
                var id = d.Attribute("objectID")!.Value;
                state.Drawings[id] = DrawingSig(d);
                var strokes = DrawingInk(app, state.PageId, d, state.Dx + req.Origin, state.Dy + req.Origin);
                if (strokes == null) continue;
                foreach (var s in strokes)
                {
                    var key = StrokeKey(s);
                    if (!state.Strokes.TryAdd(key, id)) continue;
                    // The same stroke coming back in a new drawing is one the canvas still has.
                    if (!removeKeys.Remove(key)) addStrokes.Add(s);
                }
            }
        }
        state.LastModified = OneNoteSync.LastModified(app, state.PageId);
        return new PullResult(changes, state, temp, removeKeys, addStrokes, keptInk);
    }
}

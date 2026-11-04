using System;
using System.Collections.Generic;
using System.Linq;
using System.Windows;
using System.Windows.Ink;
using System.Windows.Media;

namespace InkOverlay;

/// <summary>
/// Keeps ink with the text it was written by. Live Preview and Reading view lay the same lines out at
/// different heights, and the note's lines move as it's edited (by you, other plugins, sync), so fixed
/// page positions drift.
///
/// Each stroke stores an anchor in the ISF file: its 0-based source line, that line's top (in the same
/// coordinates as the stroke's points), and a reference to nearby text: the fingerprint of the nearest
/// unique line of text above it (and below, as a fallback) with its distance in lines. When the plugin
/// reports the note's lines (positions + fingerprints), each anchor first finds its reference text again,
/// which gives its line in the note as it is now, then the stroke moves by (that line's top − stored top).
/// This is a display projection: saves retain canonical geometry until a deliberate ink edit changes it.
/// Strokes written together (a word, a drawing) share one anchor so they move as a unit.
///
/// On a canvas the "lines" are the board (line 0, which never moves) and the cards, which move both ways, so
/// an anchor also keeps its card's left, and its reference is the card itself (see FollowCards).
/// </summary>
public sealed partial class OverlayWindow
{
    internal static readonly Guid AnchorLineId = new("3b1d6f0e-8a2c-4f5b-9e71-2c4d5a6b7c8d");
    internal static readonly Guid AnchorTopId = new("3b1d6f0e-8a2c-4f5b-9e71-2c4d5a6b7c8e");
    internal static readonly Guid AboveHashId = new("3b1d6f0e-8a2c-4f5b-9e71-2c4d5a6b7c90");
    internal static readonly Guid AboveOffsetId = new("3b1d6f0e-8a2c-4f5b-9e71-2c4d5a6b7c91");
    internal static readonly Guid BelowHashId = new("3b1d6f0e-8a2c-4f5b-9e71-2c4d5a6b7c92");
    internal static readonly Guid BelowOffsetId = new("3b1d6f0e-8a2c-4f5b-9e71-2c4d5a6b7c93");
    /// <summary>
    /// Anchored with lines inside one-piece blocks spread over the block (2). Without it, an anchor from when
    /// they all had the block's top: re-anchored once, in Live Preview (see MigrateBlockAnchors).
    /// </summary>
    internal static readonly Guid AnchorModelId = new("3b1d6f0e-8a2c-4f5b-9e71-2c4d5a6b7c94");
    /// <summary>On a canvas: the left of the card the stroke is anchored to.</summary>
    internal static readonly Guid AnchorLeftId = new("3b1d6f0e-8a2c-4f5b-9e71-2c4d5a6b7c95");

    const double GroupMs = 1500;    // strokes this soon after the last one, and...
    const double GroupGap = 40;     // ...this close to it, belong to the same word/drawing

    double[]? tops;
    double[]? blockTops;            // Live Preview: lines at their block's top, as anchors before model 2 had them
    double[]? lefts, widths, heights; // a canvas: with `tops`, the rectangle of the board (0) and each card
    bool[]? papers;                 // a canvas: the cards that are pictures or PDFs (see ShowOnCards)
    int[]? hashes;                 // per line: fingerprint of its text, 0 = blank / frontmatter
    readonly Dictionary<int, int> hashCount = new();
    string? topsMode;
    int linesSeq;                   // which of the plugin's line positions these are (0: not a note's)
    (int from, int to) measured;
    Command? pendingLines;
    readonly HashSet<Stroke> unanchoredNew = new();
    bool importing;                 // ink being replaced wholesale (pull from OneNote): anchored as a batch
    Stroke? lastStroke;
    DateTime lastStrokeAt;

    bool OnCanvas => lefts != null;

    internal StrokeCollection Strokes => ink.Strokes;
    internal System.Windows.Controls.InkCanvas Canvas => ink;
    internal DrawingAttributes PenAttributes => ink.DefaultDrawingAttributes;


    static bool TryGetAnchor(Stroke s, out int line, out double top)
    {
        line = 0;
        top = 0;
        if (!s.ContainsPropertyData(AnchorLineId) || !s.ContainsPropertyData(AnchorTopId)) return false;
        line = Convert.ToInt32(s.GetPropertyData(AnchorLineId));
        top = Convert.ToDouble(s.GetPropertyData(AnchorTopId));
        return true;
    }

    /// <summary>Anchor a stroke to a line, and (when the note's text is known) record the text around it.</summary>
    void SetAnchor(Stroke s, int line, double top, bool markModel = true)
    {
        s.AddPropertyData(AnchorLineId, line);
        s.AddPropertyData(AnchorTopId, top);
        if (markModel) s.AddPropertyData(AnchorModelId, 2);
        if (hashes == null || line < 0 || line >= hashes.Length) return;
        if (OnCanvas)
        {
            // Its reference is the card itself; there's no text around it to fall back on.
            s.AddPropertyData(AnchorLeftId, lefts![line]);
            SetRef(s, AboveHashId, AboveOffsetId, line, line);
            SetRef(s, BelowHashId, BelowOffsetId, -1, line);
            return;
        }
        SetRef(s, AboveHashId, AboveOffsetId, FindRef(line, -1), line);
        SetRef(s, BelowHashId, BelowOffsetId, FindRef(line + 1, +1), line);
    }

    void SetRef(Stroke s, Guid hashId, Guid offsetId, int refLine, int line)
    {
        if (refLine < 0)
        {
            if (s.ContainsPropertyData(hashId)) s.RemovePropertyData(hashId);
            if (s.ContainsPropertyData(offsetId)) s.RemovePropertyData(offsetId);
            return;
        }
        s.AddPropertyData(hashId, hashes![refLine]);
        s.AddPropertyData(offsetId, refLine - line);
    }

    /// <summary>Nearest line of text from `start` in `step` direction, preferring text that's unique in the note.</summary>
    int FindRef(int start, int step)
    {
        int any = -1;
        for (int r = start; r >= 0 && r < hashes!.Length; r += step)
        {
            if (hashes[r] == 0) continue;
            if (hashCount.TryGetValue(hashes[r], out var n) && n == 1) return r;
            if (any < 0) any = r;
        }
        return any;
    }

    /// <summary>Where a stroke's line is in the note as it is now: found again through its reference text.</summary>
    int Relocate(Stroke s, int line)
    {
        if (hashes == null) return line;
        foreach (var (hashId, offsetId) in new[] { (AboveHashId, AboveOffsetId), (BelowHashId, BelowOffsetId) })
        {
            if (!s.ContainsPropertyData(hashId) || !s.ContainsPropertyData(offsetId)) continue;
            int hash = Convert.ToInt32(s.GetPropertyData(hashId));
            int k = Convert.ToInt32(s.GetPropertyData(offsetId));
            int j = FindNearest(hash, line + k);
            if (j >= 0) return j - k;
        }
        return line; // its text is gone (edited away): keep the line it had
    }

    /// <summary>The line with this fingerprint closest to where it was last seen.</summary>
    int FindNearest(int hash, int guess)
    {
        int n = hashes!.Length;
        int g = Math.Clamp(guess, 0, n - 1);
        for (int d = 0; d < n; d++)
        {
            if (g - d >= 0 && hashes[g - d] == hash) return g - d;
            if (g + d < n && hashes[g + d] == hash) return g + d;
            if (g - d < 0 && g + d >= n) break;
        }
        return -1;
    }

    /// <summary>Line positions for a note. Applied now if it's the loaded note, else kept for when it loads.</summary>
    void OnLines(Command cmd)
    {
        if (cmd.Tops == null || cmd.InkPath == null) return;
        if (cmd.InkPath != inkPath)
        {
            pendingLines = cmd;
            return;
        }
        ApplyLines(cmd);
    }

    void ApplyLines(Command cmd)
    {
        if (!LooksLikeThisNote(cmd))
        {
            Protocol.Log($"lines ignored: {cmd.Tops!.Length} lines whose text matches almost none of the text this ink is anchored to (another note's?)");
            return;
        }
        if (cmd.Mode != topsMode)
            Protocol.Log($"lines: {cmd.Mode}, {cmd.Tops!.Length} lines, measured {cmd.MeasuredFrom}-{cmd.MeasuredTo}");
        tops = cmd.Tops;
        blockTops = cmd.Mode == "source" && cmd.BlockTops?.Length == cmd.Tops!.Length ? cmd.BlockTops : null;
        bool canvas = cmd.Mode == "canvas" && cmd.Lefts?.Length == cmd.Tops!.Length && cmd.Widths?.Length == cmd.Tops.Length && cmd.Heights?.Length == cmd.Tops.Length;
        lefts = canvas ? cmd.Lefts : null;
        widths = canvas ? cmd.Widths : null;
        heights = canvas ? cmd.Heights : null;
        papers = canvas && cmd.Papers?.Length == cmd.Tops!.Length ? cmd.Papers : null;
        hashes = cmd.Hashes != null && cmd.Hashes.Length == cmd.Tops!.Length ? cmd.Hashes : null;
        hashCount.Clear();
        if (hashes != null) foreach (var h in hashes) if (h != 0) hashCount[h] = hashCount.GetValueOrDefault(h) + 1;
        topsMode = cmd.Mode;
        linesSeq = cmd.Seq ?? 0;
        measured = (cmd.MeasuredFrom ?? 0, cmd.MeasuredTo ?? int.MaxValue);
        // Room to draw down to the last line (a note), or to the end of the last page (a PDF: its pages are all
        // there is; see SizeInk for why it shouldn't be bigger than needed).
        // A canvas goes every way: the plugin says how big.
        if (canvas && cmd.Extent is double extent && extent > 0) wantedWidth = wantedHeight = extent;
        else if (tops!.Length > 0) wantedHeight = topsMode == "page" ? tops[^1] + 2_000 : Math.Max(200_000, tops[^1] + 20_000);
        SizeInk();
        Reanchor();
        if (papers != null && ShowOnCards(ink.Strokes)) SchedulePublish();
    }

    /// <summary>
    /// A backstop against being handed another note's lines (they'd move every stroke onto that note's
    /// layout): the text the ink is anchored to must mostly be in them. Rewriting a few lines is fine;
    /// a note where almost none of it is left is not this note.
    /// </summary>
    bool LooksLikeThisNote(Command cmd)
    {
        if (cmd.Mode == "canvas" || cmd.Hashes == null || cmd.Hashes.Length != cmd.Tops!.Length) return true;
        var refs = new HashSet<int>();
        foreach (var s in ink.Strokes)
            foreach (var id in new[] { AboveHashId, BelowHashId })
                if (s.ContainsPropertyData(id)) refs.Add(Convert.ToInt32(s.GetPropertyData(id)));
        refs.Remove(0);
        if (refs.Count < 3) return true;
        var present = new HashSet<int>(cmd.Hashes);
        int found = refs.Count(present.Contains);
        return found * 10 >= refs.Count * 3;
    }

    /// <summary>Called after a note loads: forget the old note's lines, pick up any that arrived early.</summary>
    void ResetAnchors()
    {
        tops = null;
        blockTops = null;
        lefts = widths = heights = null;
        papers = null;
        hashes = null;
        hashCount.Clear();
        topsMode = null;
        linesSeq = 0;
        unanchoredNew.Clear();
        lastStroke = null;
        wantedHeight = 200_000;
        wantedWidth = 16_000;
        SizeInk();
        if (pendingLines is { } p && p.InkPath == inkPath)
        {
            pendingLines = null;
            ApplyLines(p);
        }
    }

    /// <summary>Move every stroke to where its line is now.</summary>
    internal void Reanchor()
    {
        if (tops == null || tops.Length == 0) return;
        using var projection = document.Project();
        bool moved = false;

        // Strokes drawn this session before any line positions arrived: anchor in drawing order.
        foreach (var s in ink.Strokes.Where(unanchoredNew.Contains).ToList())
        {
            AnchorNew(s);
            document.MarkGeometry(s); // initial anchor for newly drawn ink, not a layout rewrite
        }
        unanchoredNew.Clear();
        // Ink from before anchors existed was written in Live Preview, so anchor it against that layout
        // only, in clusters so a drawing made of separate strokes stays in one piece.
        // (Never against Reading view; PDF pages and images are fully measured, so anchor there too.)
        if (topsMode != "preview") AnchorLegacy(ink.Strokes.Where(s => !TryGetAnchor(s, out _, out _)).ToList());
        if (blockTops != null && MigrateBlockAnchors()) moved = true;

        if (OnCanvas && FollowCards()) moved = true;

        int skipped = 0;
        if (!OnCanvas) foreach (var s in ink.Strokes)
        {
            if (!TryGetAnchor(s, out var line, out var refTop)) continue;
            // Placed by MigrateBlockAnchors already (and still on the older anchor, off screen).
            if (blockTops != null && !s.ContainsPropertyData(AnchorModelId)) continue;
            line = Relocate(s, line);
            // A line the note doesn't have right now (it's still loading, or the text was cut): leave the
            // stroke exactly as it is, anchor and all, rather than forcing it onto some other line.
            if (line < 0 || line >= tops.Length) { skipped++; continue; }
            if (line < measured.from || line > measured.to) continue;
            double d = tops[line] - refTop;
            if (Math.Abs(d) > 1e-9)
            {
                s.Transform(new Matrix(1, 0, 0, 1, 0, d), false);
                moved = true;
            }
            // Moving an old anchor in Reading view is not its migration: that needs a measured Live
            // Preview block. Preserve its old model until MigrateBlockAnchors has actually repaired it.
            SetAnchor(s, line, tops[line], markModel: s.ContainsPropertyData(AnchorModelId));
        }
        if (skipped > 0) Protocol.Log($"{skipped} strokes are on lines past the end of the note ({tops.Length} lines); left as they are");
        if (moved)
        {
            // A card move changes the canvas document. Text/PDF layout only projects the drawing.
            if (OnCanvas)
            {
                foreach (var s in ink.Strokes) document.MarkGeometry(s);
                dirty = true;
                saveDebounce.Stop();
                saveDebounce.Start();
            }
            SendExtent();
        }
    }

    /// <summary>
    /// A canvas: ink on a card goes where the card went. A card that isn't there (deleted, or the canvas is
    /// still loading) leaves its ink where it is, still anchored to it, so undoing the delete brings the two
    /// back together. True if any ink moved or was anchored afresh.
    /// </summary>
    bool FollowCards()
    {
        if (hashes == null) return false;
        bool changed = false;
        foreach (var s in ink.Strokes)
        {
            if (!TryGetAnchor(s, out var line, out var refTop)) continue;
            if (!s.ContainsPropertyData(AboveHashId) || !s.ContainsPropertyData(AnchorLeftId))
            {
                int at = LineFor(s.GetBounds());
                SetAnchor(s, at, tops![at]);
                changed = true;
                continue;
            }
            int card = Array.IndexOf(hashes, Convert.ToInt32(s.GetPropertyData(AboveHashId)));
            if (card < 0) continue;
            double dx = lefts![card] - Convert.ToDouble(s.GetPropertyData(AnchorLeftId)), dy = tops![card] - refTop;
            bool shift = Math.Abs(dx) >= 0.25 || Math.Abs(dy) >= 0.25;
            if (shift)
            {
                s.Transform(new Matrix(1, 0, 0, 1, dx, dy), false);
                changed = true;
            }
            if (shift || card != line) SetAnchor(s, card, tops[card]);
        }
        return changed;
    }

    /// <summary>
    /// The note had `count` lines inserted at `from` (or −count removed there): every anchor that refers to a
    /// line at or below `from` moves with it, so ink under inserted space moves down with its text, and
    /// references to text above stay put. Positions follow when the new line positions arrive.
    /// </summary>
    internal void ShiftLines(int from, int count)
    {
        if (count == 0) return;
        int Map(int line) => line < from ? line : count > 0 ? line + count : Math.Max(from, line + count);
        foreach (var s in ink.Strokes)
        {
            document.EditAnchors(s, stroke =>
            {
                if (!TryGetAnchor(stroke, out var line, out _)) return;
                int moved = Map(line);
                stroke.AddPropertyData(AnchorLineId, moved);
                foreach (var offsetId in new[] { AboveOffsetId, BelowOffsetId })
                {
                    if (!stroke.ContainsPropertyData(offsetId)) continue;
                    int refLine = line + Convert.ToInt32(stroke.GetPropertyData(offsetId));
                    stroke.AddPropertyData(offsetId, Map(refLine) - moved);
                }
            });
        }
        // Strokes waiting for line positions keep theirs; the rest move when the note's new lines arrive.
        dirty = true;
        saveDebounce.Stop();
        saveDebounce.Start();
    }

    /// <summary>A stroke just added (drawn, shape-converted, split by the point eraser).</summary>
    void OnStrokeAdded(Stroke s)
    {
        if (!s.ContainsPropertyData(StrokeTimeId)) s.AddPropertyData(StrokeTimeId, DateTime.UtcNow.Ticks);
        if (TryGetAnchor(s, out _, out _)) { lastStroke = s; lastStrokeAt = DateTime.Now; return; }
        if (tops == null) unanchoredNew.Add(s);
        else AnchorNew(s);
        lastStroke = s;
        lastStrokeAt = DateTime.Now;
    }

    void AnchorNew(Stroke s)
    {
        if (tops == null) return;
        var b = s.GetBounds();

        // Continuing the word/drawing just written: share its anchor.
        if (lastStroke != null && lastStroke != s && ink.Strokes.Contains(lastStroke)
            && (DateTime.Now - lastStrokeAt).TotalMilliseconds < GroupMs
            && Gap(lastStroke.GetBounds(), b) < GroupGap
            && TryGetAnchor(lastStroke, out var l1, out var t1))
        {
            SetAnchor(s, l1, t1, markModel: lastStroke.ContainsPropertyData(AnchorModelId));
            return;
        }
        // Touching existing ink (a cross on a t, an arrow onto a diagram): share that anchor.
        foreach (var other in ink.Strokes)
        {
            if (other == s || !TryGetAnchor(other, out var l2, out var t2)) continue;
            if (Gap(other.GetBounds(), b) < 3 && Touching(other, s, 3))
            {
                SetAnchor(s, l2, t2, markModel: other.ContainsPropertyData(AnchorModelId));
                return;
            }
        }
        // Otherwise: the line (or card) under the stroke's middle.
        int line = LineFor(b);
        SetAnchor(s, line, tops[line]);
    }

    // Only strokes that touch (pen widths overlap, a couple of px of slack). Anything looser chains dense
    // handwriting into one block tied to a single line, which then moves as a slab.
    const double LegacyClusterGap = 2;

    /// <summary>Anchor pre-existing strokes in clusters (strokes that touch).</summary>
    void AnchorLegacy(List<Stroke> strokes)
    {
        if (tops == null || strokes.Count == 0) return;
        int anchored = 0;
        foreach (var (cluster, b) in Clusters(strokes))
        {
            int line = LineFor(b);
            // Only against measured lines: an estimated position would make the ink jump once it's measured.
            // Clusters further away get anchored when scrolled near.
            if (line < measured.from || line > measured.to) continue;
            foreach (var s in cluster) SetAnchor(s, line, tops[line]);
            anchored += cluster.Count;
        }
        if (anchored > 0) Protocol.Log($"anchored {anchored} older strokes to their lines");
    }

    /// <summary>Strokes that touch, together, with their bounds: a drawing made of separate strokes stays one piece.</summary>
    static IEnumerable<(List<Stroke> strokes, Rect bounds)> Clusters(List<Stroke> strokes)
    {
        var bounds = strokes.Select(s => s.GetBounds()).ToList();
        var parent = Enumerable.Range(0, strokes.Count).ToArray();
        int Find(int i) { while (parent[i] != i) i = parent[i] = parent[parent[i]]; return i; }
        for (int i = 0; i < strokes.Count; i++)
            for (int j = i + 1; j < strokes.Count; j++)
                if (Gap(bounds[i], bounds[j]) < LegacyClusterGap && Touching(strokes[i], strokes[j], LegacyClusterGap))
                    parent[Find(i)] = Find(j);
        foreach (var group in Enumerable.Range(0, strokes.Count).GroupBy(Find))
        {
            var b = Rect.Empty;
            foreach (var i in group) b.Union(bounds[i]);
            yield return (group.Select(i => strokes[i]).ToList(), b);
        }
    }

    /// <summary>
    /// Ink anchored before lines inside one-piece blocks (columns, maths, tables, callouts) were spread down
    /// the block, when all of a block's lines had its top: everything written beside a tall block was tied to
    /// its last line, and in Reading view that line is below the block. In Live Preview (blockTops), put such
    /// ink where that anchor had it, then anchor it afresh to the line it's beside, in clusters. Ink not by
    /// such a block just takes the new mark. Off-screen clusters wait (their lines are only estimates) and
    /// keep the older anchor. True if display points or anchor metadata changed; canonical ink is retained.
    /// </summary>
    bool MigrateBlockAnchors()
    {
        bool changed = false;
        var inBlocks = new List<Stroke>();
        foreach (var s in ink.Strokes)
        {
            if (s.ContainsPropertyData(AnchorModelId) || !TryGetAnchor(s, out var oldLine, out var refTop)) continue;
            int line = Relocate(s, oldLine);
            if (line < 0 || line >= tops!.Length) continue;
            if (line < measured.from || line > measured.to) continue;
            double d = blockTops![line] - refTop;
            if (Math.Abs(d) > 1e-9)
            {
                s.Transform(new Matrix(1, 0, 0, 1, 0, d), false);
                changed = true;
            }
            if (Math.Abs(blockTops[line] - tops[line]) < 0.25)
            {
                SetAnchor(s, line, tops[line]);
                changed = true;
            }
            else
            {
                s.AddPropertyData(AnchorLineId, line);
                s.AddPropertyData(AnchorTopId, blockTops[line]);
                if (line != oldLine) changed = true;
                inBlocks.Add(s);
            }
        }
        int anchored = 0;
        foreach (var (cluster, b) in Clusters(inBlocks))
        {
            int line = LineAt(b.Top + b.Height / 2);
            if (line < measured.from || line > measured.to) continue;
            foreach (var s in cluster) SetAnchor(s, line, tops![line]);
            changed = true;
            anchored += cluster.Count;
        }
        if (anchored > 0) Protocol.Log($"re-anchored {anchored} strokes beside blocks to the lines they're by");
        return changed;
    }

    /// <summary>Strokes moved or resized with the lasso: re-anchor them together where they landed.</summary>
    void AnchorSelection()
    {
        if (tops == null) return;
        var sel = ink.GetSelectedStrokes();
        if (sel.Count == 0) return;
        int line = LineFor(sel.GetBounds());
        foreach (var s in sel)
        {
            SetAnchor(s, line, tops[line]);
            document.MarkGeometry(s);
        }
    }

    /// <summary>What ink in this box belongs to: the line under its middle, or on a canvas the card under it.</summary>
    int LineFor(Rect b)
    {
        double x = b.Left + b.Width / 2, y = b.Top + b.Height / 2;
        if (!OnCanvas) return LineAt(y);
        // Cards come bottom first: the one on top wins. Not on a card: the board.
        for (int i = tops!.Length - 1; i > 0; i--)
            if (x >= lefts![i] && x <= lefts[i] + widths![i] && y >= tops[i] && y <= tops[i] + heights![i]) return i;
        return 0;
    }

    int LineAt(double y)
    {
        // Last line whose top is at or above y.
        int lo = 0, hi = tops!.Length - 1, ans = 0;
        while (lo <= hi)
        {
            int mid = (lo + hi) / 2;
            if (tops[mid] <= y) { ans = mid; lo = mid + 1; }
            else hi = mid - 1;
        }
        return ans;
    }

    /// <summary>The ink itself touches: some pair of points closer than the two pen radii plus slack.</summary>
    static bool Touching(Stroke a, Stroke b, double slack)
    {
        double reach = (a.DrawingAttributes.Width + b.DrawingAttributes.Width) / 2 + slack;
        double reach2 = reach * reach;
        foreach (var p in a.StylusPoints)
            foreach (var q in b.StylusPoints)
            {
                double dx = p.X - q.X, dy = p.Y - q.Y;
                if (dx * dx + dy * dy <= reach2) return true;
            }
        return false;
    }

    static double Gap(Rect a, Rect b)
    {
        double dx = Math.Max(0, Math.Max(a.Left - b.Right, b.Left - a.Right));
        double dy = Math.Max(0, Math.Max(a.Top - b.Bottom, b.Top - a.Bottom));
        return Math.Sqrt(dx * dx + dy * dy);
    }
}

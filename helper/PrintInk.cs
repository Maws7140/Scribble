using System;
using System.Collections.Generic;
using System.IO;
using System.Linq;
using System.Windows;
using System.Windows.Ink;
using System.Windows.Media;
using System.Windows.Media.Imaging;

namespace InkOverlay;

/// <summary>A printable stroke, with its text anchor and bounds in saved ink coordinates.</summary>
public sealed class PrintStroke
{
    public int Line { get; set; }
    public double Top { get; set; }
    public double X { get; set; }
    public double Y { get; set; }
    public double W { get; set; }
    public double H { get; set; }
    public string? D { get; set; }
    public string? Img { get; set; }
    public string C { get; set; } = "";
    public double O { get; set; } = 1;
    public bool Hl { get; set; }
}

public sealed partial class OverlayWindow
{
    /// <summary>Project an export copy to its text layout without changing the saved document.</summary>
    internal static StrokeCollection ProjectForExport(StrokeCollection source, double[]? targetTops, int[]? targetHashes)
    {
        var copy = source.Clone();
        if (targetTops == null) return copy;
        foreach (var stroke in copy)
        {
            if (!TryGetAnchor(stroke, out var line, out var top)) continue;
            line = PrintLine(stroke, line, targetHashes);
            if (line < 0 || line >= targetTops.Length || !double.IsFinite(targetTops[line])) continue;
            double by = targetTops[line] - top;
            if (Math.Abs(by) > 1e-9) stroke.Transform(new Matrix(1, 0, 0, 1, 0, by), false);
            stroke.AddPropertyData(AnchorLineId, line);
            stroke.AddPropertyData(AnchorTopId, targetTops[line]);
        }
        return copy;
    }

    /// <summary>Capture unsaved strokes quickly; the separate renderer does all PDF drawing work.</summary>
    void SnapshotForPrint(Command cmd)
    {
        try
        {
            string? data = null;
            if (cmd.InkPath == inkPath)
            {
                var copy = document.Snapshot(ink.Strokes);
                ToTrueColors(copy);
                using var bytes = new MemoryStream();
                copy.Save(bytes, true);
                data = Convert.ToBase64String(bytes.ToArray());
            }
            Protocol.Send(new { type = "print-snapshot", id = cmd.Id, data });
        }
        catch (Exception e)
        {
            Protocol.Send(new { type = "print-snapshot", id = cmd.Id, error = "Could not snapshot ink for PDF export: " + e.Message });
        }
    }

    /// <summary>A short-lived STA process: reads ink, draws it for paper, exits without an overlay or saves.</summary>
    internal static int RunPrintWorker()
    {
        try
        {
            var cmd = Protocol.Parse(Console.ReadLine() ?? "") ?? throw new InvalidDataException("Missing print request.");
            StrokeCollection copy;
            if (cmd.Snapshot != null)
            {
                using var bytes = new MemoryStream(Convert.FromBase64String(cmd.Snapshot));
                copy = new StrokeCollection(bytes);
            }
            else if (File.Exists(cmd.InkPath))
            {
                using var input = OpenInk(cmd.InkPath!);
                copy = new StrokeCollection(input);
            }
            else copy = new StrokeCollection();
            Protocol.Send(new { type = "print-ink", strokes = PrintableStrokes(copy, cmd.Hashes, cmd.Tops, cmd.Mode == "preview" && cmd.Dark) });
            return 0;
        }
        catch (Exception e)
        {
            Protocol.Send(new { type = "print-ink", error = "Could not render ink for PDF export: " + e.Message });
            return 1;
        }
    }

    internal static List<PrintStroke> PrintableStrokes(StrokeCollection copy, int[]? textHashes, double[]? sourceTops, bool dark = false)
    {
        ToTrueColors(copy);
        if (dark) ToDarkDisplay(copy);
        else ToLightDisplay(copy); // White handwriting must remain visible on white paper.
        Pens.Stylize(copy);
        var result = new List<PrintStroke>(copy.Count);
        foreach (var s in copy)
        {
            var bounds = s.GetBounds();
            int line;
            double top;
            if (TryGetAnchor(s, out line, out top)) line = PrintLine(s, line, textHashes);
            else
            {
                line = 0;
                if (sourceTops is { Length: > 0 })
                    for (int i = 0; i < sourceTops.Length; i++)
                        if (sourceTops[i] <= bounds.Top + bounds.Height / 2) line = i;
                top = sourceTops is { Length: > 0 } ? sourceTops[Math.Min(line, sourceTops.Length - 1)] : 0;
            }
            var da = s.DrawingAttributes;
            var item = new PrintStroke
            {
                Line = line, Top = top, X = bounds.X, Y = bounds.Y,
                W = Math.Max(0.01, bounds.Width), H = Math.Max(0.01, bounds.Height),
                C = $"#{da.Color.R:X2}{da.Color.G:X2}{da.Color.B:X2}",
                O = da.Color.A / 255.0 * (da.IsHighlighter ? 0.5 : 1), Hl = da.IsHighlighter,
            };
            if (s is StyledStroke styled)
            {
                if (Pens.StyleOf(da) == "pencil" && styled.PencilPng(da, out var at) is { } png)
                {
                    item.Img = png;
                    item.X = at.X; item.Y = at.Y; item.W = at.Width; item.H = at.Height;
                }
                else
                {
                    // Effect-pen gradients and graphite grain, at twice the printed resolution.
                    double scale = Math.Min(2, 4096 / Math.Max(item.W, item.H));
                    var visual = new DrawingVisual();
                    using (var dc = visual.RenderOpen())
                    {
                        dc.PushTransform(new ScaleTransform(scale, scale));
                        dc.PushTransform(new TranslateTransform(-item.X, -item.Y));
                        s.Draw(dc);
                    }
                    var bitmap = new RenderTargetBitmap(Math.Max(1, (int)Math.Ceiling(item.W * scale)),
                        Math.Max(1, (int)Math.Ceiling(item.H * scale)), 96, 96, PixelFormats.Pbgra32);
                    bitmap.Render(visual);
                    var encoder = new PngBitmapEncoder();
                    encoder.Frames.Add(BitmapFrame.Create(bitmap));
                    using var output = new MemoryStream();
                    encoder.Save(output);
                    item.Img = Convert.ToBase64String(output.ToArray());
                }
                item.O = 1;
            }
            else item.D = SvgPath(s.GetGeometry(da));
            result.Add(item);
        }
        return result;
    }

    static int PrintLine(Stroke s, int line, int[]? textHashes)
    {
        if (textHashes == null) return line;
        foreach (var (hashId, offsetId) in new[] { (AboveHashId, AboveOffsetId), (BelowHashId, BelowOffsetId) })
        {
            if (!s.ContainsPropertyData(hashId) || !s.ContainsPropertyData(offsetId)) continue;
            int hash = Convert.ToInt32(s.GetPropertyData(hashId));
            int offset = Convert.ToInt32(s.GetPropertyData(offsetId));
            int best = -1;
            for (int i = 0; i < textHashes.Length; i++)
                if (textHashes[i] == hash && (best < 0 || Math.Abs(i - line - offset) < Math.Abs(best - line - offset))) best = i;
            if (best >= 0) return best - offset;
        }
        return line;
    }
}

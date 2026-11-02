using System;
using System.Collections.Generic;
using System.Linq;
using System.Threading.Tasks;
using System.Windows;
using System.Windows.Controls;
using System.Windows.Ink;
using System.Windows.Input;
using System.Windows.Media;
using System.Windows.Shapes;
using System.Windows.Threading;

namespace InkOverlay;

/// <summary>
/// OneNote's "draw and hold" ink-to-shape: draw a shape, keep the pen still on the screen, and a clean
/// shape takes the stroke's place. The pen stays on it: moving turns and sizes the shape, until lifting
/// puts it down as it is then. A line or arrow pivots on its far end, so its tip follows the pen; a closed
/// shape on its middle.
/// </summary>
public sealed partial class OverlayWindow
{
    static readonly TimeSpan HoldTime = TimeSpan.FromMilliseconds(600);
    const double HoldSlop = 4; // on-screen px the pen may wobble and still count as held
    // While the shape is being worked out, the pen has to move away on purpose to call it off.
    const double RecognizingSlop = 24;
    // A pen tip wanders as it lifts: a shape only starts to turn and size once the pen has really moved.
    const double AdjustSlop = 8;
    const double SnapDegrees = 4; // level and plumb (or, for a closed shape, a quarter turn) catch the shape
    const double MinArm = 12;     // on-screen px from pivot to pen: closer than this, the pen would spin the shape
    // A stroke drawn within this long after the previous one can pair with it (an arrow's shaft and head).
    static readonly TimeSpan PairWindow = TimeSpan.FromSeconds(3);

    readonly List<Point> livePoints = new();
    DispatcherTimer holdTimer = null!;
    Point holdAnchor;
    bool tracking;
    bool shapesEnabled = true;
    Task<Shape?>? pendingShape;
    Stroke? pendingPrevious;
    Path? shapePreview;
    IReadOnlyList<Point>? shapeOutline;  // as it first came up
    IReadOnlyList<Point>? shapeNow;      // as the pen has turned and sized it
    Point shapeGrip, shapePivot;
    bool shapeClosed, shapeAdjusted;
    Color? previousColor;                // the first stroke of a two-stroke arrow, hidden while its shape is up

    void InitInkToShape()
    {
        holdTimer = new DispatcherTimer { Interval = HoldTime };
        holdTimer.Tick += (_, _) => OnHold();

        // After a shape, the rough stroke's wet ink has gone by the time the pen comes down again.
        ink.PreviewMouseDown += (_, _) => { if (shapePreview == null) ink.WetInkHidden = false; };
        ink.PreviewStylusDown += (_, e) =>
        {
            ClearHold();
            ink.WetInkHidden = false;
            // Not the eraser end: the canvas stays in ink mode while the pen is flipped, and an erasing
            // back-and-forth held still was read as a shape (a triangle preview was left on the page).
            if (e.Handled || e.StylusDevice.Inverted || !ShapesActive()) return;
            tracking = true;
            AddPoints(e.GetStylusPoints(ink));
        };
        ink.PreviewStylusMove += (_, e) =>
        {
            if (tracking && !e.InAir) AddPoints(e.GetStylusPoints(ink));
        };
        ink.StrokeCollected += OnStrokeCollected;
        // A pen-down that didn't end in a stroke (erasing, a scratch-out, a dot too small to keep) leaves no
        // shape preview behind: once the lift is handled, anything still tracked is dropped.
        ink.PreviewStylusUp += (_, _) => Dispatcher.BeginInvoke(DispatcherPriority.Background, () =>
        {
            if (!tracking) return;
            tracking = false;
            ClearHold();
        });
    }

    bool ShapesActive() =>
        shapesEnabled && ink.EditingMode is InkCanvasEditingMode.Ink or InkCanvasEditingMode.InkAndGesture;

    void AddPoints(StylusPointCollection points)
    {
        foreach (var sp in points)
        {
            var p = new Point(sp.X, sp.Y);
            livePoints.Add(p);
            if (shapePreview != null)
            {
                AdjustShape(p);
                continue;
            }
            double slop = (pendingShape != null ? RecognizingSlop : HoldSlop) / Zoom;
            if (livePoints.Count == 1 || (p - holdAnchor).Length > slop)
            {
                // Moving: (re)start the hold clock, and drop any shape from an earlier pause.
                holdAnchor = p;
                holdTimer.Stop();
                holdTimer.Start();
                if (pendingShape != null) CancelShape();
            }
        }
    }

    async void OnHold()
    {
        holdTimer.Stop();
        if (!tracking || livePoints.Count < 6) return;
        // The stroke before this one, if it was just drawn: it and this one may make an arrow together.
        pendingPrevious = lastStroke != null && ink.Strokes.Contains(lastStroke) && (DateTime.Now - lastStrokeAt) < PairWindow
            ? lastStroke : null;
        var previous = pendingPrevious?.StylusPoints.Select(p => new Point(p.X, p.Y)).ToList();
        var task = ShapeRecognizer.RecognizeAsync(livePoints.ToList(), previous);
        pendingShape = task;
        var shape = await task;
        if (pendingShape == task && shape != null && tracking) ShowPreview(shape);
    }

    async void OnStrokeCollected(object? sender, InkCanvasStrokeCollectedEventArgs e)
    {
        tracking = false;
        holdTimer.Stop();
        var task = pendingShape;
        if (task == null)
        {
            ClearHold();
            return;
        }
        var shape = await task;
        if (task != pendingShape) return;
        var outline = shapeNow ?? shape?.Outline;
        bool adjusted = shapeAdjusted;
        ClearHold();
        var previous = pendingPrevious;
        pendingPrevious = null;
        if (shape == null || !ink.Strokes.Contains(e.Stroke)) return;
        if (shape.UsesPrevious && (previous == null || !ink.Strokes.Contains(previous))) return;

        var da = e.Stroke.DrawingAttributes.Clone();
        da.FitToCurve = shape.Smooth;
        da.IgnorePressure = true;
        var points = new StylusPointCollection(outline!.Select(p => new StylusPoint(p.X, p.Y, 0.5f)));
        var clean = new Stroke(points, da);
        // Keep the hand-drawn stroke's line anchor so the shape stays with the same text (for a two-stroke
        // arrow, the first stroke's: the new one was anchored with it anyway, being drawn right after). A shape
        // the pen moved gets its own, for where it landed.
        var anchored = shape.UsesPrevious ? previous! : e.Stroke;
        if (!adjusted && TryGetAnchor(anchored, out var line, out var top))
            SetAnchor(clean, line, top, markModel: anchored.ContainsPropertyData(AnchorModelId));
        // Replaced together, so a single undo brings back the hand-drawn strokes (history snapshots are debounced).
        if (shape.UsesPrevious) ink.Strokes.Remove(previous!);
        ink.Strokes.Replace(e.Stroke, new StrokeCollection { clean });
        Protocol.Log($"ink to shape: {shape.Kind}{(shape.UsesPrevious ? " (two strokes)" : "")}");
    }

    void ShowPreview(Shape shape)
    {
        RemovePreview();
        var da = ink.DefaultDrawingAttributes;
        shapeOutline = shapeNow = shape.Outline;
        shapeGrip = livePoints.Count > 0 ? livePoints[^1] : shape.Outline[^1];
        shapeClosed = (shape.Outline[0] - shape.Outline[^1]).Length < 0.01;
        shapePivot = PivotFor(shape.Outline, shapeGrip, shapeClosed, MinArm / Zoom);
        shapeAdjusted = false;
        shapePreview = new Path
        {
            Data = OutlineGeometry(shape.Outline),
            Stroke = new SolidColorBrush(da.Color),
            StrokeThickness = Math.Max(1, da.Width),
            StrokeLineJoin = PenLineJoin.Round,
            StrokeStartLineCap = PenLineCap.Round,
            StrokeEndLineCap = PenLineCap.Round,
            Opacity = da.IsHighlighter ? 0.35 : 1,
            IsHitTestVisible = false,
        };
        InkCanvas.SetLeft(shapePreview, 0);
        InkCanvas.SetTop(shapePreview, 0);
        ink.Children.Add(shapePreview);

        // The shape is what's on the page now: the rough strokes go while the pen moves it.
        ink.WetInkHidden = true;
        if (shape.UsesPrevious && pendingPrevious != null)
        {
            // (Any undo step still waiting is taken first: one taken now would keep the stroke invisible.)
            if (snapshotDebounce.IsEnabled) { snapshotDebounce.Stop(); Snapshot(); }
            previousColor = pendingPrevious.DrawingAttributes.Color;
            pendingPrevious.DrawingAttributes.Color = Colors.Transparent;
        }
    }

    /// <summary>The pen, still down, moved to `pen`: turn and size the shape as the pen's arm from the pivot did.</summary>
    void AdjustShape(Point pen)
    {
        if (shapeOutline == null || shapePreview == null) return;
        if (!shapeAdjusted && (pen - shapeGrip).Length <= AdjustSlop / Zoom) return;
        shapeAdjusted = true;
        shapeNow = Adjusted(shapeOutline, shapeGrip, pen, shapePivot, shapeClosed);
        shapePreview.Data = OutlineGeometry(shapeNow);
    }

    /// <summary>Where a shape turns from: a closed shape's middle, an open one's point furthest from the pen.</summary>
    internal static Point PivotFor(IReadOnlyList<Point> outline, Point grip, bool closed, double minArm)
    {
        var farthest = outline.OrderByDescending(p => (p - grip).Length).First();
        if (!closed) return farthest;
        var box = new Rect(outline[0], outline[0]);
        foreach (var p in outline) box.Union(p);
        var middle = new Point(box.Left + box.Width / 2, box.Top + box.Height / 2);
        return (grip - middle).Length < minArm ? farthest : middle;
    }

    /// <summary>The outline turned and scaled about `pivot`, as far as `grip` moved to `pen`.</summary>
    internal static List<Point> Adjusted(IReadOnlyList<Point> outline, Point grip, Point pen, Point pivot, bool closed)
    {
        Vector from = grip - pivot, to = pen - pivot;
        if (from.Length < 0.01) return outline.ToList();
        static double Degrees(Vector v) => Math.Atan2(v.Y, v.X) * 180 / Math.PI;
        static double Snap(double degrees)
        {
            double nearest = Math.Round(degrees / 90) * 90;
            return Math.Abs(degrees - nearest) < SnapDegrees ? nearest : degrees;
        }
        // A closed shape catches on its own quarter turns; a line or arrow on level and plumb.
        double turn = closed ? Snap(Degrees(to) - Degrees(from)) : Snap(Degrees(to)) - Degrees(from);
        double size = Math.Max(0.1, to.Length / from.Length);
        var m = Matrix.Identity;
        m.ScaleAt(size, size, pivot.X, pivot.Y);
        m.RotateAt(turn, pivot.X, pivot.Y);
        return outline.Select(p => m.Transform(p)).ToList();
    }

    static PathGeometry OutlineGeometry(IReadOnlyList<Point> outline)
    {
        var figure = new PathFigure { StartPoint = outline[0], IsFilled = false };
        figure.Segments.Add(new PolyLineSegment(outline.Skip(1), true));
        return new PathGeometry(new[] { figure });
    }

    void RemovePreview()
    {
        if (shapePreview == null) return;
        ink.Children.Remove(shapePreview);
        shapePreview = null;
        shapeOutline = shapeNow = null;
        shapeAdjusted = false;
        if (previousColor is { } color && pendingPrevious != null) pendingPrevious.DrawingAttributes.Color = color;
        previousColor = null;
    }

    void CancelShape()
    {
        pendingShape = null;
        RemovePreview();
    }

    void ClearHold()
    {
        holdTimer.Stop();
        livePoints.Clear();
        CancelShape();
    }
}

/// <summary>An InkCanvas that can hide the ink still coming out of the pen: until the pen lifts it isn't a stroke, so there's nothing else to hide.</summary>
sealed class PenCanvas : InkCanvas
{
    internal bool WetInkHidden
    {
        get => DynamicRenderer?.RootVisual is ContainerVisual { Opacity: 0 };
        set { if (DynamicRenderer?.RootVisual is ContainerVisual wet) wet.Opacity = value ? 0 : 1; }
    }
}

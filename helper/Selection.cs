using System;
using System.Linq;
using System.Windows;
using System.Windows.Controls;
using System.Windows.Ink;
using System.Windows.Input;
using System.Windows.Media;
using System.Windows.Media.Imaging;
using System.Windows.Shapes;

namespace InkOverlay;

/// <summary>
/// Working with selected ink, like OneNote: the pen's side button lassoes from any tool, a handle turns the
/// selection, and the keyboard and toolbar act on it (delete, cut, duplicate, nudge, flip, copy as a
/// picture). Plus the hover dot: where the pen will land, in its colour and size.
/// </summary>
public sealed partial class OverlayWindow
{
    /// <summary>Lassoing with the side button held: the tool to go back to once the selection is let go.</summary>
    bool sideLasso;
    InkCanvasEditingMode modeBeforeLasso;

    readonly Ellipse rotateKnob = new()
    {
        Width = 16, Height = 16, Fill = Brushes.White, Stroke = new SolidColorBrush(Color.FromRgb(0x1F, 0x5F, 0xD6)), StrokeThickness = 2,
        Visibility = Visibility.Collapsed, Cursor = Cursors.Hand,
    };
    readonly Line rotateStem = new() { Stroke = new SolidColorBrush(Color.FromRgb(0x1F, 0x5F, 0xD6)), StrokeThickness = 1.5, IsHitTestVisible = false, Visibility = Visibility.Collapsed };
    bool rotating;
    Point rotateCenter;
    double rotateStart, rotateApplied;

    readonly Ellipse hoverDot = new() { IsHitTestVisible = false, Visibility = Visibility.Collapsed, Opacity = 0.65 };

    void InitSelection()
    {
        // Record the pen's angles too, where it reports them: Windows' pencil shades with them (WindowsInk.Tilt).
        try
        {
            // Pens report tilt as X/Y angles (the Surface pen) or as azimuth and altitude.
            var pens = Tablet.TabletDevices.Cast<TabletDevice>().Where(t => t.Type == TabletDeviceType.Stylus).ToList();
            bool Reports(params StylusPointProperty[] props) => pens.Any(t => props.All(a => t.SupportedStylusPointProperties.Any(p => p.Id == a.Id)));
            var angles = Reports(StylusPointProperties.XTiltOrientation, StylusPointProperties.YTiltOrientation)
                ? new[] { StylusPointProperties.XTiltOrientation, StylusPointProperties.YTiltOrientation }
                : Reports(StylusPointProperties.AzimuthOrientation, StylusPointProperties.AltitudeOrientation)
                    ? new[] { StylusPointProperties.AzimuthOrientation, StylusPointProperties.AltitudeOrientation }
                    : null;
            if (angles != null)
                ink.DefaultStylusPointDescription = new StylusPointDescription(new[]
                {
                    new StylusPointPropertyInfo(StylusPointProperties.X), new StylusPointPropertyInfo(StylusPointProperties.Y),
                    new StylusPointPropertyInfo(StylusPointProperties.NormalPressure),
                }.Concat(angles.Select(a => new StylusPointPropertyInfo(a))));
            Protocol.Log($"pen angles {(angles != null ? "recorded (" + string.Join(", ", angles.Select(a => a == StylusPointProperties.XTiltOrientation ? "x tilt" : a == StylusPointProperties.YTiltOrientation ? "y tilt" : a == StylusPointProperties.AzimuthOrientation ? "azimuth" : "altitude")) + ")" : "not reported by this pen")}");
        }
        catch (Exception e) { Protocol.Log("pen angles: " + e.Message); }

        // Before the other pen-down handlers (shapes, page tools), so the side button wins over the tool.
        ink.PreviewStylusDown += (_, e) =>
        {
            if (e.StylusDevice.TabletDevice?.Type == TabletDeviceType.Touch || e.StylusDevice.Inverted) return;
            bool side = SideButton(e.StylusDevice);
            if (side && ink.EditingMode != InkCanvasEditingMode.Select)
            {
                modeBeforeLasso = ink.EditingMode;
                sideLasso = true;
                ink.Select(new StrokeCollection());
                ink.EditingMode = InkCanvasEditingMode.Select;
            }
            else if (sideLasso && !side)
            {
                // Without the button: on the selection it moves or resizes it; anywhere else the pen draws again.
                if (ink.GetSelectedStrokes().Count > 0 && ink.HitTestSelection(e.GetPosition(ink)) != InkCanvasSelectionHitResult.None) return;
                EndSideLasso();
            }
        };

        root.Children.Add(rotateStem);
        root.Children.Add(rotateKnob);
        root.Children.Add(hoverDot);
        ink.SelectionChanged += (_, _) => PlaceRotateKnob();
        ink.SelectionMoved += (_, _) => PlaceRotateKnob();
        ink.SelectionResized += (_, _) => PlaceRotateKnob();
        ink.EditingModeChanged += (_, _) => PlaceRotateKnob();
        rotateKnob.StylusDown += (_, e) => { StartRotate(e.GetPosition(ink)); rotateKnob.CaptureStylus(); e.Handled = true; };
        rotateKnob.StylusMove += (_, e) => { if (rotating) { RotateTo(e.GetPosition(ink)); e.Handled = true; } };
        rotateKnob.StylusUp += (_, e) => { if (rotating) { EndRotate(); rotateKnob.ReleaseStylusCapture(); e.Handled = true; } };
        rotateKnob.MouseLeftButtonDown += (_, e) => { if (e.StylusDevice != null) return; StartRotate(e.GetPosition(ink)); rotateKnob.CaptureMouse(); e.Handled = true; };
        rotateKnob.MouseMove += (_, e) => { if (rotating && e.StylusDevice == null) RotateTo(e.GetPosition(ink)); };
        rotateKnob.MouseLeftButtonUp += (_, e) => { if (rotating && e.StylusDevice == null) { EndRotate(); rotateKnob.ReleaseMouseCapture(); } };

        PreviewStylusInAirMove += (_, e) => ShowHoverDot(e);
        PreviewStylusDown += (_, _) => hoverDot.Visibility = Visibility.Collapsed;
        StylusLeave += (_, _) => hoverDot.Visibility = Visibility.Collapsed;
        StylusOutOfRange += (_, _) => hoverDot.Visibility = Visibility.Collapsed;
    }

    static bool SideButton(StylusDevice device) =>
        device.StylusButtons.Any(b => b.Guid == StylusPointProperties.BarrelButton.Id && b.StylusButtonState == StylusButtonState.Down);

    /// <summary>Back to the tool the side button interrupted (the selection is let go).</summary>
    void EndSideLasso()
    {
        if (!sideLasso) return;
        sideLasso = false;
        ink.Select(new StrokeCollection());
        ink.EditingMode = modeBeforeLasso;
    }

    // ---------- turning the selection ----------

    /// <summary>The handle sits above the selection's top edge, in the middle, while there's a selection.</summary>
    void PlaceRotateKnob()
    {
        bool show = ink.EditingMode == InkCanvasEditingMode.Select && ink.GetSelectedStrokes().Count > 0;
        if (!show && !rotating)
        {
            rotateKnob.Visibility = rotateStem.Visibility = Visibility.Collapsed;
            return;
        }
        var b = ink.GetSelectionBounds();
        if (b.IsEmpty) return;
        var top = ink.TranslatePoint(new Point(b.Left + b.Width / 2, b.Top), root);
        var knob = top - new Vector(0, 26);
        System.Windows.Controls.Canvas.SetLeft(rotateKnob, knob.X - rotateKnob.Width / 2);
        System.Windows.Controls.Canvas.SetTop(rotateKnob, knob.Y - rotateKnob.Height / 2);
        rotateStem.X1 = top.X; rotateStem.Y1 = top.Y; rotateStem.X2 = knob.X; rotateStem.Y2 = knob.Y + rotateKnob.Height / 2;
        rotateKnob.Visibility = rotateStem.Visibility = Visibility.Visible;
    }

    void StartRotate(Point at)
    {
        var b = ink.GetSelectedStrokes().GetBounds();
        if (b.IsEmpty) return;
        rotating = true;
        rotateCenter = new Point(b.Left + b.Width / 2, b.Top + b.Height / 2);
        rotateStart = Angle(at);
        rotateApplied = 0;
    }

    double Angle(Point p) => Math.Atan2(p.Y - rotateCenter.Y, p.X - rotateCenter.X) * 180 / Math.PI;

    /// <summary>Turn to follow the pen, settling on 15° steps when close to one (like the ruler).</summary>
    void RotateTo(Point at)
    {
        double total = Angle(at) - rotateStart;
        total = (total + 540) % 360 - 180;
        double step = Math.Round(total / 15) * 15;
        if (Math.Abs(total - step) < 3) total = step;
        double delta = total - rotateApplied;
        if (Math.Abs(delta) < 0.05) return;
        var m = Matrix.Identity;
        m.RotateAt(delta, rotateCenter.X, rotateCenter.Y);
        var selected = ink.GetSelectedStrokes();
        selected.Transform(m, false);
        rotateApplied = total;
        ink.Select(selected);
        PlaceRotateKnob();
    }

    void EndRotate()
    {
        rotating = false;
        if (Math.Abs(rotateApplied) > 0.05)
        {
            AnchorSelection();
            Changed();
        }
        PlaceRotateKnob();
    }

    // ---------- keyboard and toolbar actions on the selection ----------

    void HandleSelectionCommand(Command cmd)
    {
        var selected = ink.GetSelectedStrokes();
        switch (cmd.Type)
        {
            case "deselect":
                ink.Select(new StrokeCollection());
                EndSideLasso();
                break;
            case "cut":
                if (selected.Count == 0) return;
                CopySelection();
                ink.Strokes.Remove(selected);
                break;
            case "duplicate":
            {
                if (selected.Count == 0) return;
                var copy = new StrokeCollection(selected.Select(s => s.Clone()));
                foreach (var s in copy)
                    foreach (var id in new[] { AnchorLineId, AnchorTopId, AboveHashId, AboveOffsetId, BelowHashId, BelowOffsetId, StrokeTimeId })
                        if (s.ContainsPropertyData(id)) s.RemovePropertyData(id);
                copy.Transform(new Matrix(1, 0, 0, 1, 16 / Zoom, 16 / Zoom), false);
                ink.Strokes.Add(copy);
                ink.Select(copy);
                break;
            }
            case "nudge":
                if (selected.Count == 0) return;
                selected.Transform(new Matrix(1, 0, 0, 1, cmd.X / Zoom, cmd.Y / Zoom), false);
                ink.Select(selected);
                AnchorSelection();
                Changed();
                break;
            case "flip":
            {
                if (selected.Count == 0) return;
                var b = selected.GetBounds();
                var m = Matrix.Identity;
                if (cmd.Purpose == "vertical") m.ScaleAt(1, -1, b.Left + b.Width / 2, b.Top + b.Height / 2);
                else m.ScaleAt(-1, 1, b.Left + b.Width / 2, b.Top + b.Height / 2);
                selected.Transform(m, false);
                ink.Select(selected);
                AnchorSelection();
                Changed();
                break;
            }
            case "select-all":
                if (ink.EditingMode != InkCanvasEditingMode.Select) ink.EditingMode = InkCanvasEditingMode.Select;
                ink.Select(ink.Strokes);
                break;
            case "clear-ink":
                // One undo step brings it all back.
                ink.Select(new StrokeCollection());
                if (ink.Strokes.Count > 0) ink.Strokes.Clear();
                break;
            case "copy-image":
                CopyImage(selected.Count > 0 ? selected : ink.Strokes);
                break;
        }
    }

    /// <summary>Ink as a picture only (pasting it into OneNote or Word gives a picture, not ink).</summary>
    void CopyImage(StrokeCollection strokes)
    {
        if (strokes.Count == 0) { Notice("No ink to copy"); return; }
        var copy = strokes.Clone();
        ToTrueColors(copy);
        var data = new DataObject();
        var png = new System.IO.MemoryStream();
        var encoder = new PngBitmapEncoder();
        encoder.Frames.Add(BitmapFrame.Create(Render(copy, null)));
        encoder.Save(png);
        png.Position = 0;
        data.SetData("PNG", png);
        data.SetImage(Render(copy, Brushes.White));
        try
        {
            Clipboard.SetDataObject(data, true);
            Notice("Copied as a picture");
        }
        catch (Exception e)
        {
            Protocol.Log("copy as image failed: " + e.Message);
            Notice("Couldn't copy: the clipboard is busy");
        }
    }

    // ---------- hover dot ----------

    /// <summary>Where the pen will land: a dot of the pen's colour and size, or the eraser's circle.</summary>
    void ShowHoverDot(StylusEventArgs e)
    {
        if (e.StylusDevice.TabletDevice?.Type == TabletDeviceType.Touch) return;
        var mode = e.StylusDevice.Inverted ? ink.EditingModeInverted : ink.EditingMode;
        double k = scale.ScaleX;
        double w, h;
        var da = ink.DefaultDrawingAttributes;
        switch (mode)
        {
            case InkCanvasEditingMode.Ink:
            case InkCanvasEditingMode.InkAndGesture:
                w = Math.Max(3, da.Width * k); h = Math.Max(3, da.Height * k);
                hoverDot.Fill = new SolidColorBrush(da.Color);
                hoverDot.Stroke = null;
                hoverDot.Opacity = da.IsHighlighter ? 0.4 : 0.65;
                break;
            case InkCanvasEditingMode.EraseByPoint:
                w = Math.Max(6, ink.EraserShape.Width * k); h = Math.Max(6, ink.EraserShape.Height * k);
                hoverDot.Fill = null;
                hoverDot.Stroke = Brushes.Gray;
                hoverDot.StrokeThickness = 1.2;
                hoverDot.Opacity = 0.9;
                break;
            case InkCanvasEditingMode.EraseByStroke:
                w = h = 10;
                hoverDot.Fill = null;
                hoverDot.Stroke = Brushes.Gray;
                hoverDot.StrokeThickness = 1.2;
                hoverDot.Opacity = 0.9;
                break;
            default:
                hoverDot.Visibility = Visibility.Collapsed;
                return;
        }
        var p = e.GetPosition(root);
        hoverDot.Width = w;
        hoverDot.Height = h;
        System.Windows.Controls.Canvas.SetLeft(hoverDot, p.X - w / 2);
        System.Windows.Controls.Canvas.SetTop(hoverDot, p.Y - h / 2);
        hoverDot.Visibility = Visibility.Visible;
    }
}

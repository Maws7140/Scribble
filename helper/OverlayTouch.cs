using System;
using System.Windows.Input;

namespace InkOverlay;

/// <summary>
/// While the pen is near, this window is in front of Obsidian and a finger lands here, where it's kept from inking.
/// On a canvas that finger should still drag and pinch, so it's passed along for the plugin to act on.
/// </summary>
public sealed partial class OverlayWindow
{
    void InitOverlayTouch()
    {
        PreviewStylusDown += (_, e) => PassTouch("down", e);
        PreviewStylusMove += (_, e) => PassTouch("move", e);
        PreviewStylusUp += (_, e) => PassTouch("up", e);
    }

    void PassTouch(string phase, StylusEventArgs e)
    {
        if (touchInk || e.StylusDevice.TabletDevice?.Type != TabletDeviceType.Touch || layout is not { } l) return;
        // In CSS px from the top-left of the ink area.
        double k = l.Dpr / System.Windows.Media.VisualTreeHelper.GetDpi(this).DpiScaleX;
        var at = e.GetPosition(root);
        Protocol.Send(new { type = "overlay-touch", phase, id = e.StylusDevice.Id, x = Math.Round(at.X / k, 1), y = Math.Round(at.Y / k, 1) });
    }
}

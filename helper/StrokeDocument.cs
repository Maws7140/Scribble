using System;
using System.Runtime.CompilerServices;
using System.Windows.Ink;

namespace InkOverlay;

/// <summary>
/// The document's geometry is independent of its projected InkCanvas geometry. Layout changes may move
/// the canvas strokes for input/hit testing, but saves and undo snapshots use these canonical strokes.
/// Only actual point edits and drawing-attribute edits advance the corresponding document state.
/// </summary>
internal sealed class StrokeDocument
{
    sealed class Entry
    {
        public Stroke Saved;
        public bool GeometryEdited, AttributesEdited;
        public Entry(Stroke stroke) { Saved = stroke.Clone(); }
    }
    readonly ConditionalWeakTable<Stroke, Entry> entries = new();
    int projecting;

    sealed class Scope : IDisposable
    {
        readonly StrokeDocument owner;
        public Scope(StrokeDocument owner) { this.owner = owner; owner.projecting++; }
        public void Dispose() { owner.projecting--; }
    }
    public IDisposable Project() => new Scope(this);

    Entry Track(Stroke stroke)
    {
        if (entries.TryGetValue(stroke, out var entry)) return entry;
        entry = new Entry(stroke);
        entries.Add(stroke, entry);
        Watch(stroke, entry);
        return entry;
    }

    void Watch(Stroke stroke, Entry entry)
    {
        void PropertyEdited(object? sender, PropertyDataChangedEventArgs e) { if (projecting == 0) entry.AttributesEdited = true; }
        var attributes = stroke.DrawingAttributes;
        attributes.PropertyDataChanged += PropertyEdited;
        stroke.StylusPointsChanged += (_, _) => { if (projecting == 0) entry.GeometryEdited = true; };
        stroke.StylusPointsReplaced += (_, _) => { if (projecting == 0) entry.GeometryEdited = true; };
        stroke.DrawingAttributesChanged += (_, _) => { if (projecting == 0) entry.AttributesEdited = true; };
        stroke.DrawingAttributesReplaced += (_, _) =>
        {
            attributes.PropertyDataChanged -= PropertyEdited;
            attributes = stroke.DrawingAttributes;
            attributes.PropertyDataChanged += PropertyEdited;
            if (projecting == 0) entry.AttributesEdited = true;
        };
    }

    public void TrackAll(StrokeCollection strokes) { foreach (var stroke in strokes) Track(stroke); }
    public void MarkGeometry(Stroke stroke) { Track(stroke).GeometryEdited = true; }
    public void CommitEdits(StrokeCollection strokes) { foreach (var stroke in strokes) Commit(stroke, Track(stroke)); }

    public void Transfer(Stroke before, Stroke after)
    {
        var entry = Track(before);
        entries.Add(after, entry);
        Watch(after, entry);
    }

    static void Commit(Stroke stroke, Entry entry)
    {
        if (entry.GeometryEdited) entry.Saved = stroke.Clone();
        else if (entry.AttributesEdited) entry.Saved.DrawingAttributes = stroke.DrawingAttributes.Clone();
        entry.GeometryEdited = entry.AttributesEdited = false;
    }

    /// <summary>A deliberate source edit changes logical anchors, never their canonical point geometry.</summary>
    public void EditAnchors(Stroke stroke, Action<Stroke> edit)
    {
        var entry = Track(stroke);
        Commit(stroke, entry);
        edit(entry.Saved);
        using (Project()) edit(stroke);
    }

    public StrokeCollection Snapshot(StrokeCollection strokes)
    {
        var result = new StrokeCollection();
        foreach (var stroke in strokes)
        {
            var entry = Track(stroke);
            Commit(stroke, entry);
            result.Add(entry.Saved.Clone());
        }
        return result;
    }
}

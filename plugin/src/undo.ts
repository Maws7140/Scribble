import { redoDepth, undoDepth } from "@codemirror/commands";
import type { EditorView, ViewUpdate } from "@codemirror/view";

type Step = "ink" | "text";

/**
 * One undo and redo for a note's ink and its text, in the order things were done (like OneNote): with the
 * ink tools in Editing Toolbar's bar, its undo button takes back the last change, a stroke or some typing.
 * The note's editor keeps the text history and the ink helper the ink history; this only keeps which came
 * when, and moves along with either when they're undone some other way (Ctrl+Z, the Undo ink command).
 */
export class MergedHistory {
  private undos: Step[] = [];
  private redos: Step[] = [];
  /** Where the helper is in its ink history, and whether it can go back or on from there. */
  private ink = 0;
  private canUndoInk = false;
  private canRedoInk = false;
  /** The move in the ink history our own undo or redo is waiting on. */
  private expectInk = 0;
  private editor: EditorView | null = null;
  private file = "";
  private textUndo = 0;
  private textRedo = 0;

  constructor(private sendInk: (command: "undo" | "redo") => void) {}

  /** The note on screen and its editor; another note starts afresh (a pane keeps its editor between notes). */
  watch(editor: EditorView | null, file: string) {
    if (editor === this.editor && file === this.file) return;
    this.editor = editor;
    this.file = file;
    this.undos = [];
    this.redos = [];
    this.expectInk = 0;
    this.textUndo = editor ? undoDepth(editor.state) : 0;
    this.textRedo = editor ? redoDepth(editor.state) : 0;
  }

  /** The helper's ink history moved: a new stroke or edit (`added`), an undo or redo, or a new page. */
  onInk(steps: number, added: boolean, reset: boolean, canUndo: boolean, canRedo: boolean) {
    const delta = steps - this.ink;
    this.ink = steps;
    this.canUndoInk = canUndo;
    this.canRedoInk = canRedo;
    if (reset) {
      this.undos = this.undos.filter((s) => s !== "ink");
      this.redos = this.redos.filter((s) => s !== "ink");
      this.expectInk = 0;
    } else if (added) {
      this.undos.push("ink");
      this.redos = [];
      this.expectInk = 0;
    } else if (this.expectInk !== 0 && delta === this.expectInk) {
      this.expectInk = 0;
    } else {
      this.expectInk = 0;
      if (delta < 0) move(this.undos, this.redos, "ink", -delta);
      else if (delta > 0) move(this.redos, this.undos, "ink", delta);
    }
  }

  /** The note's text changed: a new undo step in its editor, or one undone or redone. */
  onText(u: ViewUpdate) {
    if (u.view !== this.editor || !u.docChanged) return;
    const undo = undoDepth(u.state), redo = redoDepth(u.state);
    const du = undo - this.textUndo;
    this.textUndo = undo;
    this.textRedo = redo;
    if (u.transactions.some((t) => t.isUserEvent("undo"))) move(this.undos, this.redos, "text", -du);
    else if (u.transactions.some((t) => t.isUserEvent("redo"))) move(this.redos, this.undos, "text", du);
    else if (du > 0) {
      for (let i = 0; i < du; i++) this.undos.push("text");
      this.redos = [];
    }
  }

  /**
   * Undo (or redo) the last step. True: it was ink, and that's done. False: it's text, or there's nothing
   * here, so the editor's own undo should run (its change comes back through onText).
   */
  step(direction: "undo" | "redo"): boolean {
    const from = direction === "undo" ? this.undos : this.redos;
    const to = direction === "undo" ? this.redos : this.undos;
    // Steps that can't be taken any more (the history was cut short elsewhere) are dropped.
    while (from.length) {
      const last = from[from.length - 1];
      const possible = last === "ink"
        ? (direction === "undo" ? this.canUndoInk : this.canRedoInk)
        : (direction === "undo" ? this.textUndo : this.textRedo) > 0;
      if (possible) break;
      from.pop();
    }
    if (from[from.length - 1] !== "ink") return false;
    from.pop();
    to.push("ink");
    this.expectInk = direction === "undo" ? -1 : 1;
    this.sendInk(direction);
    return true;
  }
}

/** Move the last `count` steps of a kind from one list to the other (most recent first). */
function move(from: Step[], to: Step[], kind: Step, count: number) {
  for (let n = 0; n < count; n++) {
    const i = from.lastIndexOf(kind);
    if (i < 0) return;
    from.splice(i, 1);
    to.push(kind);
  }
}

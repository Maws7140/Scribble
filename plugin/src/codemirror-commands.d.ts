// Obsidian provides @codemirror/commands at runtime (it's external in the build); only what's used here.
declare module "@codemirror/commands" {
  import type { EditorState } from "@codemirror/state";
  export function undoDepth(state: EditorState): number;
  export function redoDepth(state: EditorState): number;
}

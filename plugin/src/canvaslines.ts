import { FileView } from "obsidian";
import { PAGE_LINES } from "./settings";
import { CANVAS_ORIGIN } from "./targets";

/** Lines closer together than this on screen would only be a grey blur. */
const FINEST_PX = 6;

/**
 * Rule or grid lines on a canvas, under its cards and ink. They go in the layer Canvas draws its cards in, so
 * they pan and zoom with everything else; they're counted from the canvas's 0,0 and stay one pixel thick at any
 * zoom. `id` is one of PAGE_LINES, or anything else for none (there's no text for "text" to match here).
 */
export function ruleCanvas(view: FileView, id: string | undefined, zoom: number) {
  const layer = view.contentEl.querySelector<HTMLElement>(".canvas-wrapper .canvas");
  if (!layer) return;
  const mode = PAGE_LINES.find((l) => l.id === id && l.pitch > 0);
  let lines = layer.querySelector<HTMLElement>(":scope > .oni-canvas-lines");
  // Obsidian's dots would only be noise between the lines.
  layer.parentElement?.toggleClass("oni-canvas-ruled", !!mode);
  if (!mode) {
    lines?.remove();
    return;
  }
  lines ??= layer.createDiv("oni-canvas-lines");
  lines.toggleClass("is-grid", !!mode.grid);
  lines.toggleClass("is-too-fine", mode.pitch * zoom < FINEST_PX);
  const set = (name: string, value: string) => {
    if (lines.style.getPropertyValue(name) !== value) lines.style.setProperty(name, value);
  };
  set("--oni-rule-pitch", `${mode.pitch}px`);
  set("--oni-rule-phase", `${CANVAS_ORIGIN % mode.pitch}px`);
  set("--oni-rule-width", `${(1 / zoom).toFixed(3)}px`);
}

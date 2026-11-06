import { App, MarkdownPostProcessorContext, MarkdownPreviewRenderer, Notice, TFile } from "obsidian";
import { lineHashes, printBlockLineTops } from "./lines";

export interface PrintStroke {
  line: number; top: number;
  x: number; y: number; w: number; h: number;
  d?: string; img?: string; c: string; o: number; hl: boolean;
}
export interface PrintReference { width: number; left: number; textWidth: number; lineHeight: number; tops?: number[] }
interface PrintPart { el: HTMLElement; start: number; end: number; blank?: boolean }
interface ParsedSection { html: string; pos: { start: { line: number }; end: { line: number } } }
interface PrintContext extends MarkdownPostProcessorContext { promises?: Promise<unknown>[] }
interface PrintHost {
  app: App;
  printReference(notePath: string): PrintReference;
  printSnapshot(file: TFile, hashes: number[], reference: PrintReference): Promise<PrintStroke[]>;
}
const SVG = "http://www.w3.org/2000/svg";

/** Adds a read-only ink snapshot to Obsidian's normal PDF print render. */
export class InkPrint {
  private jobs = new WeakMap<HTMLElement, Promise<void>>();
  constructor(private host: PrintHost) {}

  process(el: HTMLElement, ctx: MarkdownPostProcessorContext): Promise<void> | void {
    if (!el.classList.contains("markdown-preview-view") || !el.parentElement?.classList.contains("print")) return;
    if (this.jobs.has(el)) return this.jobs.get(el);
    const reference = this.host.printReference(ctx.sourcePath);
    const job: Promise<void> = Promise.resolve().then(async () => {
      // Embeds and other postprocessors join this same list. Excluding ourselves avoids a cycle.
      await Promise.all(((ctx as PrintContext).promises ?? []).filter((p) => p !== job));
      const file = this.host.app.vault.getAbstractFileByPath(ctx.sourcePath);
      if (!(file instanceof TFile) || file.extension !== "md") return;
      const text = await this.host.app.vault.cachedRead(file);
      const strokes = await this.host.printSnapshot(file, lineHashes(text.split("\n")), reference);
      if (strokes.length) await this.prepare(el, text, reference, strokes);
    }).catch((error: Error) => {
      new Notice(error.message);
      throw error;
    });
    this.jobs.set(el, job);
    return job;
  }

  private async prepare(root: HTMLElement, text: string, reference: PrintReference, strokes: PrintStroke[]) {
    const doc = root.ownerDocument;
    const win = doc.defaultView!;
    await Promise.all(Array.from(root.querySelectorAll("img")).map((img) => img.decode?.().catch(() => {}) ?? Promise.resolve()));
    await doc.fonts.ready;
    // Include strokes extending below the last source line without adding anything to the note file.
    const count = text.split("\n").length;
    const needed = Math.max(count, ...strokes.map((s) => Math.ceil(s.line + (s.y + s.h - s.top) / reference.lineHeight) + 1));
    const parts = this.parts(root, text + "\n".repeat(Math.max(0, needed - count)), reference.lineHeight);
    const page = doc.createElement("div");
    page.className = "oni-print-page";
    const left = Math.min(0, ...strokes.map((s) => s.x));
    const width = Math.max(reference.width, ...strokes.map((s) => s.x + s.w)) - left;
    page.style.inlineSize = `${width}px`;
    page.style.setProperty("--oni-print-width", `${width}px`);
    const content = doc.createElement("div");
    content.style.inlineSize = `${reference.textWidth}px`;
    content.style.marginInlineStart = `${reference.left - left}px`;
    content.append(...Array.from(root.childNodes));
    page.append(content);
    root.append(page);
    root.classList.add("oni-print-note");
    if (!parts.length) {
      const blank = doc.createElement("div");
      blank.className = "oni-print-blank";
      blank.style.blockSize = `${reference.lineHeight}px`;
      content.append(blank);
      parts.push({ el: blank, start: 0, end: text.split("\n").length - 1, blank: true });
    }
    const ordered = [...strokes.filter((s) => s.hl), ...strokes.filter((s) => !s.hl)];
    const items = ordered.map((stroke) => {
      const part = parts.find((p) => stroke.line >= p.start && stroke.line <= p.end) ?? parts[parts.length - 1];
      const svg = doc.createElementNS(SVG, "svg");
      svg.classList.add("oni-print-stroke");
      svg.setAttribute("viewBox", `${stroke.x} ${stroke.y} ${stroke.w} ${stroke.h}`);
      svg.setAttribute("width", String(stroke.w));
      svg.setAttribute("height", String(stroke.h));
      svg.setAttribute("aria-hidden", "true");
      const shape = doc.createElementNS(SVG, stroke.img ? "image" : "path");
      if (stroke.img) {
        shape.setAttribute("href", `data:image/png;base64,${stroke.img}`);
        for (const [key, value] of Object.entries({ x: stroke.x, y: stroke.y, width: stroke.w, height: stroke.h })) shape.setAttribute(key, String(value));
      } else {
        shape.setAttribute("d", stroke.d ?? "");
        shape.setAttribute("fill", stroke.c);
        shape.setAttribute("fill-opacity", String(stroke.o));
      }
      svg.append(shape);
      part.el.classList.add("oni-print-anchor");
      part.el.append(svg);
      return { part, stroke, svg };
    });
    const layout = () => {
      // CSS fits text and ink together before Chromium paginates. Only line offsets need measuring;
      // changing the page's scale in a print event would leave Chromium's earlier page count behind.
      const unit = page.getBoundingClientRect().width / Math.max(1, page.offsetWidth) || 1;
      const positions = new Map<PrintPart, number[]>();
      for (const part of parts) positions.set(part, part.blank ? [0]
        : printBlockLineTops(part.el, part.start, part.end, unit, reference.lineHeight));
      for (const { part, stroke, svg } of items) {
        const tops = positions.get(part)!;
        const line = Math.max(0, Math.min(tops.length - 1, stroke.line - part.start));
        svg.style.insetInlineStart = `${stroke.x - reference.left}px`;
        svg.style.insetBlockStart = `${tops[line] + stroke.y - stroke.top}px`;
      }
    };
    layout();
    const media = win.matchMedia("print");
    media.addEventListener("change", layout);
    win.addEventListener("beforeprint", layout);
    win.addEventListener("afterprint", () => {
      media.removeEventListener("change", layout);
      win.removeEventListener("beforeprint", layout);
    }, { once: true });
  }

  private parts(root: HTMLElement, text: string, lineHeight: number): PrintPart[] {
    // The print context has no source ranges. Reuse Reading view's parser, including plugin blocks.
    const parser = MarkdownPreviewRenderer.prototype as unknown as { parseSync?: (this: unknown) => void };
    if (!parser.parseSync) throw new Error("Onesidian: this Obsidian version cannot map ink to PDF blocks.");
    let parsed: ParsedSection[] = [];
    parser.parseSync.call({ text, parseFrontmatter: true,
      parseFinish: (_text: string, result: { sections: ParsedSection[] }) => { parsed = result.sections; } });
    const blocks = Array.from(root.children) as HTMLElement[];
    if (blocks[0]?.tagName === "H1") blocks.shift(); // optional filename heading
    const result: PrintPart[] = [];
    let at = 0;
    let previous = -1;
    const lines = text.split("\n");
    const blanks = (from: number, to: number, before: HTMLElement | null) => {
      for (let i = from; i <= to; i++) {
        if (lines[i]?.trim()) continue;
        const el = root.ownerDocument.createElement("div");
        el.className = "oni-print-blank";
        el.style.blockSize = `${lineHeight}px`;
        root.insertBefore(el, before);
        result.push({ el, start: i, end: i, blank: true });
      }
    };
    for (const section of parsed) {
      // Parsed into a detached document: nothing in it runs or loads.
      const parsedBlocks = new DOMParser().parseFromString(section.html, "text/html").body;
      const count = parsedBlocks.children.length;
      if (!count) continue;
      const children = blocks.slice(at, at + count);
      if (children.length !== count) throw new Error("Onesidian: PDF blocks changed while adding ink. Export cancelled.");
      at += count;
      const start = section.pos.start.line;
      const end = section.pos.end.line;
      blanks(previous + 1, start - 1, children[0]);
      previous = end;
      if (children[0].classList.contains("mod-frontmatter")) continue;
      let el = children[0].firstElementChild as HTMLElement | null;
      if (count > 1 || !el || children[0].tagName === "HR") {
        el = root.ownerDocument.createElement("div");
        children[0].before(el);
        el.append(...children);
      }
      // The print renderer does not add the list line markers that Reading view supplies. Its parser
      // does: carry those across so ink by a list item follows that item rather than an even estimate.
      if (el.tagName === "UL" || el.tagName === "OL") {
        const sourceItems = Array.from(parsedBlocks.querySelectorAll<HTMLElement>("li[data-line]"));
        const items = Array.from(el.querySelectorAll<HTMLElement>("li"));
        if (sourceItems.length === items.length) items.forEach((item, i) => { item.dataset.line = sourceItems[i].dataset.line; });
      }
      result.push({ el, start, end });
    }
    if (at !== blocks.length) throw new Error("Onesidian: could not match every PDF block to its ink. Export cancelled.");
    blanks(previous + 1, lines.length - 1, null);
    return result;
  }
}

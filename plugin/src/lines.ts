import { MarkdownView } from "obsidian";
import type { EditorView } from "@codemirror/view";

/**
 * Where each source line of a note currently sits, in CSS px from the top of the text column (the
 * sizer), plus a fingerprint of each line's text. The helper keeps each piece of ink with the text it
 * was written by: it finds that text again by fingerprint (so edits, other plugins and sync can move
 * lines around), then places the ink at that line's position in the current mode.
 */
export interface LineLayout {
  tops: number[];
  /**
   * Live Preview only: where each line was placed before lines inside one-piece blocks were spread over
   * them (every line at its block's top). The helper re-anchors ink saved under that once (see editorTops).
   */
  blockTops?: number[];
  /** 0-based lines whose positions are measured (on/near screen) rather than estimated. */
  measuredFrom: number;
  measuredTo: number;
}

/** `hasInk`: in Reading view, keep blank-line space for this note (see reserveBlankSpace). */
export function lineTops(view: MarkdownView, sizer: HTMLElement, hasInk: boolean): LineLayout | null {
  const sizerTop = sizer.getBoundingClientRect().top;
  return view.getMode() === "preview" ? previewTops(view, sizer, sizerTop, hasInk) : editorTops(view, sizerTop);
}

/**
 * A fingerprint per line (32-bit FNV-1a of the trimmed text). Blank lines are 0, and so is the
 * frontmatter: it's not text you write next to, and plugins rewrite it (dates, added keys).
 */
export function lineHashes(lines: string[]): number[] {
  let frontmatterEnd = -1;
  if (lines[0]?.trim() === "---") {
    for (let i = 1; i < lines.length; i++) {
      const t = lines[i].trim();
      if (t === "---" || t === "...") { frontmatterEnd = i; break; }
    }
  }
  return lines.map((line, i) => {
    const t = line.trim();
    if (!t || i <= frontmatterEnd) return 0;
    let h = 0x811c9dc5;
    for (let k = 0; k < t.length; k++) {
      h ^= t.charCodeAt(k);
      h = Math.imul(h, 0x01000193);
    }
    return h | 0 || 1; // never 0, which means "no text"
  });
}

export function editorOf(view: MarkdownView): EditorView | undefined {
  return (view.editor as unknown as { cm?: EditorView }).cm;
}

/**
 * Live Preview / Source: CodeMirror knows every line's block, rendered or not. A block it draws as one piece
 * (columns, maths, a table, a callout, an embed, other plugins' blocks) covers several source lines, all
 * with the block's top; those lines are spread evenly down the block instead, as in Reading view. Ink
 * written by the block then belongs to a line near it and moves in proportion with the block in the other
 * view. With every line at the top, ink in a tall block (a column of handwriting beside two columns of
 * notes) was all tied to its last line, which Reading view puts below the block, and the ink went with it.
 */
function editorTops(view: MarkdownView, sizerTop: number): LineLayout | null {
  const cm = editorOf(view);
  if (!cm) return null;
  const doc = cm.state.doc;
  const offset = cm.documentTop - sizerTop;
  const tops = new Array<number>(doc.lines);
  const blockTops = new Array<number>(doc.lines);
  for (let i = 1; i <= doc.lines;) {
    const block = cm.lineBlockAt(doc.line(i).from);
    const n = Math.max(1, doc.lineAt(Math.min(block.to, doc.length)).number - i + 1);
    for (let k = 0; k < n && i + k <= doc.lines; k++) {
      blockTops[i - 1 + k] = block.top + offset;
      tops[i - 1 + k] = block.top + offset + (k / n) * block.height;
    }
    i += n;
  }
  // CodeMirror measures the lines it has rendered (its viewport); the rest are height estimates.
  // Raw Source has no rendered blocks to migrate against; its plain line positions cannot finish an
  // old Live Preview block's repair. Match the same mode check used to hide ink in Source mode.
  const livePreview = view.contentEl.querySelector(".markdown-source-view")?.classList.contains("is-live-preview");
  return {
    tops,
    blockTops: livePreview ? blockTops : undefined,
    measuredFrom: doc.lineAt(cm.viewport.from).number - 1,
    measuredTo: doc.lineAt(cm.viewport.to).number - 1,
  };
}

// Obsidian's reading-view renderer (internal): sections carry their element, 0-based source line range
// and measured height; getSectionTop() places off-screen sections from those heights.
interface PreviewSection {
  el: HTMLElement;
  start: { line: number };
  end: { line: number };
  height: number;
  shown?: boolean;
}
interface PreviewRenderer {
  sections: PreviewSection[];
  getSectionTop(section: PreviewSection): number;
}

function rendererOf(view: MarkdownView): PreviewRenderer | null {
  const r = (view.previewMode as unknown as { renderer?: PreviewRenderer }).renderer;
  if (!r || !Array.isArray(r.sections) || !r.sections.length || typeof r.getSectionTop !== "function") return null;
  return r;
}

/**
 * The sections that are actual note content. The renderer also lists its header (inline title and
 * properties) and footer (backlinks) as sections, both claiming "line 0"; they aren't source lines.
 */
function contentSections(r: PreviewRenderer): PreviewSection[] {
  return r.sections.filter((s) => s.el && s.start && s.end
    && !s.el.classList.contains("mod-header") && !s.el.classList.contains("mod-footer"));
}

const px = (v: string) => parseFloat(v) || 0;

/** Where a rendered section's content actually is (its first to last child), relative to the sizer. */
function contentBox(el: HTMLElement, sizerTop: number): { top: number; bottom: number } {
  const first = el.firstElementChild;
  const last = el.lastElementChild;
  if (first && last) {
    return { top: first.getBoundingClientRect().top - sizerTop, bottom: last.getBoundingClientRect().bottom - sizerTop };
  }
  const b = el.getBoundingClientRect();
  return { top: b.top - sizerTop, bottom: b.bottom - px(el.style.paddingBottom) - sizerTop };
}

/**
 * The space above a block is a top margin, not padding: padding stops the block's first paragraph's margin
 * from collapsing into the one above, so adding a few px of it widened the gap by a whole margin as well,
 * the next pass took it out again, and the text jumped up and down by that much, over and over (worst
 * while scrolling). A margin collapses with the paragraph's own, so the gap settles at one line height.
 * Below the last block (trailing blank lines) it stays padding: nothing is measured against that.
 */
function setSpace(el: HTMLElement, top: number, bottom: number) {
  const mt = top > 0 ? `${top}px` : "";
  const pb = bottom > 0 ? `${bottom}px` : "";
  if (el.style.marginTop !== mt) el.style.marginTop = mt;
  if (el.style.paddingTop) el.style.paddingTop = ""; // from versions that padded
  if (el.style.paddingBottom !== pb) el.style.paddingBottom = pb;
  if (top > 0 || bottom > 0) el.dataset.oniSpace = "1";
  else delete el.dataset.oniSpace;
}

/**
 * Reading view drops blank lines, so space you made with Enter to write in collapses and the text below
 * jumps up into your ink. For notes with ink, make the gap between each pair of blocks exactly as tall as
 * in Live Preview (one line height per blank line) by padding the lower block, and at the end of the note
 * pad the last block for trailing blank lines. Only our own inline styles, marked so they can be removed.
 */
function reserveBlankSpace(view: MarkdownView, r: PreviewRenderer, sizerTop: number, lineHeight: number, on: boolean) {
  const sections = contentSections(r);
  const count = view.editor?.lineCount() ?? 0;
  // Read every rect first, then write, so one change can't skew the next measurement.
  const plan: { el: HTMLElement; top: number; bottom: number }[] = [];
  for (let i = 0; i < sections.length; i++) {
    const s = sections[i];
    if (!s.el || !s.start || !s.end) continue;
    let top = px(s.el.style.marginTop);
    // Only the last block keeps space below it (worked out below); any other has none. Reading view builds
    // a long note in stages, and a block that was last for a moment kept the end-of-note space after the
    // rest arrived below it: a gap of every blank line to the end of the note, pushing the text out of view.
    let bottom = 0;
    if (!on) {
      top = 0;
    } else {
      const prevEnd = i > 0 ? sections[i - 1].end.line : -1;
      const want = Math.max(0, s.start.line - prevEnd - 1) * lineHeight;
      // Measure against what's actually drawn above: the previous block, or (when that's hidden, like
      // the frontmatter block in reading view) the properties header. Never more than the blank lines need.
      const above = measurable(s.el) ? visibleAboveBottom(s.el, sizerTop) : null;
      if (above !== null) {
        const box = contentBox(s.el, sizerTop);
        top = Math.min(want, Math.max(0, Math.round(top + want - (box.top - above))));
      } else if (top > want) {
        top = want;
      }
      // Trailing blank lines, if what follows this block really is just blank lines (not text that Reading
      // view hasn't built yet).
      if (i === sections.length - 1) {
        let trailing = 0;
        for (let l = s.end.line + 1; l < count; l++, trailing++) {
          if (view.editor?.getLine(l)?.trim()) { trailing = 0; break; }
        }
        bottom = trailing * lineHeight;
      }
    }
    if (top !== px(s.el.style.marginTop) || bottom !== px(s.el.style.paddingBottom) || s.el.style.paddingTop) plan.push({ el: s.el, top, bottom });
  }
  for (const p of plan) setSpace(p.el, p.top, p.bottom);
}

/** In the page and laid out with a real size (not detached, not display:none). */
function measurable(el: HTMLElement): boolean {
  return el.isConnected && el.getClientRects().length > 0 && el.getBoundingClientRect().height >= 1;
}

/**
 * Bottom of the nearest element drawn above `el`, skipping hidden blocks (the frontmatter, shown as the
 * properties header above it). Nothing (null) when the block above isn't loaded: Reading view swaps blocks
 * scrolled far out of view for a spacer of their estimated height, and measuring against that changed the
 * space mid-scroll and moved the text.
 */
function visibleAboveBottom(el: HTMLElement, sizerTop: number): number | null {
  for (let p = el.previousElementSibling; p; p = p.previousElementSibling) {
    if (p.classList.contains("markdown-preview-pusher")) return null;
    if (p instanceof HTMLElement && measurable(p)) {
      // Its own box (minus any space we added below it), not its children: a header can be taller than them.
      return p.getBoundingClientRect().bottom - px(p.style.paddingBottom) - sizerTop;
    }
  }
  return null;
}

/**
 * Diagnostics: what the reading view actually looks like to us (written to helper.log on mode switches),
 * since its DOM is Obsidian-internal and differs by version and theme.
 */
export function describeLayout(view: MarkdownView, sizer: HTMLElement, area: DOMRect, tops: number[] | undefined): string {
  const sizerRect = sizer.getBoundingClientRect();
  const r = (b: DOMRect) => `${Math.round(b.top - sizerRect.top)}..${Math.round(b.bottom - sizerRect.top)}`;
  const out: string[] = [
    `mode=${view.getMode()} sizer=${sizer.className} sizerTop(viewport)=${Math.round(sizerRect.top)} areaTop=${Math.round(area.top)}`,
    `lineHeight=${getComputedStyle(sizer).lineHeight} fontSize=${getComputedStyle(sizer).fontSize}`,
  ];
  const kids = Array.from(sizer.children).slice(0, 12).map((c) => {
    const e = c as HTMLElement;
    const shown = e.getClientRects().length > 0;
    return `  <${e.tagName.toLowerCase()} class="${e.className}"${e.style.marginTop ? ` spaceTop=${e.style.marginTop}` : ""}> ${shown ? r(e.getBoundingClientRect()) : "hidden"}` +
      (e.firstElementChild ? ` first=<${e.firstElementChild.tagName.toLowerCase()}.${(e.firstElementChild as HTMLElement).className}> ${(e.firstElementChild as HTMLElement).getClientRects().length ? r(e.firstElementChild.getBoundingClientRect()) : "hidden"}` : "");
  });
  out.push("sizer children:", ...kids);
  const rr = view.getMode() === "preview" ? rendererOf(view) : null;
  if (rr) {
    out.push("sections:", ...rr.sections.slice(0, 12).map((s) =>
      `  lines ${s.start?.line}-${s.end?.line} height=${Math.round(s.height)} connected=${s.el?.isConnected} measurable=${s.el ? measurable(s.el) : false} class="${s.el?.className}"`));
  }
  if (tops) out.push(`tops 0-20: ${tops.slice(0, 21).map((t) => Math.round(t)).join(", ")}`);
  return out.join("\n");
}

/** Remove the reserved blank space from a note's reading view (no ink, or plugin unloading). */
export function clearBlankSpace(view: MarkdownView) {
  const r = rendererOf(view);
  if (r) reserveBlankSpace(view, r, 0, 0, false);
}

/**
 * Where each source line of one rendered block starts, as Live Preview has them, so ink by any of its lines
 * sits in the same place in both views: a paragraph's lines at its line breaks, a list's at its items. A
 * block drawn as one piece (columns, maths, tables, callouts, embeds, code) has its lines spread evenly down
 * it, as Live Preview does (see editorTops), so ink beside it moves in proportion with it. (Spreading a
 * paragraph's lines put a line under a tall image halfway down the image, and the ink written by it.)
 * Off screen (not `measured`) the block isn't laid out: an even spread is the estimate.
 */
function blockLineTops(s: PreviewSection, top: number, bottom: number, sizerTop: number, lineHeight: number, measured: boolean): number[] {
  const n = s.end.line - s.start.line + 1;
  const spread = Array.from({ length: n }, (_, k) => top + (k / n) * Math.max(0, bottom - top));
  if (n === 1) return [top];
  const first = s.el.firstElementChild;
  const tag = first?.tagName;
  if (!first || !measured || !(tag === "P" || tag === "BLOCKQUOTE" || tag === "UL" || tag === "OL")) return spread;

  const tops = spread.slice();
  if (tag === "UL" || tag === "OL") {
    // Each item says which line it starts on (data-line: from the block's first line, or from the note's).
    const items = Array.from(first.querySelectorAll<HTMLElement>("li[data-line]"));
    const lines = items.map((li) => Number(li.dataset.line));
    const shift = lines.some((v) => v >= n) ? s.start.line : 0;
    const at = new Map<number, number>();
    items.forEach((li, i) => {
      const k = lines[i] - shift;
      if (Number.isInteger(k) && k >= 0 && k < n && !at.has(k)) at.set(k, li.getBoundingClientRect().top - sizerTop);
    });
    if (at.size === 0) return spread;
    let last = top;
    for (let k = 0; k < n; k++) {
      last = at.get(k) ?? last; // a line that continues an item stays with it
      tops[k] = last;
    }
    return tops;
  }
  // A paragraph (or quote): one <br> per line break, as long as the note doesn't use strict line breaks.
  const breaks = Array.from(first.querySelectorAll("br"));
  if (breaks.length !== n - 1) return spread;
  breaks.forEach((br, i) => {
    const t = topAfter(br, lineHeight);
    if (t !== null) tops[i + 1] = t - sizerTop;
  });
  return tops;
}

/** Viewport top of the line that starts after a line break: its first text (line box) or element. */
function topAfter(br: Element, lineHeight: number): number | null {
  for (let node = br.nextSibling; node; node = node.nextSibling) {
    if (node.nodeType === Node.TEXT_NODE) {
      if (!node.textContent?.trim()) continue;
      const range = document.createRange();
      range.selectNodeContents(node);
      const rect = range.getClientRects()[0];
      // The text's own box is the font's height; the line it's on starts half the leading above.
      if (rect) return rect.top - Math.max(0, (lineHeight - rect.height) / 2);
    } else if (node.nodeType === Node.ELEMENT_NODE) {
      const element = node as HTMLElement;
      if (element.classList.contains("oni-print-stroke")) continue;
      if (element.tagName === "BR") return null;
      const rect = element.getBoundingClientRect();
      if (rect.height > 0) return rect.top;
    }
  }
  return null;
}

/** Positions within a print block, converted back from Chromium's viewport scale to CSS coordinates. */
export function printBlockLineTops(el: HTMLElement, start: number, end: number, unit: number, lineHeight: number): number[] {
  const origin = el.getBoundingClientRect().top;
  const section = { el: { firstElementChild: el } as unknown as HTMLElement,
    start: { line: start }, end: { line: end }, height: 0 };
  return blockLineTops(section, 0, el.getBoundingClientRect().height, origin, lineHeight * unit, true)
    .map((top) => top / unit);
}

/** Reading view: on-screen sections are measured; off-screen ones use the renderer's own estimate. */
function previewTops(view: MarkdownView, sizer: HTMLElement, sizerTop: number, hasInk: boolean): LineLayout | null {
  const r = rendererOf(view);
  if (!r) return null;
  const lineHeight = px(getComputedStyle(sizer).lineHeight) || 24;
  reserveBlankSpace(view, r, sizerTop, lineHeight, hasInk);

  const sections = contentSections(r);
  // getSectionTop() is in the renderer's own scroll space; calibrate it against a section in the DOM.
  let offset: number | null = null;
  for (const s of sections) {
    if (!s.el || !measurable(s.el) || s.shown === false) continue;
    const est = r.getSectionTop(s);
    if (est >= 0) {
      offset = s.el.getBoundingClientRect().top - sizerTop - est;
      break;
    }
  }
  if (offset === null) return null;

  const last = sections[sections.length - 1];
  const count = Math.max(view.editor?.lineCount() ?? 0, (last?.end?.line ?? 0) + 1);
  const tops = new Array<number>(count).fill(NaN);
  let measuredFrom = Infinity;
  let measuredTo = -1;
  let prevEnd = -1;
  let prevBottom: number | null = null;
  for (const s of sections) {
    let contentTop: number;
    let contentBottom: number;
    if (measurable(s.el)) {
      ({ top: contentTop, bottom: contentBottom } = contentBox(s.el, sizerTop));
      measuredFrom = Math.min(measuredFrom, prevEnd + 1);
      measuredTo = Math.max(measuredTo, s.end.line);
    } else if (s.el.isConnected) {
      // In the page but not drawn (the frontmatter block, shown as the properties header instead):
      // its lines sit at the bottom of what's drawn above, like Live Preview puts them under the properties.
      const above = visibleAboveBottom(s.el, sizerTop);
      if (above !== null) for (let l = s.start.line; l <= s.end.line && l < count; l++) tops[l] = above;
      prevEnd = s.end.line;
      if (above !== null) prevBottom = above;
      continue;
    } else {
      const est = r.getSectionTop(s);
      if (est < 0) continue;
      contentTop = est + offset + px(s.el.style.marginTop);
      contentBottom = est + offset + (s.height || 0) - px(s.el.style.paddingBottom);
    }
    // Blank lines before this block, one line height apart, ending one line above it: as in Live Preview.
    for (let l = prevEnd + 1; l < s.start.line && l < count; l++) tops[l] = contentTop - (s.start.line - l) * lineHeight;
    // A section is one block (a paragraph, list, table...) over one or more source lines.
    const inBlock = blockLineTops(s, contentTop, contentBottom, sizerTop, lineHeight, measurable(s.el));
    for (let l = s.start.line; l <= s.end.line && l < count; l++) tops[l] = inBlock[l - s.start.line];
    prevEnd = s.end.line;
    prevBottom = contentBottom;
  }
  // Blank lines after the last block step down through the space reserved below it.
  for (let l = prevEnd + 1, j = 0; l < count; l++, j++) tops[l] = (prevBottom ?? 0) + j * lineHeight;
  // Anything left (sections the renderer skipped): the previous line's position.
  let prev = 0;
  for (let i = 0; i < count; i++) {
    if (Number.isNaN(tops[i])) tops[i] = prev;
    else prev = tops[i];
  }
  return { tops, measuredFrom: Number.isFinite(measuredFrom) ? measuredFrom : 0, measuredTo };
}

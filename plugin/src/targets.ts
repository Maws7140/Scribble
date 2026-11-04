import { FileView, MarkdownView, View } from "obsidian";
import { isDarkTheme } from "./settings";
import { imageCoordinates } from "./coordinates";

/** What the ink layer can sit on: a note, a PDF in Obsidian's PDF viewer, an image in its image view, or a canvas. */
export type InkKind = "markdown" | "pdf" | "image" | "canvas";

export function inkKindOf(view: View | null | undefined): InkKind | null {
  if (!view) return null;
  if (view instanceof MarkdownView) return "markdown";
  const type = view.getViewType();
  if (type === "pdf" || type === "image" || type === "canvas") return type;
  return null;
}

/**
 * A PDF or image laid out for ink. Ink lives in the content's own units (PDF points / image pixels), so it
 * scales with zoom: `zoom` is CSS px per unit, `ox`/`oy` the content's top-left inside `area`. A PDF's
 * pages are its "lines": `tops` is where each page starts, in points, as currently laid out (the gaps
 * between pages are fixed on screen, so they change in points as you zoom).
 */
export interface ContentLayout {
  area: DOMRect;
  /**
   * Where the in-page copy of the ink goes (see DomInk.mount): an element that scrolls with the content,
   * and the content's top-left inside it (CSS px). `positioned`: the element is already a containing block
   * (leave its CSS alone).
   */
  inkHost?: { el: HTMLElement; left: number; top: number; positioned: boolean; scale?: number; matrix?: number[] };
  transform?: number[];
  ox: number;
  oy: number;
  zoom: number;
  tops: number[];
  hashes: number[];
  source: string;
  dark: boolean;
  /** A canvas: each "line" is a card (see canvasLayout). */
  cards?: { lefts: number[]; widths: number[]; heights: number[]; papers: boolean[]; extent: number };
}

const fnv = (s: string) => {
  let h = 0x811c9dc5;
  for (let i = 0; i < s.length; i++) { h ^= s.charCodeAt(i); h = Math.imul(h, 0x01000193); }
  return h | 0 || 1;
};

// Obsidian's PDF view wraps pdf.js (5.x). Internal; only used for each page's exact scale.
interface PdfJsViewer { getPageView?(index: number): { viewport?: { scale?: number } } | undefined }

export function pdfLayout(view: FileView): ContentLayout | null {
  const container = view.contentEl.querySelector(".pdf-viewer-container");
  if (!(container instanceof HTMLElement)) return null;
  const pages = Array.from(container.querySelectorAll<HTMLElement>(".page[data-page-number]"));
  if (!pages.length) return null;

  // CSS px per PDF point: from pdf.js itself, else the --scale-factor it sets on the viewer.
  const api = (view as unknown as { viewer?: { child?: { pdfViewer?: { pdfViewer?: PdfJsViewer } } } }).viewer?.child?.pdfViewer?.pdfViewer;
  let zoom = api?.getPageView?.(0)?.viewport?.scale ?? 0;
  let source = "pdf.js viewport";
  if (!(zoom > 0)) {
    zoom = parseFloat(getComputedStyle(pages[0]).getPropertyValue("--scale-factor"));
    source = "--scale-factor";
  }
  if (!(zoom > 0) || !isFinite(zoom)) return null;

  const area = container.getBoundingClientRect();
  // Page content starts inside the page's border.
  const first = pages[0].getBoundingClientRect();
  const left0 = first.left + pages[0].clientLeft;
  const top0 = first.top + pages[0].clientTop;
  const tops = pages.map((p) => (p.getBoundingClientRect().top + p.clientTop - top0) / zoom);
  const hashes = pages.map((p) => fnv("page " + p.dataset.pageNumber));

  // Ink colours follow the page, not the app theme: Obsidian can draw PDF pages dark in dark mode.
  const bg = getComputedStyle(pages[0]).backgroundColor;
  // The scrolling container itself: its content (the pages) scrolls under it.
  const inkHost = { el: container, left: left0 - area.left - container.clientLeft + container.scrollLeft, top: top0 - area.top - container.clientTop + container.scrollTop, positioned: true };
  return { area, inkHost, ox: left0 - area.left, oy: top0 - area.top, zoom, tops, hashes, source, dark: isDarkColor(bg) };
}

export function imageLayout(view: FileView): ContentLayout | null {
  const img = view.contentEl.querySelector(".image-container img");
  if (!(img instanceof HTMLImageElement) || !img.naturalWidth) return null;
  const area = view.contentEl.getBoundingClientRect();
  const r = img.getBoundingClientRect();
  if (r.width === 0) return null;
  // Ink in image pixels: it stays on the same spot of the picture at any size. Pictures aren't recoloured.
  // The in-page copy goes beside the picture, in its container (which scrolls with it).
  const box = img.parentElement;
  const coordinates = box ? imageCoordinates(img, box) : null;
  if (!box || !coordinates) return null;
  const { visual: m, local: local } = coordinates;
  const zoom = Math.hypot(m.a, m.b);
  const inkHost = { el: box, left: 0, top: 0, positioned: true, matrix: [local.a, local.b, local.c, local.d, local.e, local.f] };
  return { area, inkHost, ox: m.e - area.left, oy: m.f - area.top, zoom, transform: [m.a, m.b, m.c, m.d],
    tops: [0], hashes: [1], source: "image", dark: false };
}

/**
 * Ink units on a canvas are canvas px plus this. Canvas positions go negative but the ink layer starts at 0,
 * so 0,0 on the canvas is here, in the middle of an ink layer CANVAS_EXTENT square.
 */
export const CANVAS_ORIGIN = 50_000;
const CANVAS_EXTENT = CANVAS_ORIGIN * 2;

// Obsidian's Canvas (internal; only for the cards: where they are and which is on top).
interface CanvasCard { id: string; x: number; y: number; width: number; height: number; renderedZIndex?: number; nodeEl?: HTMLElement; filePath?: string }

/** A card ink sits on as on a light page, whatever the theme: a picture, or a PDF that isn't drawn dark. */
function isPaper(card: CanvasCard) {
  if (/\.(png|jpe?g|gif|bmp|webp|svg|avif)$/i.test(card.filePath ?? "")) return true;
  if (!/\.pdf$/i.test(card.filePath ?? "")) return false;
  const page = card.nodeEl?.querySelector(".page");
  return !page || !isDarkColor(getComputedStyle(page).backgroundColor);
}

/**
 * A canvas laid out for ink. Position and zoom come from the layer Canvas draws its cards in, so they're
 * what's on screen, and the in-page copy of the ink goes inside that layer, where Canvas's own pan and zoom
 * carry it. The "lines" are the board (line 0, which never moves) and each card, in stacking order (bottom
 * first), so ink on a card follows it (see Anchors.cs). Cards are found again by a fingerprint of their ID.
 */
export function canvasLayout(view: FileView): ContentLayout | null {
  const layer = view.contentEl.querySelector(".canvas-wrapper .canvas");
  if (!(layer instanceof HTMLElement) || !layer.offsetWidth) return null;
  const r = layer.getBoundingClientRect();
  const zoom = r.width / layer.offsetWidth;
  if (!(zoom > 0) || !isFinite(zoom)) return null;
  const area = view.contentEl.getBoundingClientRect();
  const nodes = (view as unknown as { canvas?: { nodes?: Map<string, CanvasCard> } }).canvas?.nodes;
  const isGroup = (c: CanvasCard) => c.nodeEl?.hasClass("canvas-node-group") ?? false;
  const cards = (nodes instanceof Map ? Array.from(nodes.values()) : [])
    .sort((a, b) => Number(isGroup(b)) - Number(isGroup(a)) || (a.renderedZIndex ?? 0) - (b.renderedZIndex ?? 0));
  return {
    area,
    inkHost: { el: layer, left: -CANVAS_ORIGIN, top: -CANVAS_ORIGIN, positioned: true, scale: 1 },
    ox: r.left - area.left - CANVAS_ORIGIN * zoom,
    oy: r.top - area.top - CANVAS_ORIGIN * zoom,
    zoom,
    tops: [0, ...cards.map((c) => c.y + CANVAS_ORIGIN)],
    hashes: [fnv("canvas board"), ...cards.map((c) => fnv(c.id))],
    cards: {
      lefts: [0, ...cards.map((c) => c.x + CANVAS_ORIGIN)],
      widths: [0, ...cards.map((c) => c.width)],
      heights: [0, ...cards.map((c) => c.height)],
      papers: [false, ...cards.map(isPaper)],
      extent: CANVAS_EXTENT,
    },
    source: "canvas",
    dark: isDarkTheme(),
  };
}

function isDarkColor(css: string): boolean {
  const m = /rgba?\((\d+),\s*(\d+),\s*(\d+)(?:,\s*([\d.]+))?/.exec(css);
  if (!m || (m[4] !== undefined && parseFloat(m[4]) === 0)) return false;
  const [r, g, b] = [m[1], m[2], m[3]].map(Number);
  return 0.2126 * r + 0.7152 * g + 0.0722 * b < 96;
}

/** Where a file's ink is kept: `Note.ink` next to `Note.md`; `file.pdf.ink` / `image.png.ink` for others. */
export function inkFileFor(notePath: string, kind: InkKind): string {
  return kind === "markdown" ? notePath.replace(/\.md$/i, ".ink") : notePath + ".ink";
}

/**
 * The note's own copy of its ink, drawn in the page (SVG) so it scrolls exactly with the text. The helper
 * sends each stroke's outline (the same shape Windows Ink draws) when it's new or changed, plus the order
 * of all strokes, and says when its native layer is on screen (pen near, a selection...): then this copy
 * hides, so there's never two.
 */
export interface DomStroke {
  id: number;
  /** SVG path of the stroke's outline, in ink units (CSS px from the text column's top-left). */
  d?: string;
  /** Or a picture of it (PNG, base64: a pencil stroke as Windows drew it) at x, y, w, h in ink units. */
  img?: string;
  x?: number;
  y?: number;
  w?: number;
  h?: number;
  /** Colour #RRGGBB and opacity. */
  c: string;
  o: number;
  /** Highlighter: drawn first, under the pen ink. */
  hl: boolean;
}

export interface DomUpdate {
  path?: string;
  /** Start over (another note, or the copy was off). */
  reset?: boolean;
  /** Every stroke's id, in drawing order; ids not listed are gone. */
  order?: number[];
  /** New or changed strokes. */
  add?: DomStroke[];
  /** The line positions this drawing is laid out for (see moveLines); a note's only, 0 otherwise. */
  seq?: number;
  /** The line each stroke in `order` belongs to; -1 for none. */
  lines?: number[];
}

const SVG = "http://www.w3.org/2000/svg";

interface Entry { el: SVGPathElement | SVGImageElement; hl: boolean; line: number; moved: number }
interface Lines { tops: number[]; hashes: number[] }

/** Line positions kept while the helper catches up (it's rarely more than a few behind). */
const MAX_LINES = 64;

export class DomInk {
  private svg: SVGSVGElement;
  private path = "";
  private nativeShown = true;
  private strokes = new Map<number, Entry>();
  private linesPath = "";
  private sentLines = new Map<number, Lines>();
  private latest: Lines | null = null;
  private drawnFor = 0;

  constructor() {
    this.svg = document.createElementNS(SVG, "svg");
    this.svg.classList.add("oni-ink-svg");
    this.svg.setAttribute("aria-hidden", "true");
  }

  update(u: DomUpdate) {
    const path = u.path ?? "";
    if (u.reset || path !== this.path) {
      this.strokes.clear();
      this.path = path;
    }
    for (const s of u.add ?? []) {
      const kind = s.img ? "image" : "path";
      let entry = this.strokes.get(s.id);
      if (!entry || entry.el.tagName !== kind) {
        entry = { el: document.createElementNS(SVG, kind) as SVGPathElement | SVGImageElement, hl: s.hl, line: -1, moved: 0 };
        this.strokes.set(s.id, entry);
      }
      entry.hl = s.hl;
      const el = entry.el;
      if (s.img) {
        el.setAttribute("href", `data:image/png;base64,${s.img}`);
        el.setAttribute("x", String(s.x ?? 0));
        el.setAttribute("y", String(s.y ?? 0));
        el.setAttribute("width", String(s.w ?? 0));
        el.setAttribute("height", String(s.h ?? 0));
        el.setAttribute("preserveAspectRatio", "none");
      } else {
        el.setAttribute("d", s.d ?? "");
        el.setAttribute("fill", s.c);
        if (s.o < 1) el.setAttribute("fill-opacity", String(s.o));
        else el.removeAttribute("fill-opacity");
      }
    }
    const order = u.order ?? [...this.strokes.keys()];
    const keep = new Set(order);
    for (const id of [...this.strokes.keys()]) if (!keep.has(id)) this.strokes.delete(id);
    const listed = order.map((id) => this.strokes.get(id)).filter((e): e is Entry => !!e);
    // Highlighters under the pen ink, each group in drawing order.
    this.svg.replaceChildren(...listed.filter((e) => e.hl).map((e) => e.el), ...listed.filter((e) => !e.hl).map((e) => e.el));
    order.forEach((id, i) => {
      const entry = this.strokes.get(id);
      if (entry) entry.line = u.lines?.[i] ?? -1;
    });
    this.drawnFor = u.seq ?? 0;
    for (const seq of [...this.sentLines.keys()]) if (seq < this.drawnFor) this.sentLines.delete(seq);
    this.follow();
  }

  /**
   * The note's lines moved. The helper moves the ink for good, but that takes a few hundred ms, and meanwhile
   * the ink would be left where the text was: when Live Preview corrected the height of the lines above while
   * you scrolled up, the text stayed put and the ink flew off by 170 px and came back. So each stroke follows
   * its line now, in the frame the line moved, until the helper's own drawing for these lines arrives.
   */
  moveLines(path: string, seq: number, tops: number[], hashes: number[]) {
    if (path !== this.linesPath) {
      this.linesPath = path;
      this.sentLines.clear();
    }
    this.latest = { tops, hashes };
    this.sentLines.set(seq, this.latest);
    for (const old of this.sentLines.keys()) {
      if (this.sentLines.size <= MAX_LINES) break;
      if (old !== this.drawnFor) this.sentLines.delete(old);
    }
    this.follow();
  }

  /** Where each stroke's line is now against where it was drawn for. Text edited since: the helper's to work out. */
  private follow() {
    const from = this.sentLines.get(this.drawnFor);
    const to = this.latest;
    const same = !!from && !!to && this.linesPath === this.path && from.hashes.length === to.hashes.length
      && from.hashes.every((h, i) => h === to.hashes[i]);
    for (const entry of this.strokes.values()) {
      const by = same && entry.line >= 0 && entry.line < to.tops.length ? to.tops[entry.line] - from.tops[entry.line] : 0;
      const move = Math.abs(by) < 0.25 ? 0 : by;
      if (move === entry.moved) continue;
      entry.moved = move;
      if (move) entry.el.setAttribute("transform", `translate(0 ${move})`);
      else entry.el.removeAttribute("transform");
    }
  }

  /** The helper's own layer is on screen (true) or not: this copy shows only when it isn't. */
  setNative(inkPath: string, visible: boolean) {
    if (inkPath && inkPath !== this.path) return;
    this.nativeShown = visible;
    this.svg.style.visibility = visible ? "hidden" : "";
  }

  /**
   * Keep the copy in the note being shown (its text column, where ink coordinates start), or take it out
   * when there's no note, the ink is for another note, or the ink layer is off.
   *
   * `at`: a PDF or a picture instead. The copy goes in an element that scrolls with it (the PDF viewer's
   * scrolling container, the picture's box), at the content's top-left, scaled from ink units (PDF points,
   * image pixels) to CSS px: it then scrolls with the pages, where the ink window chasing them lagged and
   * bounced. `positioned`: the element is a containing block already, so its CSS is left alone.
   */
  mount(host: HTMLElement | null, inkPath: string | null, at?: { left: number; top: number; scale: number; positioned?: boolean }) {
    if (!host || !inkPath || inkPath !== this.path) {
      this.svg.remove();
      return;
    }
    if (this.svg.parentElement !== host) {
      if (!at?.positioned) host.addClass("oni-ink-host");
      host.appendChild(this.svg);
      this.svg.style.visibility = this.nativeShown ? "hidden" : "";
    }
    const place = at ? `${Math.round(at.left * 100) / 100}|${Math.round(at.top * 100) / 100}|${at.scale}` : "";
    if (place !== this.placed) {
      this.placed = place;
      this.svg.style.left = at ? `${at.left}px` : "";
      this.svg.style.top = at ? `${at.top}px` : "";
      this.svg.style.transformOrigin = at ? "0 0" : "";
      this.svg.style.transform = at ? `scale(${at.scale})` : "";
    }
  }

  private placed = "";

  destroy() {
    this.svg.remove();
  }
}

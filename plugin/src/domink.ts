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
  /** Reference positions for this snapshot, independent of whichever pane currently has focus. */
  tops?: number[];
  hashes?: number[];
  anchorTops?: number[];
}

const SVG = "http://www.w3.org/2000/svg";

interface Entry { el: SVGPathElement | SVGImageElement; hl: boolean; line: number; moved: number; top?: number }
interface Lines { tops: number[]; hashes: number[]; from?: number; to?: number }

/** Line positions kept while the helper catches up (it's rarely more than a few behind). */
const MAX_LINES = 64;

export class DomInk {
  private svg: SVGSVGElement;
  private path = "";
  private nativeShown = false;
  private strokes = new Map<number, Entry>();
  private linesPath = "";
  private sentLines = new Map<number, Lines>();
  private latest: Lines | null = null;
  private drawnFor = 0;
  private drawnLines: Lines | null = null;

  get ready(): boolean { return this.svg.isConnected && !this.nativeShown; }

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
        entry = { el: document.createElementNS<typeof kind>(SVG, kind), hl: s.hl, line: -1, moved: 0 };
        this.strokes.set(s.id, entry);
      }
      entry.hl = s.hl;
      const el = entry.el;
      // A new helper geometry already includes its projection. Never apply an older correction twice.
      entry.moved = 0;
      el.removeAttribute("transform");
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
    const children = [...listed.filter((e) => e.hl), ...listed.filter((e) => !e.hl)].map(e => e.el);
    if (children.length !== this.svg.childNodes.length || children.some((el, i) => this.svg.childNodes[i] !== el)) {
      this.svg.replaceChildren(...children);
    }
    order.forEach((id, i) => {
      const entry = this.strokes.get(id);
      if (entry) entry.line = u.lines?.[i] ?? -1;
      if (entry) entry.top = u.anchorTops?.[i];
    });
    this.drawnFor = u.seq ?? 0;
    this.drawnLines = u.tops && u.hashes ? { tops: u.tops, hashes: u.hashes } : null;
    for (const seq of [...this.sentLines.keys()]) if (seq < this.drawnFor) this.sentLines.delete(seq);
    this.follow();
  }

  /**
   * The note's lines moved. The helper updates its display projection, but that takes a few hundred ms, and meanwhile
   * the ink would be left where the text was: when Live Preview corrected the height of the lines above while
   * you scrolled up, the text stayed put and the ink flew off by 170 px and came back. So each stroke follows
   * its line now, in the frame the line moved, until the helper's own drawing for these lines arrives.
   */
  moveLines(path: string, seq: number, tops: number[], hashes: number[], from = 0, to = tops.length - 1) {
    if (path !== this.linesPath) {
      this.linesPath = path;
      this.sentLines.clear();
    }
    this.latest = { tops, hashes, from, to };
    this.sentLines.set(seq, this.latest);
    for (const old of this.sentLines.keys()) {
      if (this.sentLines.size <= MAX_LINES) break;
      if (old !== this.drawnFor) this.sentLines.delete(old);
    }
    this.follow();
  }

  /** Follow measured lines and unchanged text references; keep the last valid projection during ambiguous edits. */
  private follow() {
    const from = this.drawnLines ?? this.sentLines.get(this.drawnFor);
    const to = this.latest;
    const same = !!from && !!to && this.linesPath === this.path && from.hashes.length === to.hashes.length
      && from.hashes.every((h, i) => h === to.hashes[i]);
    const oldCounts = new Map<number, number>();
    const newPositions = new Map<number, number[]>();
    if (!same && from && to) {
      for (const hash of from.hashes) if (hash) oldCounts.set(hash, (oldCounts.get(hash) ?? 0) + 1);
      to.hashes.forEach((hash, i) => {
        if (!hash) return;
        const positions = newPositions.get(hash) ?? [];
        positions.push(i); newPositions.set(hash, positions);
      });
    }
    const resolved = new Map<number, number>();
    const resolve = (line: number): number => {
      if (!from || !to || line < 0 || line >= from.hashes.length) return -1;
      if (same) return line;
      // Use a unique reference above the anchor, like the helper; fall back to one below. Unknown
      // or ambiguous edits retain the last valid projection until a matching helper snapshot arrives.
      for (const step of [-1, 1]) {
        for (let i = step < 0 ? line : line + 1; i >= 0 && i < from.hashes.length; i += step) {
          const hash = from.hashes[i], positions = newPositions.get(hash);
          if (oldCounts.get(hash) === 1 && positions?.length === 1) return positions[0] + line - i;
        }
      }
      return -1;
    };
    const relocate = (line: number) => {
      if (!resolved.has(line)) resolved.set(line, resolve(line));
      return resolved.get(line)!;
    };
    for (const entry of this.strokes.values()) {
      const line = this.linesPath === this.path ? relocate(entry.line) : -1;
      if (!from || !to || line < (to.from ?? 0) || line > (to.to ?? to.tops.length - 1)
        || line < 0 || line >= to.tops.length) continue;
      const by = to.tops[line] - (entry.top ?? from.tops[entry.line]);
      if (!Number.isFinite(by)) continue;
      const move = Math.abs(by) < 1e-9 ? 0 : by;
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
  mount(host: HTMLElement | null, inkPath: string | null, at?: { left: number; top: number; scale: number; positioned?: boolean; matrix?: number[] }) {
    if (!host || !inkPath || inkPath !== this.path) {
      this.svg.remove();
      return;
    }
    if (this.svg.parentElement !== host) {
      if (!at?.positioned) host.addClass("oni-ink-host");
      host.appendChild(this.svg);
      this.svg.style.visibility = this.nativeShown ? "hidden" : "";
    }
    const place = at ? `${at.left}|${at.top}|${at.scale}|${at.matrix?.join(",") ?? ""}` : "";
    if (place !== this.placed) {
      this.placed = place;
      this.svg.style.left = at ? `${at.left}px` : "";
      this.svg.style.top = at ? `${at.top}px` : "";
      this.svg.style.transformOrigin = at ? "0 0" : "";
      this.svg.style.transform = at?.matrix ? `matrix(${at.matrix.join(",")})` : at ? `scale(${at.scale})` : "";
    }
  }

  private placed = "";

  destroy() {
    this.svg.remove();
  }
}

interface Pane { ink: DomInk; path: string; host: HTMLElement | null; at?: Parameters<DomInk["mount"]>[2] }
export interface NativeInk { path: string; viewId?: string; visible: boolean; id?: number }

/** One passive drawing per visible view, sharing immutable snapshots rather than moving one SVG around. */
export class InkPanes {
  private panes = new Map<object, Pane>();
  private snapshots = new Map<string, DomUpdate>();
  private stale = new Set<string>();
  private active: object | null = null;
  private viewId = "";
  private pending: NativeInk | null = null;
  private ackFrame = 0;
  private nativeEpoch = -1;
  private versions = new Map<string, number>();
  private clock = 0;

  /** `lost`: the helper sent a change to a drawing we no longer have, so it should send the whole thing. */
  constructor(private acknowledge: (message: NativeInk) => void, private lost: () => void) {}

  select(key: object | null, viewId: string) {
    if (key === this.active && viewId === this.viewId) return;
    const old = this.active && this.panes.get(this.active);
    if (old) old.ink.setNative(old.path, false);
    this.active = key;
    this.viewId = viewId;
    this.cancelAck();
  }

  has(path: string): boolean { return this.snapshots.has(path) && !this.stale.has(path); }
  snapshotToken(path: string): number {
    if (!this.versions.has(path)) this.versions.set(path, ++this.clock);
    return this.versions.get(path)!;
  }
  invalidate(path: string) { this.versions.set(path, ++this.clock); this.stale.add(path); }
  invalidateAll() { for (const path of new Set([...this.snapshots.keys(), ...this.versions.keys()])) this.invalidate(path); }
  seed(update: DomUpdate, token?: number): boolean {
    if (!update.path || this.has(update.path) || token !== undefined && this.versions.get(update.path) !== token) return false;
    this.update(update);
    return true;
  }

  update(update: DomUpdate) {
    const path = update.path;
    if (!path) return;
    this.versions.set(path, ++this.clock);
    const previous = update.reset ? undefined : this.snapshots.get(path);
    if (!update.reset && !previous) {
      this.lost();
      return;
    }
    const strokes = new Map((previous?.add ?? []).map(s => [s.id, s]));
    for (const stroke of update.add ?? []) strokes.set(stroke.id, stroke);
    const order = update.order ?? [...strokes.keys()];
    const full = { ...update, reset: true, order, add: order.flatMap(id => strokes.has(id) ? [strokes.get(id)!] : []) };
    this.snapshots.set(path, full);
    this.stale.delete(path);
    for (const pane of this.panes.values()) if (pane.path === path) {
      pane.ink.update(previous ? update : full);
      pane.ink.mount(pane.host, path, pane.at);
    }
  }

  mount(host: HTMLElement | null, path: string | null, at?: Parameters<DomInk["mount"]>[2]) {
    if (this.active) this.mountFor(this.active, host, path, at);
  }

  mountFor(key: object, host: HTMLElement | null, path: string | null, at?: Parameters<DomInk["mount"]>[2]) {
    let pane = this.panes.get(key);
    if (!path || pane && pane.path !== path) {
      pane?.ink.destroy();
      this.panes.delete(key);
      pane = undefined;
    }
    if (!path) return;
    if (!pane) {
      pane = { ink: new DomInk(), path, host, at };
      this.panes.set(key, pane);
      const snapshot = this.snapshots.get(path);
      if (snapshot) pane.ink.update(snapshot);
    }
    pane.host = host;
    pane.at = at;
    pane.ink.mount(host, path, at);
  }

  moveLines(path: string, seq: number, tops: number[], hashes: number[], from = 0, to = tops.length - 1) {
    if (this.active) this.moveLinesFor(this.active, path, seq, tops, hashes, from, to);
  }

  moveLinesFor(key: object, path: string, seq: number, tops: number[], hashes: number[], from = 0, to = tops.length - 1) {
    this.panes.get(key)?.ink.moveLines(path, seq, tops, hashes, from, to);
  }

  setNative(message: NativeInk) {
    if (!this.active || message.viewId !== this.viewId) return;
    if (message.id !== undefined && message.id < this.nativeEpoch) return;
    const pane = this.panes.get(this.active);
    if (!pane || message.path !== pane.path) return;
    if (message.id !== undefined) this.nativeEpoch = message.id;
    this.cancelAck();
    pane.ink.setNative(message.path, message.visible);
    if (message.visible || message.id === undefined) return;
    this.pending = message;
    // The second frame runs after the first has painted. A busy/hidden page keeps native ink until ready.
    let painted = false;
    const check = () => {
      if (this.pending !== message) return;
      if (pane.ink.ready && painted) {
        this.pending = null;
        this.ackFrame = 0;
        this.acknowledge(message);
        return;
      }
      painted = pane.ink.ready;
      this.ackFrame = window.requestAnimationFrame(check);
    };
    this.ackFrame = window.requestAnimationFrame(check);
  }

  releaseNative() {
    this.cancelAck();
    this.nativeEpoch = -1;
    for (const pane of this.panes.values()) pane.ink.setNative(pane.path, false);
  }

  prune(visible: Set<object>) {
    for (const [key, pane] of this.panes) if (!visible.has(key)) {
      pane.ink.destroy();
      this.panes.delete(key);
    }
    const used = new Set([...this.panes.values()].map(p => p.path));
    for (const path of this.snapshots.keys()) if (!used.has(path)) {
      this.snapshots.delete(path);
      this.stale.delete(path);
    }
    for (const path of this.versions.keys()) if (!used.has(path)) {
      this.versions.delete(path);
      this.stale.delete(path);
    }
  }

  private cancelAck() {
    if (this.ackFrame) window.cancelAnimationFrame(this.ackFrame);
    this.ackFrame = 0;
    this.pending = null;
  }

  destroy() {
    this.releaseNative();
    for (const pane of this.panes.values()) pane.ink.destroy();
    this.panes.clear();
    this.snapshots.clear();
    this.stale.clear();
    this.versions.clear();
  }
}

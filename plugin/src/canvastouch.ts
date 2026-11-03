/** Obsidian's Canvas (internal), the parts a finger moves. Positions are canvas px. */
export interface TouchCanvas {
  wrapperEl: HTMLElement;
  zoom: number;
  tZoom: number;
  scale: number;
  pauseAnimation: number;
  panBy(dx: number, dy: number): void;
  posFromClient(at: { x: number; y: number }): { x: number; y: number };
  markViewportChanged(): void;
}

// Obsidian's own limits: its zoom is a power of two.
const MIN_ZOOM = -4;
const MAX_ZOOM = 1;
// Past this a finger is moving; held this long first, it's a long press, which picks a card up in Obsidian.
const SLOP_PX = 5;
const LONG_PRESS_MS = 600;

/** On the canvas, but a finger here isn't moving the canvas. */
const NOT_THE_BOARD = ".canvas-controls, .canvas-card-menu, .canvas-menu, button, input, textarea, select, [contenteditable='true']";

interface Finger {
  x: number;
  y: number;
  /** The spot on the canvas this finger is holding: it stays under the finger. */
  at: { x: number; y: number };
}

/**
 * One finger drags a canvas and two pinch it, however the touch gets here. Obsidian has this too, but it gives
 * up on a touch it doesn't count as the first one, and it never sees a touch that lands on the ink layer while
 * the pen is near (the helper passes those along). The two can run side by side: each keeps the spot under the
 * finger under the finger, so whichever is second finds nothing left to do.
 */
export class CanvasTouch {
  private fingers = new Map<number, Finger>();
  private canvas: TouchCanvas | null = null;
  private moved = false;
  /** Fingers on something else (a control, a card that scrolls): the board stays put until they lift. */
  private ignored = new Set<number>();
  private startedAt = 0;
  private start = { x: 0, y: 0 };
  private moves = 0;
  private most = 0;
  private source = "";

  constructor(private log: (message: string) => void) {}

  /** A finger on the page: `canvas` is the one in front, if that's what's there. */
  onPointerDown(e: PointerEvent, canvas: TouchCanvas | null) {
    if (e.pointerType !== "touch") return;
    const target = e.target instanceof Element ? e.target : null;
    const onBoard = !!canvas && !!target && canvas.wrapperEl.contains(target);
    // A new touch starts afresh, in case the end of an earlier one never arrived.
    if (e.isPrimary) this.ignored.clear();
    if (!onBoard || this.ignored.size || (!this.fingers.size && !movesTheBoard(target, canvas.wrapperEl))) {
      this.ignored.add(e.pointerId);
      return;
    }
    this.down(e.pointerId, e.clientX, e.clientY, canvas, "page");
  }

  onPointerMove(e: PointerEvent) {
    if (e.pointerType === "touch") this.move(e.pointerId, e.clientX, e.clientY);
  }

  onPointerEnd(e: PointerEvent) {
    if (e.pointerType !== "touch") return;
    this.ignored.delete(e.pointerId);
    this.up(e.pointerId);
  }

  down(id: number, x: number, y: number, canvas: TouchCanvas, source: string) {
    if (!this.fingers.size) {
      this.canvas = canvas;
      this.moved = false;
      this.startedAt = performance.now();
      this.start = { x, y };
      this.moves = 0;
      this.most = 0;
      this.source = source;
    }
    this.fingers.set(id, { x, y, at: canvas.posFromClient({ x, y }) });
    this.most = Math.max(this.most, this.fingers.size);
    // A second finger starts a pinch, moving or not.
    if (this.fingers.size === 2) this.moved = true;
  }

  move(id: number, x: number, y: number) {
    const finger = this.fingers.get(id);
    const canvas = this.canvas;
    if (!finger || !canvas) return;
    finger.x = x;
    finger.y = y;
    this.moves++;
    if (!this.moved) {
      if (Math.hypot(x - this.start.x, y - this.start.y) <= SLOP_PX) return;
      if (performance.now() - this.startedAt >= LONG_PRESS_MS) return;
      this.moved = true;
    }
    const [a, b] = this.fingers.values();
    if (b) this.pinch(canvas, a, b);
    else {
      const now = canvas.posFromClient(a);
      canvas.panBy(a.at.x - now.x, a.at.y - now.y);
    }
  }

  up(id: number) {
    if (!this.fingers.delete(id)) return;
    const canvas = this.canvas;
    if (!canvas) return;
    if (!this.fingers.size) {
      this.log(`canvas touch from the ${this.source}: ${this.most} finger(s), ${this.moves} moves, ${this.moved ? "moved it" : "left it"}, zoom ${canvas.scale.toFixed(2)}`);
      this.canvas = null;
      return;
    }
    // What's still down holds the spot it's on now.
    for (const finger of this.fingers.values()) finger.at = canvas.posFromClient(finger);
  }

  private pinch(canvas: TouchCanvas, a: Finger, b: Finger) {
    const middle = { x: (a.at.x + b.at.x) / 2, y: (a.at.y + b.at.y) / 2 };
    const before = Math.hypot(a.at.x - b.at.x, a.at.y - b.at.y);
    let nowA = canvas.posFromClient(a);
    let nowB = canvas.posFromClient(b);
    const after = Math.hypot(nowA.x - nowB.x, nowA.y - nowB.y);
    if (before > 0 && after > 0) {
      const zoom = Math.min(MAX_ZOOM, Math.max(MIN_ZOOM, Math.log2(canvas.scale * after / before)));
      canvas.zoom = canvas.tZoom = zoom;
      canvas.scale = Math.pow(2, zoom);
      canvas.markViewportChanged();
      canvas.pauseAnimation = Date.now() + 200;
    }
    nowA = canvas.posFromClient(a);
    nowB = canvas.posFromClient(b);
    canvas.panBy(middle.x - (nowA.x + nowB.x) / 2, middle.y - (nowA.y + nowB.y) / 2);
    a.at = canvas.posFromClient(a);
    b.at = canvas.posFromClient(b);
  }
}

/** Not a control, and not inside a card that scrolls: that finger is for the card (Obsidian leaves it too). */
function movesTheBoard(target: Element | null, wrapper: HTMLElement) {
  if (!target || target.closest(NOT_THE_BOARD)) return false;
  for (let el: Element | null = target; el && el !== wrapper; el = el.parentElement) {
    if (el.scrollHeight <= el.clientHeight && el.scrollWidth <= el.clientWidth) continue;
    const style = getComputedStyle(el);
    if (["auto", "scroll"].includes(style.overflowY) || ["auto", "scroll"].includes(style.overflowX)) return false;
  }
  return true;
}

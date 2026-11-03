import type { MarkdownView } from "obsidian";

/** How long a view can take to finish building after a switch (Reading view builds a long note in stages). */
const HOLD_MS = 3000;
/** Obsidian has put its own scroll back by now, so a long way off after this is something else scrolling. */
const SETTLE_MS = 1000;

interface Place {
  view: MarkdownView;
  path: string;
  mode: string;
  line: number;
  /** How far through the line, and how far past the end of the note (in the ink below the text). */
  frac: number;
  past: number;
  /** Where it is on screen. */
  y: number;
}

/**
 * Keeps the line at the middle of the screen where it is when you switch between Reading view and Live
 * Preview. Obsidian carries the scroll across by source line, which lands 55-70 px off even when the two
 * layouts match, and Reading view moves again as it builds, so the place is put back every frame until it's
 * done. Any touch, wheel or key ends that at once: the page is yours again. So does a jump from elsewhere (a
 * link, a command).
 */
export class LineHold {
  private tops: number[] | null = null;
  private topsMode = "";
  private place: Place | null = null;
  private until = 0;
  private roomIn: HTMLElement | null = null;
  private switchedAt = 0;
  private lastScroll = NaN;

  get holding(): boolean {
    return performance.now() < this.until;
  }

  /** Where the lines are now (in px from the top of the text column). */
  measured(mode: string, tops: number[]) {
    this.tops = tops;
    this.topsMode = mode;
  }

  cancel() {
    this.until = 0;
  }

  /** Once a frame. True while holding: the lines should be measured every frame. */
  frame(view: MarkdownView, sizer: HTMLElement, path: string): boolean {
    const scroller = sizer.closest<HTMLElement>(".cm-scroller, .markdown-preview-view");
    if (!scroller) return false;
    const mode = view.getMode();
    const now = performance.now();
    const place = this.place?.view === view && this.place.path === path ? this.place : null;
    if (place && place.mode !== mode) {
      place.mode = mode;
      this.until = now + HOLD_MS;
      this.switchedAt = now;
      this.lastScroll = NaN;
    }
    const tops = this.topsMode === mode ? this.tops : null;
    if (place && now < this.until) {
      if (tops && place.line < tops.length) {
        const top = tops[place.line];
        const next = tops[place.line + 1] ?? top;
        const by = sizer.getBoundingClientRect().top + top + place.frac * (next - top) + place.past - place.y;
        const scrolled = Math.abs(scroller.scrollTop - this.lastScroll) >= 1;
        if (scrolled && now - this.switchedAt > SETTLE_MS && Math.abs(by) > scroller.clientHeight / 3) {
          this.until = 0;
          return false;
        }
        if (Math.abs(by) >= 1) {
          const want = scroller.scrollTop + by;
          scroller.scrollTop = want;
          // Reading view hasn't built that far down yet, so the page is too short to get there (in the ink
          // below the text, it was 660 px off for a moment). It gets the room for as long as this lasts.
          const short = want - scroller.scrollTop;
          if (short > 1 && mode === "preview") {
            sizer.style.setProperty("--oni-hold-height", `${sizer.getBoundingClientRect().height + short}px`);
            this.roomIn = sizer;
            scroller.scrollTop = want;
          }
        }
        this.lastScroll = scroller.scrollTop;
      }
      return true;
    }
    this.roomIn?.style.removeProperty("--oni-hold-height");
    this.roomIn = null;
    if (!tops?.length) return false;
    const box = scroller.getBoundingClientRect();
    const y = box.top + box.height / 2;
    const at = y - sizer.getBoundingClientRect().top;
    // Last line whose top is at or above the middle of the screen.
    let lo = 0, hi = tops.length - 1, line = 0;
    while (lo <= hi) {
      const mid = (lo + hi) >> 1;
      if (tops[mid] <= at) { line = mid; lo = mid + 1; } else hi = mid - 1;
    }
    const span = (tops[line + 1] ?? tops[line]) - tops[line];
    this.place = { view, path, mode, line, y,
      frac: span > 0 ? Math.min(1, (at - tops[line]) / span) : 0,
      past: span > 0 ? 0 : at - tops[line] };
    return false;
  }
}

/** Measure local CSS axes through the browser, including transformed ancestors and CSS zoom. */
interface Probe { root: HTMLElement; points: HTMLElement[]; style: string }
const hosts = new WeakMap<HTMLElement, Probe>();
const images = new WeakMap<HTMLImageElement, Probe>();

function probe(host: HTMLElement, previous: Probe | undefined, style: string): Probe {
  const value = previous ?? (() => {
    const root = createDiv();
    root.className = "oni-coordinate-probe";
    root.setAttribute("aria-hidden", "true");
    const points = [[0, 0], [100, 0], [0, 100], [100, 100]].map(([x, y]) => {
      const point = createSpan();
      point.style.cssText = `position:absolute;inset:0 auto auto 0;inline-size:0;block-size:0;transform:translate(${x}px,${y}px)`;
      root.append(point);
      return point;
    });
    return { root, points, style: "\u0000" };
  })();
  if (value.style !== style) {
    value.style = style;
    value.root.style.cssText = `position:absolute;inset:0 auto auto 0;inline-size:1px;block-size:1px;contain:strict;overflow:clip;visibility:hidden;pointer-events:none;padding:0;margin:0;border:0;${style}`;
  }
  if (value.root.parentElement !== host) host.append(value.root);
  return value;
}

export function clearCoordinateProbes() {
  document.querySelectorAll(".oni-coordinate-probe").forEach(el => el.remove());
}

function matrix(value: Probe): DOMMatrix | null {
  const [o, x, y, xy] = value.points.map(point => point.getBoundingClientRect());
  if (Math.abs(xy.x - x.x - y.x + o.x) > 0.05 || Math.abs(xy.y - x.y - y.y + o.y) > 0.05) return null;
  const m = new DOMMatrix([(x.x - o.x) / 100, (x.y - o.y) / 100, (y.x - o.x) / 100, (y.y - o.y) / 100, o.x, o.y]);
  return Math.abs(m.a * m.d - m.b * m.c) > 1e-9 ? m : null;
}

/** Intrinsic image pixels to viewport CSS pixels, plus the same mapping in the SVG host's local axes. */
export function imageCoordinates(img: HTMLImageElement, host: HTMLElement) {
  if (getComputedStyle(host).position === "static") host.addClass("oni-ink-host");
  const hp = probe(host, hosts.get(host), "");
  hosts.set(host, hp);
  const cs = getComputedStyle(img);
  const ip = probe(host, images.get(img), `transform:${cs.transform};transform-origin:${cs.transformOrigin};rotate:${cs.rotate};scale:${cs.scale};translate:${cs.translate};zoom:${cs.zoom}`);
  images.set(img, ip);
  const hm = matrix(hp), im = matrix(ip);
  if (!hm || !im) return null;
  const px = (value: string) => parseFloat(value) || 0;
  const bx = px(cs.borderLeftWidth) + px(cs.paddingLeft), by = px(cs.borderTopWidth) + px(cs.paddingTop);
  const ex = px(cs.borderRightWidth) + px(cs.paddingRight), ey = px(cs.borderBottomWidth) + px(cs.paddingBottom);
  const width = px(cs.width) + (cs.boxSizing === "border-box" ? 0 : bx + ex);
  const height = px(cs.height) + (cs.boxSizing === "border-box" ? 0 : by + ey);
  const rect = img.getBoundingClientRect();
  const xs = [0, im.a * width, im.c * height, im.a * width + im.c * height];
  const ys = [0, im.b * width, im.d * height, im.b * width + im.d * height];
  const visual = new DOMMatrix([im.a, im.b, im.c, im.d, rect.left - Math.min(...xs), rect.top - Math.min(...ys)])
    .translate(bx, by).scale((width - bx - ex) / img.naturalWidth, (height - by - ey) / img.naturalHeight);
  return { visual, local: hm.inverse().multiply(visual) };
}

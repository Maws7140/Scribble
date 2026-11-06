import { App, Modal, Notice, Setting, TFile, normalizePath, setIcon } from "obsidian";
import * as fs from "fs";
import { ImportCard } from "./onenotecanvas";
import { SyncBlock } from "./onenote";

/** A notebook, section group, section or page (see helper/OneNoteVaultImport.cs). */
export interface OneNoteNode {
  kind: "notebook" | "group" | "section" | "page";
  id: string;
  name: string;
  modified?: string;
  level?: number;
  locked?: boolean;
  children?: OneNoteNode[];
}

/** What a page would make best, and why. */
export interface PageKind {
  id: string;
  kind: "note" | "canvas" | "empty";
  reason: string;
  error?: string;
}

/** A page read for a note: its parts top to bottom, and how much ink it has. */
export interface NoteRead {
  title: string;
  cards: (ImportCard & { objectId?: string; hash?: string; pageY?: number })[];
  inkStrokes: number;
  inkSig: string;
  lastModified: string;
}

/** The helper's answer to "onenote-read-note". */
export interface NoteReadMessage extends Partial<NoteRead> {
  ok?: boolean;
  error?: string;
  tempDir?: string;
}

export type ImportAs = "note" | "canvas";

/** One page to bring in: where, and as what. */
export interface PlannedPage {
  id: string;
  title: string;
  folder: string;
  as: ImportAs;
}

/** What the dialog needs from the plugin. */
export interface ImportHost {
  /** Note or canvas, for each page. */
  classify(ids: string[]): Promise<PageKind[]>;
  /** The vault file a page was imported to before, if it still exists. */
  importedAs(pageId: string): string | null;
  /** Bring one page in; resolves to the new file's path. */
  importPage(page: PlannedPage): Promise<string>;
}

interface Row {
  node: OneNoteNode;
  parent: Row | null;
  children: Row[];
  /** The pages at or under this row. */
  pages: Row[];
  el?: HTMLElement;
  childrenEl?: HTMLElement;
  check?: HTMLInputElement;
  countEl?: HTMLElement;
  open: boolean;
  // Pages only:
  selected: boolean;
  kind?: PageKind;
  as: ImportAs;
  /** Chosen by hand: a suggestion arriving later doesn't change it. */
  chosen: boolean;
  imported: string | null;
  asEl?: HTMLSelectElement;
  reasonEl?: HTMLElement;
}

/** A name for a folder or file: what a vault path can't hold goes. */
export function safeName(name: string, fallback: string) {
  return name.replace(/[\\/:*?"<>|#^[\]]/g, " ").replace(/\s+/g, " ").replace(/^\.+/, "").trim().slice(0, 100) || fallback;
}

/** A path for this name in this folder that isn't taken. */
export function freePath(app: App, folder: string, name: string, ext: string) {
  const base = normalizePath(`${folder}/${name}`);
  let candidate = `${base}.${ext}`;
  for (let n = 2; app.vault.getAbstractFileByPath(candidate); n++) candidate = `${base} ${n}.${ext}`;
  return candidate;
}

/** Make the folder and any missing folders above it. */
export async function ensureFolder(app: App, folder: string) {
  let at = "";
  for (const part of normalizePath(folder).split("/").filter((p) => p.length > 0)) {
    at = at ? `${at}/${part}` : part;
    if (!app.vault.getAbstractFileByPath(at)) await app.vault.createFolder(at);
  }
}

/**
 * Write a page as a note: its text boxes as Markdown, top to bottom, with its pictures embedded and its files
 * linked where they were. Returns the note and its text blocks, for keeping it in sync with the page.
 */
export async function writeImportedNote(app: App, notePath: string, page: NoteRead): Promise<{ file: TFile; blocks: SyncBlock[] }> {
  const parts: string[] = [];
  const blocks: SyncBlock[] = [];
  let line = 0;
  let pictures = 0;
  const add = (text: string) => {
    if (parts.length > 0) line += 2; // the blank line between parts
    const start = line;
    parts.push(text);
    line += text.split("\n").length - 1;
    return { start, end: line };
  };
  for (const card of page.cards) {
    if (card.kind === "text") {
      const text = (card.markdown ?? "").replace(/\s+$/, "");
      if (!text) continue;
      const at = add(text);
      if (card.objectId) blocks.push({ objectId: card.objectId, hash: card.hash ?? "", text, start: at.start, end: at.end, y: card.pageY ?? 0 });
      continue;
    }
    if (!card.file) {
      if (card.markdown) add(card.markdown);
      continue;
    }
    const ext = card.file.slice(card.file.lastIndexOf("."));
    const name = card.kind === "image" ? `${safeName(page.title, "OneNote page")} ${++pictures}${ext}` : card.name ?? `attachment${ext}`;
    const target = await app.fileManager.getAvailablePathForAttachment(name, notePath);
    const bytes = fs.readFileSync(card.file);
    const saved = await app.vault.createBinary(target, bytes.buffer.slice(bytes.byteOffset, bytes.byteOffset + bytes.byteLength));
    const link = app.fileManager.generateMarkdownLink(saved, notePath);
    add(card.kind === "image" ? (link.startsWith("!") ? link : "!" + link) : link);
  }
  const file = await app.vault.create(notePath, parts.join("\n\n") + (parts.length ? "\n" : ""));
  return { file, blocks };
}

const BATCH = 20;

/**
 * "Import from OneNote": choose notebooks, sections or single pages, and whether each becomes a note or a canvas.
 * Each page gets a suggestion from what's on it (one column of text: a note; a layout across the page: a canvas),
 * which can be changed page by page or for all at once.
 */
export class OneNoteImportModal extends Modal {
  private rows: Row[] = [];
  private pages: Row[] = [];
  private byId = new Map<string, Row>();
  private folder = "OneNote";
  private filter = "";
  private queue: string[] = [];
  private classifying = false;
  private closed = false;
  private importing = false;
  private stopped = false;
  private treeEl!: HTMLElement;
  private statusEl!: HTMLElement;
  private summaryEl!: HTMLElement;
  private importButton!: HTMLButtonElement;

  constructor(app: App, private host: ImportHost, notebooks: OneNoteNode[], folder: string) {
    super(app);
    this.folder = folder;
    const build = (node: OneNoteNode, parent: Row | null): Row => {
      const row: Row = { node, parent, children: [], pages: [], open: node.kind === "notebook", selected: false, as: "note", chosen: false, imported: null };
      if (node.kind === "page") {
        row.pages = [row];
        row.imported = host.importedAs(node.id);
        this.pages.push(row);
        this.byId.set(node.id, row);
      } else {
        row.children = (node.children ?? []).map((c) => build(c, row));
        row.pages = row.children.flatMap((c) => c.pages);
      }
      return row;
    };
    this.rows = notebooks.map((n) => build(n, null));
    // Locked sections can't be read; pages already in the vault aren't brought in twice.
    this.queue = this.pages.filter((p) => !p.imported && !this.lockedRow(p)).map((p) => p.node.id);
  }

  onOpen() {
    this.modalEl.addClass("oni-import");
    this.titleEl.setText("Import from OneNote");
    const { contentEl } = this;
    new Setting(contentEl)
      .setName("Folder")
      .setDesc("Notebooks, section groups and sections become folders inside it.")
      .addText((t) => t.setValue(this.folder).setPlaceholder("OneNote").onChange((v) => { this.folder = v.trim(); }));
    new Setting(contentEl)
      .setName("Note or canvas")
      .setDesc("Each page is suggested one from what's on it: one column of text makes a note, a page laid out across (side-by-side boxes, handwriting, drawings, printouts) a canvas. Change any page below, or all at once here.")
      .addButton((b) => b.setButtonText("As suggested").onClick(() => this.setAll(null)))
      .addButton((b) => b.setButtonText("All notes").onClick(() => this.setAll("note")))
      .addButton((b) => b.setButtonText("All canvases").onClick(() => this.setAll("canvas")));

    const bar = contentEl.createDiv({ cls: "oni-import-bar" });
    const search = bar.createEl("input", { type: "search", cls: "oni-import-filter", attr: { placeholder: "Filter pages" } });
    search.addEventListener("input", () => {
      this.filter = search.value.trim().toLowerCase();
      this.applyFilter();
    });
    const all = bar.createEl("button", { text: "Select all" });
    all.addEventListener("click", () => this.selectRows(this.rows, true));
    const none = bar.createEl("button", { text: "Select none" });
    none.addEventListener("click", () => this.selectRows(this.rows, false));
    this.statusEl = bar.createSpan({ cls: "oni-import-status" });

    this.treeEl = contentEl.createDiv({ cls: "oni-import-tree" });
    if (this.rows.length === 0) this.treeEl.createDiv({ cls: "oni-import-empty", text: "No notebooks are open in OneNote." });
    for (const row of this.rows) this.renderRow(row, this.treeEl);

    const footer = contentEl.createDiv({ cls: "oni-import-footer" });
    this.summaryEl = footer.createSpan({ cls: "oni-import-summary" });
    this.importButton = footer.createEl("button", { text: "Import", cls: "mod-cta" });
    this.importButton.addEventListener("click", () => void this.run());
    this.updateSummary();
    void this.classifyLoop();
  }

  onClose() {
    this.closed = true;
    this.stopped = true;
    this.contentEl.empty();
  }

  private lockedRow(row: Row) {
    for (let r: Row | null = row; r; r = r.parent) if (r.node.locked) return true;
    return false;
  }

  private selectable(row: Row) {
    return !row.imported && !this.lockedRow(row);
  }

  private renderRow(row: Row, parent: HTMLElement) {
    const el = parent.createDiv({ cls: `oni-import-row oni-import-${row.node.kind}` });
    row.el = el;
    const line = el.createDiv({ cls: "oni-import-line" });
    if (row.node.kind === "page") line.setCssProps({ "--oni-import-level": String(Math.max(0, (row.node.level ?? 1) - 1)) });
    const twisty = line.createSpan({ cls: "oni-import-twisty" });
    if (row.node.kind !== "page" && row.children.length > 0) {
      setIcon(twisty, row.open ? "chevron-down" : "chevron-right");
      twisty.addEventListener("click", () => this.toggleOpen(row, twisty));
    }
    const check = line.createEl("input", { type: "checkbox" });
    row.check = check;
    check.disabled = row.node.kind === "page" ? !this.selectable(row) : row.pages.every((p) => !this.selectable(p));
    check.addEventListener("change", () => this.selectRows([row], check.checked));
    const icon = line.createSpan({ cls: "oni-import-icon" });
    setIcon(icon, { notebook: "book", group: "folders", section: "folder", page: row.as === "canvas" ? "layout-dashboard" : "file-text" }[row.node.kind]);
    const name = line.createSpan({ cls: "oni-import-name", text: row.node.name || "Untitled" });
    if (row.node.kind !== "page") {
      name.addEventListener("click", () => this.toggleOpen(row, twisty));
      row.countEl = line.createSpan({ cls: "oni-import-count" });
      if (row.node.locked) row.countEl.setText("Locked: unlock it in OneNote to import it");
    } else {
      row.reasonEl = line.createSpan({ cls: "oni-import-reason" });
      if (row.imported) {
        line.createSpan({ cls: "oni-import-done", text: "In the vault" }).setAttribute("aria-label", row.imported);
      } else if (!this.lockedRow(row)) {
        const select = line.createEl("select", { cls: "dropdown oni-import-as" });
        select.createEl("option", { value: "note", text: "Note" });
        select.createEl("option", { value: "canvas", text: "Canvas" });
        select.value = row.as;
        select.addEventListener("change", () => {
          row.as = select.value as ImportAs;
          row.chosen = true;
          this.showKind(row);
          this.updateSummary();
        });
        row.asEl = select;
      }
      this.showKind(row);
    }
    if (row.node.kind !== "page") {
      row.childrenEl = el.createDiv({ cls: "oni-import-children" });
      if (row.open) for (const c of row.children) this.renderRow(c, row.childrenEl);
      else row.childrenEl.hide();
    }
    this.refresh(row);
  }

  private toggleOpen(row: Row, twisty: HTMLElement) {
    if (!row.childrenEl) return;
    row.open = !row.open;
    setIcon(twisty, row.open ? "chevron-down" : "chevron-right");
    if (row.open && row.childrenEl.childElementCount === 0) for (const c of row.children) this.renderRow(c, row.childrenEl);
    row.childrenEl.toggle(row.open);
    // Opened: its pages are what's being looked at, so they're checked first.
    if (row.open) this.bump(row.pages);
  }

  /** Render everything (for the filter), once. */
  private renderAll(rows: Row[]) {
    for (const row of rows) {
      if (row.childrenEl && row.childrenEl.childElementCount === 0) for (const c of row.children) this.renderRow(c, row.childrenEl);
      this.renderAll(row.children);
    }
  }

  private applyFilter() {
    if (this.filter) this.renderAll(this.rows);
    const visit = (row: Row): boolean => {
      if (row.node.kind === "page") {
        const show = !this.filter || row.node.name.toLowerCase().includes(this.filter);
        row.el?.toggle(show);
        return show;
      }
      let any = false;
      for (const c of row.children) any = visit(c) || any;
      const show = !this.filter || any;
      row.el?.toggle(show);
      if (this.filter && row.childrenEl) row.childrenEl.toggle(any);
      else if (row.childrenEl) row.childrenEl.toggle(row.open);
      return show;
    };
    for (const row of this.rows) visit(row);
  }

  private selectRows(rows: Row[], on: boolean) {
    const touched = new Set<Row>();
    for (const row of rows) {
      for (const p of row.pages) {
        if (!this.selectable(p)) continue;
        // Selecting a whole notebook or section leaves out its empty pages; ticking one page takes it anyway.
        if (on && row.node.kind !== "page" && p.kind?.kind === "empty") continue;
        if (this.filter && row.node.kind !== "page" && !p.node.name.toLowerCase().includes(this.filter)) continue;
        p.selected = on;
        touched.add(p);
      }
    }
    for (const p of touched) for (let r: Row | null = p; r; r = r.parent) this.refresh(r);
    if (on) this.bump([...touched]);
    this.updateSummary();
  }

  /** A row's checkbox and count, from its pages. */
  private refresh(row: Row) {
    const pages = row.pages.filter((p) => this.selectable(p));
    const chosen = pages.filter((p) => p.selected).length;
    if (row.check) {
      row.check.checked = pages.length > 0 && chosen === pages.length;
      row.check.indeterminate = chosen > 0 && chosen < pages.length;
    }
    if (row.countEl && !row.node.locked) {
      const total = row.pages.length;
      row.countEl.setText(`${total} page${total === 1 ? "" : "s"}${chosen ? `, ${chosen} selected` : ""}`);
    }
  }

  private showKind(row: Row) {
    if (!row.reasonEl || !row.el) return;
    const k = row.kind;
    const suggested = k ? (k.kind === "canvas" ? "canvas" : "note") : null;
    row.reasonEl.setText(!k ? "" : k.kind === "empty" ? "Empty page" : row.chosen && row.as !== suggested ? `${k.reason} (suggested: ${suggested})` : k.reason);
    row.reasonEl.toggleClass("mod-warning", !!k?.error);
    const icon = row.el.querySelector(".oni-import-icon");
    if (icon?.instanceOf(HTMLElement)) setIcon(icon, row.as === "canvas" ? "layout-dashboard" : "file-text");
  }

  private setAll(as: ImportAs | null) {
    for (const p of this.pages) {
      if (!this.selectable(p)) continue;
      if (as) {
        p.as = as;
        p.chosen = true;
      } else {
        p.chosen = false;
        if (p.kind) p.as = p.kind.kind === "canvas" ? "canvas" : "note";
      }
      if (p.asEl) p.asEl.value = p.as;
      this.showKind(p);
    }
    this.updateSummary();
  }

  /** Check these pages next. */
  private bump(rows: Row[]) {
    const ids = rows.filter((r) => !r.kind && this.selectable(r)).map((r) => r.node.id);
    if (ids.length === 0) return;
    const wanted = new Set(ids);
    this.queue = [...ids.filter((id) => this.queue.includes(id)), ...this.queue.filter((id) => !wanted.has(id))];
  }

  private apply(results: PageKind[]) {
    for (const k of results) {
      const row = this.byId.get(k.id);
      if (!row) continue;
      row.kind = k;
      if (!row.chosen) {
        row.as = k.kind === "canvas" ? "canvas" : "note";
        if (row.asEl) row.asEl.value = row.as;
      }
      this.showKind(row);
    }
    this.updateSummary();
  }

  /** Suggest note or canvas for every page, a few at a time, while the dialog is open. */
  private async classifyLoop() {
    if (this.classifying) return;
    this.classifying = true;
    const total = this.queue.length;
    try {
      while (!this.closed && this.queue.length > 0) {
        const batch = this.queue.splice(0, BATCH);
        this.statusEl.setText(`Looking at the pages... ${total - this.queue.length - batch.length} of ${total}`);
        this.apply(await this.host.classify(batch));
      }
    } finally {
      this.classifying = false;
      if (!this.closed) this.statusEl.setText("");
    }
  }

  private selected() {
    return this.pages.filter((p) => p.selected && this.selectable(p));
  }

  private updateSummary() {
    if (this.importing) return;
    const chosen = this.selected();
    const canvases = chosen.filter((p) => p.as === "canvas").length;
    const notes = chosen.length - canvases;
    this.summaryEl.setText(chosen.length === 0 ? "Select the notebooks, sections or pages to import."
      : `${chosen.length} page${chosen.length === 1 ? "" : "s"}: ${notes} note${notes === 1 ? "" : "s"}, ${canvases} canvas${canvases === 1 ? "" : "es"}`);
    this.importButton.disabled = chosen.length === 0;
  }

  /** The folder for a page: notebook, section groups and section, under the chosen folder. */
  private folderFor(row: Row) {
    const names: string[] = [];
    for (let r = row.parent; r; r = r.parent) names.unshift(safeName(r.node.name, "Untitled"));
    return normalizePath([this.folder || "OneNote", ...names].join("/"));
  }

  private async run() {
    const chosen = this.selected();
    if (chosen.length === 0 || this.importing) return;
    this.importing = true;
    this.stopped = false;
    this.importButton.setText("Stop");
    this.importButton.removeClass("mod-cta");
    this.importButton.onclick = () => { this.stopped = true; };
    const done: { row: Row; path: string }[] = [];
    const failed: { row: Row; error: string }[] = [];
    for (let i = 0; i < chosen.length && !this.stopped; i++) {
      const row = chosen[i];
      this.summaryEl.setText(`Importing ${i + 1} of ${chosen.length}: ${row.node.name || "Untitled"}`);
      try {
        // A page not looked at yet, left as suggested: look now, so it becomes what suits it.
        if (!row.kind && !row.chosen) this.apply(await this.host.classify([row.node.id]));
        const path = await this.host.importPage({ id: row.node.id, title: row.node.name, folder: this.folderFor(row), as: row.as });
        done.push({ row, path });
        row.imported = path;
        row.selected = false;
      } catch (e) {
        failed.push({ row, error: e instanceof Error ? e.message : String(e) });
      }
    }
    this.importing = false;
    if (this.closed) {
      new Notice(`Imported ${done.length} of ${chosen.length} OneNote pages${failed.length ? `; ${failed.length} failed` : ""}.`);
      return;
    }
    this.showResult(done, failed, chosen.length);
  }

  private showResult(done: { row: Row; path: string }[], failed: { row: Row; error: string }[], wanted: number) {
    const { contentEl } = this;
    contentEl.empty();
    const notes = done.filter((d) => d.path.endsWith(".md")).length;
    const canvases = done.length - notes;
    contentEl.createEl("p", {
      text: `Imported ${done.length} page${done.length === 1 ? "" : "s"} into ${this.folder || "OneNote"}: ${notes} note${notes === 1 ? "" : "s"}, ${canvases} canvas${canvases === 1 ? "" : "es"}.`
        + (done.length + failed.length < wanted ? ` Stopped before the other ${wanted - done.length - failed.length}.` : ""),
    });
    if (done.length > 0) contentEl.createEl("p", { cls: "setting-item-description", text: "They stay linked to their OneNote pages: send or pull changes as with any synced note or canvas. Ink on a note is placed when you first open it." });
    if (failed.length > 0) {
      contentEl.createEl("p", { text: `${failed.length} couldn't be imported:` });
      const list = contentEl.createEl("ul", { cls: "oni-import-failed" });
      for (const f of failed) list.createEl("li", { text: `${f.row.node.name || "Untitled"}: ${f.error}` });
    }
    const footer = contentEl.createDiv({ cls: "oni-import-footer" });
    if (done.length > 0) {
      const open = footer.createEl("button", { text: "Open the first one" });
      open.addEventListener("click", () => {
        const file = this.app.vault.getFileByPath(done[0].path);
        if (file) void this.app.workspace.getLeaf("tab").openFile(file);
        this.close();
      });
    }
    const close = footer.createEl("button", { text: "Close", cls: "mod-cta" });
    close.addEventListener("click", () => this.close());
  }
}

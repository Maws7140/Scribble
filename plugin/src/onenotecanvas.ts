import { App, FuzzySuggestModal, TFile, normalizePath } from "obsidian";
import * as fs from "fs";

/** A OneNote page to choose from (see helper/OneNoteImport.cs). */
export interface OneNotePage {
  id: string;
  title: string;
  where: string;
  modified: string;
}

/** One object from the page, in canvas px. Pictures and files come as temporary copies for us to take. */
export interface ImportCard {
  kind: "text" | "image" | "file";
  x: number;
  y: number;
  w: number;
  h: number;
  markdown?: string;
  file?: string;
  name?: string;
}

export class PagePicker extends FuzzySuggestModal<OneNotePage> {
  constructor(app: App, private pages: OneNotePage[], private choose: (page: OneNotePage) => void) {
    super(app);
    this.setPlaceholder("Open a OneNote page as a canvas...");
  }

  getItems() {
    return this.pages;
  }

  getItemText(page: OneNotePage) {
    return `${page.title || "Untitled page"}  (${page.where})`;
  }

  onChooseItem(page: OneNotePage) {
    this.choose(page);
  }
}

/** A title as a file name: what a vault path can't hold goes. */
export function canvasName(title: string) {
  return title.replace(/[\\/:*?"<>|#^[\]]/g, " ").replace(/\s+/g, " ").trim().slice(0, 100) || "OneNote page";
}

/** A canvas path for this title in this folder that isn't taken. */
export function freeCanvasPath(app: App, folder: string, title: string) {
  const base = normalizePath(`${folder}/${canvasName(title)}`);
  let candidate = `${base}.canvas`;
  for (let n = 2; app.vault.getAbstractFileByPath(candidate); n++) candidate = `${base} ${n}.canvas`;
  return candidate;
}

const cardId = () => Array.from(crypto.getRandomValues(new Uint8Array(8)), (b) => b.toString(16).padStart(2, "0")).join("");

/** Put the page's pictures and files in the vault (where it keeps attachments) and write the canvas. */
export async function writeCanvas(app: App, canvasPath: string, title: string, cards: ImportCard[]): Promise<TFile> {
  const nodes: object[] = [];
  let pictures = 0;
  for (const card of cards) {
    const place = { x: Math.round(card.x), y: Math.round(card.y), width: Math.round(card.w), height: Math.round(card.h) };
    if (card.file) {
      const name = card.kind === "image" ? `${canvasName(title)} ${++pictures}${card.file.slice(card.file.lastIndexOf("."))}` : card.name ?? "attachment";
      const target = await app.fileManager.getAvailablePathForAttachment(name, canvasPath);
      const bytes = fs.readFileSync(card.file);
      const saved = await app.vault.createBinary(target, bytes.buffer.slice(bytes.byteOffset, bytes.byteOffset + bytes.byteLength) as ArrayBuffer);
      // A picture is on the page; an attached file is only a link to it, as in OneNote.
      if (card.kind === "image") nodes.push({ id: cardId(), type: "file", file: saved.path, ...place });
      else nodes.push({ id: cardId(), type: "text", text: `[[${saved.path}|${card.name ?? saved.name}]]`, ...place });
    } else {
      nodes.push({ id: cardId(), type: "text", text: card.markdown ?? "", ...place });
    }
  }
  return app.vault.create(canvasPath, JSON.stringify({ nodes, edges: [] }, null, "\t"));
}

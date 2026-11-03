import { App, FileView, TFile } from "obsidian";
import * as path from "path";
import { ExportBlock, mathFor } from "./onenote";
import { ImportCard, cardNode } from "./onenotecanvas";

/** A card as the canvas file has it. */
interface FileNode {
  id: string;
  type: string;
  x: number;
  y: number;
  width: number;
  height: number;
  text?: string;
  file?: string;
  url?: string;
}

interface CanvasFile {
  nodes: FileNode[];
  edges: unknown[];
}

/** A card as the helper wants it (see helper/OneNoteCanvasSync.cs). */
export interface SyncNode {
  id: string;
  kind: "text" | "image" | "file";
  x: number;
  y: number;
  w: number;
  h: number;
  text: string;
  blocks: ExportBlock[];
  file?: string;
  name?: string;
}

/** A card to change, add or remove after a pull. */
export interface CardChange {
  op: "update" | "new" | "delete";
  nodeId: string;
  oldText?: string | null;
  markdown?: string | null;
  x?: number | null;
  y?: number | null;
  w?: number | null;
  h?: number | null;
  card?: ImportCard | null;
}

// Obsidian's Canvas (internal; only to read and change an open canvas's cards, which its file may be behind).
interface OpenCanvas {
  getData(): CanvasFile;
  setData(data: CanvasFile): void;
  requestSave(): void;
}

function openCanvas(app: App, canvasPath: string): OpenCanvas | null {
  for (const leaf of app.workspace.getLeavesOfType("canvas")) {
    const view = leaf.view as FileView & { canvas?: OpenCanvas };
    if (view.file?.path === canvasPath && view.canvas) return view.canvas;
  }
  return null;
}

async function readCanvas(app: App, file: TFile): Promise<CanvasFile> {
  const open = openCanvas(app, file.path);
  if (open) return open.getData();
  const data = JSON.parse((await app.vault.read(file)) || "{}") as Partial<CanvasFile>;
  return { nodes: data.nodes ?? [], edges: data.edges ?? [] };
}

const IMAGE = /\.(png|jpe?g|gif|bmp|webp|svg|avif)$/i;

/** A card's Markdown as blocks, for the helper to turn into OneNote paragraphs. */
export function markdownBlocks(text: string): ExportBlock[] {
  const lines = text.replace(/\r/g, "").split("\n");
  const blocks: ExportBlock[] = [];
  const add = (kind: string, from: number, to: number) => {
    const body = lines.slice(from, to + 1).join("\n");
    blocks.push({ kind, text: body, y: 0, start: from, end: to, math: body.includes("$") ? mathFor(body) : undefined });
  };
  const isList = (l: string) => /^\s*([-*+]|\d+[.)])\s/.test(l);
  for (let i = 0; i < lines.length;) {
    const line = lines[i];
    if (!line.trim()) { i++; continue; }
    const start = i;
    if (/^\s*```/.test(line)) {
      for (i++; i < lines.length && !/^\s*```/.test(lines[i]); i++);
      add("code", start, Math.min(i, lines.length - 1));
      i++;
    } else if (/^\s*\$\$/.test(line) && !/\$\$.*\$\$/.test(line)) {
      for (i++; i < lines.length && !/\$\$\s*$/.test(lines[i]); i++);
      add("math", start, Math.min(i, lines.length - 1));
      i++;
    } else if (/^#{1,6}\s/.test(line)) {
      add("heading", i, i);
      i++;
    } else if (/^\s*(?:(?:-\s*){3,}|(?:\*\s*){3,}|(?:_\s*){3,})$/.test(line)) {
      add("thematicBreak", i, i);
      i++;
    } else if (isList(line)) {
      for (i++; i < lines.length && lines[i].trim() && (isList(lines[i]) || /^\s/.test(lines[i])); i++);
      add("list", start, i - 1);
    } else if (/^\s*>/.test(line)) {
      for (i++; i < lines.length && /^\s*>/.test(lines[i]); i++);
      add(/^\s*>\s*\[!/.test(line) ? "callout" : "blockquote", start, i - 1);
    } else {
      for (i++; i < lines.length && lines[i].trim() && !/^(#{1,6}\s|\s*```|\s*>)/.test(lines[i]) && !isList(lines[i]); i++);
      add("paragraph", start, i - 1);
    }
  }
  return blocks;
}

/**
 * The cards to keep on the page. Groups and arrows have nothing on a page to be, so they stay on the canvas;
 * a web link goes over as text.
 */
export async function canvasNodes(app: App, file: TFile, base: string): Promise<SyncNode[]> {
  const data = await readCanvas(app, file);
  const nodes: SyncNode[] = [];
  for (const n of data.nodes) {
    const place = { id: n.id, x: n.x, y: n.y, w: n.width, h: n.height };
    if (n.type === "text" || n.type === "link") {
      const text = n.type === "text" ? n.text ?? "" : `[${n.url}](${n.url})`;
      nodes.push({ ...place, kind: "text", text, blocks: markdownBlocks(text) });
    } else if (n.type === "file" && n.file) {
      nodes.push({ ...place, kind: IMAGE.test(n.file) ? "image" : "file", text: "", blocks: [], file: path.join(base, n.file), name: n.file.split("/").pop() });
    }
  }
  return nodes;
}

/** Put a pull's changes on the canvas: in the open canvas if it's open, so they show at once and its next save keeps them. */
export async function applyCardChanges(app: App, file: TFile, changes: CardChange[]) {
  if (changes.length === 0) return;
  const data = await readCanvas(app, file);
  const byId = new Map(data.nodes.map((n) => [n.id, n]));
  let pictures = data.nodes.filter((n) => n.type === "file").length;
  for (const change of changes) {
    const node = byId.get(change.nodeId);
    if (change.op === "delete") {
      if (node) {
        data.nodes = data.nodes.filter((n) => n !== node);
        byId.delete(change.nodeId);
      }
    } else if (change.op === "new" && change.card) {
      const made = await cardNode(app, file.path, file.basename, change.card, ++pictures) as FileNode;
      data.nodes.push(made);
      byId.set(made.id, made);
    } else if (node) {
      if (change.markdown != null) node.text = change.markdown;
      if (change.x != null) node.x = Math.round(change.x);
      if (change.y != null) node.y = Math.round(change.y);
      if (change.w != null) node.width = Math.round(change.w);
      if (change.h != null) node.height = Math.round(change.h);
    }
  }
  const open = openCanvas(app, file.path);
  if (open) {
    open.setData(data);
    open.requestSave();
  } else {
    await app.vault.modify(file, JSON.stringify(data, null, "\t"));
  }
}

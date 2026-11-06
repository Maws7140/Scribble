import { App, Modal, Setting } from "obsidian";
import * as fs from "fs";
import * as path from "path";

/** What the plugin and the helper say to each other changed in a way the other must know: raise it on both sides. */
export const HELPER_PROTOCOL = 1;

/**
 * Where people get the helper's installer. The plugin never downloads or installs it itself: Obsidian's
 * policies don't let a plugin install its own dependencies.
 */
export const HELPER_DOWNLOAD = "https://github.com/Maws7140/Onesidian/releases/latest";

/** "updating": its installer (or uninstaller) is replacing it right now; it starts again once that's done. */
export type HelperProblem = "missing" | "outdated" | "not-windows" | "updating";

/** Where the installer puts the helper: per user, so it needs no admin prompt. */
export function installedHelperDir(): string | null {
  const local = process.env.LOCALAPPDATA;
  return local ? path.join(local, "Programs", "Onesidian") : null;
}

/**
 * The installer and uninstaller put this file in the helper's folder while they work (installer/Onesidian.iss):
 * the plugin stops its helper so the files can be replaced, and doesn't start one until the file's gone. One
 * left behind by an installer that was killed is ignored after a while, so it can't keep the helper off.
 */
export function helperBeingUpdated(): boolean {
  const dir = installedHelperDir();
  if (!dir) return false;
  try {
    return Date.now() - fs.statSync(path.join(dir, ".updating")).mtimeMs < 10 * 60_000;
  } catch {
    return false;
  }
}

/** Whether this helper is the installed one (not a development build in the plugin's folder). */
export function isInstalledHelper(exe: string): boolean {
  const dir = installedHelperDir();
  return !!dir && path.resolve(path.dirname(exe)).toLowerCase() === path.resolve(dir).toLowerCase();
}

/** The helper to run: the installed one, else one in the plugin's own folder (a development build). */
export function findHelper(pluginDir: string | null): string | null {
  for (const dir of [installedHelperDir(), pluginDir && path.join(pluginDir, "helper")]) {
    const exe = dir ? path.join(dir, "InkOverlay.exe") : null;
    if (exe && fs.existsSync(exe)) return exe;
  }
  return null;
}

type CardProblem = Exclude<HelperProblem, "not-windows" | "updating">;

const TEXT: Record<CardProblem, { title: string; body: string }> = {
  missing: {
    title: "Install the ink helper",
    body: "Onesidian draws with the ink helper, a small Windows program that's installed separately. "
      + "Download its installer, run it, and the plugin picks it up within a few seconds. It installs for you "
      + "alone, without an admin prompt.",
  },
  outdated: {
    title: "Update the ink helper",
    body: "The ink helper on this computer doesn't match this version of the plugin, so it isn't being used. "
      + "Download the helper for this version and run its installer; the plugin picks it up within a few seconds.",
  },
};

/** The helper isn't there, or doesn't match: what to do about it. */
export class HelperSetupModal extends Modal {
  constructor(app: App, private problem: CardProblem) {
    super(app);
  }

  onOpen() {
    const text = TEXT[this.problem];
    this.titleEl.setText(text.title);
    this.contentEl.createEl("p", { text: text.body });
    new Setting(this.contentEl)
      .addButton((b) => b.setButtonText("Download the helper").setCta().onClick(() => {
        window.open(HELPER_DOWNLOAD);
        this.close();
      }))
      .addButton((b) => b.setButtonText("Not now").onClick(() => this.close()));
  }

  onClose() {
    this.contentEl.empty();
  }
}

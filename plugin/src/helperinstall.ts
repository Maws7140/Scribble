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

export type HelperProblem = "missing" | "outdated" | "not-windows";

/** Where the installer puts the helper: per user, so it needs no admin prompt. */
export function installedHelperDir(): string | null {
  const local = process.env.LOCALAPPDATA;
  return local ? path.join(local, "Programs", "OneNote Ink") : null;
}

/** The helper to run: the installed one, else one in the plugin's own folder (a development build). */
export function findHelper(pluginDir: string | null): string | null {
  for (const dir of [installedHelperDir(), pluginDir && path.join(pluginDir, "helper")]) {
    const exe = dir ? path.join(dir, "InkOverlay.exe") : null;
    if (exe && fs.existsSync(exe)) return exe;
  }
  return null;
}

/**
 * Before the helper had an installer it lived in the plugin's folder, and so did its backups of ink that pulls
 * from OneNote replaced. Copy any it doesn't have yet to where it runs from now (the old ones are left as they are).
 */
export function copyOldBackups(pluginDir: string | null, exe: string) {
  if (!pluginDir) return;
  const from = path.join(pluginDir, "helper", "backups");
  const to = path.join(path.dirname(exe), "backups");
  if (path.resolve(from) === path.resolve(to) || !fs.existsSync(from)) return;
  try {
    fs.mkdirSync(to, { recursive: true });
    for (const name of fs.readdirSync(from)) {
      const target = path.join(to, name);
      if (!fs.existsSync(target)) fs.copyFileSync(path.join(from, name), target);
    }
  } catch (e) {
    console.error("[onenote-ink] copying old ink backups:", e);
  }
}

const TEXT: Record<Exclude<HelperProblem, "not-windows">, { title: string; body: string }> = {
  missing: {
    title: "Install the ink helper",
    body: "OneNote Ink draws with the ink helper, a small Windows program that's installed separately. "
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
  constructor(app: App, private problem: Exclude<HelperProblem, "not-windows">) {
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

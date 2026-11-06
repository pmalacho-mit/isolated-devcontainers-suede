/**
 * appearance.ts -- the outer editor's colour theme, handed to the editors it
 * starts (#59).
 *
 * Each target is its own host, so a browser has never seen any of them: its
 * editor opens with the defaults -- light, whatever the person uses. The theme
 * is not a file anywhere on the server (a web editor keeps a person's settings
 * in the browser), so the only party that can say it is the outer editor's
 * extension, which reads it as a setting. It keeps it here, in the editor's
 * cache; `desolate` reads it back and sends it with a start; the broker passes
 * it on as a flag (args.ts), and editor.ts writes it into the new editor's
 * settings.
 *
 * Every step holds it to editor.ts readAppearance -- a closed list of theme
 * settings, typed -- so a file anyone with the editor's home could write is
 * never more than a theme name.
 */
import { mkdirSync, readFileSync, renameSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { cacheRoot } from "./caches.ts";
import { APPEARANCE_SETTINGS, readAppearance, type Appearance } from "./editor.ts";

export const appearanceFile = () => process.env.DESOLATE_APPEARANCE_FILE ?? join(cacheRoot(), "appearance.json");

/** What the file holds; nothing, for a file that is absent or not a theme. */
export const savedAppearance = (file = appearanceFile()): Appearance => {
  try {
    return readAppearance(JSON.parse(readFileSync(file, "utf8")));
  } catch {
    return {};
  }
};

/** The settings of `read` that are the theme, in file order. */
export const appearanceOf = (read: (key: string) => unknown): Appearance =>
  readAppearance(Object.fromEntries(Object.keys(APPEARANCE_SETTINGS).map((key) => [key, read(key)])));

/** `appearance` into the file, unless it already says that. True if it wrote. */
export const keepAppearance = (appearance: Appearance, file = appearanceFile()): boolean => {
  const text = `${JSON.stringify(appearance, null, 2)}\n`;
  try {
    if (readFileSync(file, "utf8") === text) return false;
  } catch {
    /* none yet */
  }
  mkdirSync(dirname(file), { recursive: true });
  // Whole, then into place: `desolate` reads this while a theme changes.
  writeFileSync(`${file}.tmp`, text);
  renameSync(`${file}.tmp`, file);
  return true;
};

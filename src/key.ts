import { mkdir, readFile, rename, writeFile } from "node:fs/promises";
import { dirname } from "node:path";
import { originOf } from "./config.js";

/** A saved key and the Constructor it belongs to. */
export interface SavedKey {
  url: string;
  key: string;
}

/** The saved key, or undefined when none was saved. A broken file throws. */
export async function readKeyFile(file: string): Promise<SavedKey | undefined> {
  let text: string;
  try {
    text = await readFile(file, "utf8");
  } catch (err: any) {
    if (err?.code === "ENOENT") return undefined;
    throw new Error("unreadable");
  }
  let data: any;
  try {
    data = JSON.parse(text);
  } catch {
    // Never echo the contents: they hold the key.
    throw new Error("not valid JSON");
  }
  if (typeof data?.key !== "string" || typeof data?.url !== "string")
    throw new Error("expected url and key");
  return { url: originOf(data.url), key: data.key };
}

/** Saves the key for one Constructor, mode 600, replacing the file in one step. */
export async function saveKeyFile(file: string, url: string, key: string) {
  await mkdir(dirname(file), { recursive: true, mode: 0o700 });
  const tmp = `${file}.${process.pid}.tmp`;
  await writeFile(tmp, JSON.stringify({ url: originOf(url), key }) + "\n", {
    mode: 0o600,
  });
  await rename(tmp, file);
}

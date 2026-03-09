/**
 * Persists Telegram group history media to a cache dir so history entries
 * can reference stable paths when the bot is later @mentioned (#40440).
 */

import fs from "node:fs/promises";
import path from "node:path";
import type { OpenClawConfig } from "../config/config.js";
import { resolveStorePath } from "../config/sessions/paths.js";
import { logVerbose } from "../globals.js";
import type { TelegramMediaRef } from "./bot-message-context.types.js";

const CACHE_SUBDIR = "group-history-media";

function sanitizeHistoryKey(key: string): string {
  return key.replace(/[/\\:]/g, "-").replace(/\s+/g, "_") || "default";
}

function extFromPathOrContentType(filePath: string, contentType?: string): string {
  const fromPath = path.extname(filePath);
  if (fromPath) {
    return fromPath;
  }
  const mimeToExt: Record<string, string> = {
    "image/jpeg": ".jpg",
    "image/png": ".png",
    "image/gif": ".gif",
    "image/webp": ".webp",
    "video/mp4": ".mp4",
    "audio/ogg": ".ogg",
    "audio/mpeg": ".mp3",
  };
  return contentType ? (mimeToExt[contentType] ?? ".bin") : ".bin";
}

/**
 * Copies group history media to a persistent cache under the session store dir.
 * Returns paths and types for inclusion in the history entry.
 */
export async function persistGroupHistoryMedia(params: {
  cfg: OpenClawConfig;
  agentId?: string;
  historyKey: string;
  messageId: string;
  allMedia: TelegramMediaRef[];
}): Promise<{ paths: string[]; types: string[] }> {
  const { cfg, agentId, historyKey, messageId, allMedia } = params;
  if (allMedia.length === 0) {
    return { paths: [], types: [] };
  }
  const storePath = resolveStorePath(cfg.session?.store, { agentId });
  const cacheDir = path.join(path.dirname(storePath), CACHE_SUBDIR, sanitizeHistoryKey(historyKey));
  await fs.mkdir(cacheDir, { recursive: true });
  const paths: string[] = [];
  const types: string[] = [];
  for (let i = 0; i < allMedia.length; i++) {
    const m = allMedia[i];
    const ext = extFromPathOrContentType(m.path, m.contentType);
    const destName = `${messageId}_${i}${ext}`;
    const destPath = path.join(cacheDir, destName);
    try {
      await fs.copyFile(m.path, destPath);
      paths.push(destPath);
      types.push(m.contentType ?? "");
    } catch (err) {
      logVerbose(`telegram: failed to persist group history media ${destName}: ${String(err)}`);
    }
  }
  return { paths, types };
}

/** Entry shape with optional media paths (for eviction cleanup). */
type EntryWithMedia = { mediaPaths?: string[] };

/**
 * Deletes persisted media files for an evicted history entry. Safe to call with
 * missing paths (ignores ENOENT). Fire-and-forget; do not await in hot path.
 */
export function deleteGroupHistoryMediaForEntry(entry: EntryWithMedia): void {
  const paths = entry.mediaPaths;
  if (!Array.isArray(paths) || paths.length === 0) {
    return;
  }
  void Promise.all(
    paths.map((p) =>
      fs.unlink(p).catch((err: NodeJS.ErrnoException) => {
        if (err?.code !== "ENOENT") {
          logVerbose(`telegram: failed to delete group history media ${p}: ${err?.message ?? err}`);
        }
      }),
    ),
  );
}

/**
 * Deletes the entire cache subdir for a history key (e.g. when the key is evicted).
 * Safe to call if the dir is already gone. Fire-and-forget; do not await in hot path.
 */
export function deleteGroupHistoryCacheForKey(params: {
  cfg: OpenClawConfig;
  agentId?: string;
  historyKey: string;
}): void {
  const storePath = resolveStorePath(params.cfg.session?.store, { agentId: params.agentId });
  const cacheDir = path.join(
    path.dirname(storePath),
    CACHE_SUBDIR,
    sanitizeHistoryKey(params.historyKey),
  );
  void fs.rm(cacheDir, { recursive: true, force: true }).catch((err: NodeJS.ErrnoException) => {
    if (err?.code !== "ENOENT") {
      logVerbose(
        `telegram: failed to delete group history cache dir ${cacheDir}: ${err?.message ?? err}`,
      );
    }
  });
}

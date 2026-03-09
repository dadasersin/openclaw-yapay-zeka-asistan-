import { CURRENT_MESSAGE_MARKER } from "./mentions.js";

export const HISTORY_CONTEXT_MARKER = "[Chat messages since your last reply - for context]";
export const DEFAULT_GROUP_HISTORY_LIMIT = 50;

/** Maximum number of group history keys to retain (LRU eviction when exceeded). */
export const MAX_HISTORY_KEYS = 1000;

/**
 * Evict oldest keys from a history map when it exceeds MAX_HISTORY_KEYS.
 * Uses Map's insertion order for LRU-like behavior.
 * Optional onEvictKey is called for each key before deletion (e.g. to clean up persisted media).
 */
export function evictOldHistoryKeys<T>(
  historyMap: Map<string, T[]>,
  maxKeys: number = MAX_HISTORY_KEYS,
  onEvictKey?: (key: string, entries: T[]) => void,
): void {
  if (historyMap.size <= maxKeys) {
    return;
  }
  const keysToDelete = historyMap.size - maxKeys;
  const iterator = historyMap.keys();
  for (let i = 0; i < keysToDelete; i++) {
    const key = iterator.next().value;
    if (key !== undefined) {
      const entries = historyMap.get(key) ?? [];
      if (onEvictKey) {
        onEvictKey(key, entries);
      }
      historyMap.delete(key);
    }
  }
}

export type HistoryEntry = {
  sender: string;
  body: string;
  timestamp?: number;
  messageId?: string;
  /** Persisted paths for media in this entry (e.g. Telegram group history images). */
  mediaPaths?: string[];
  /** Content types for mediaPaths (parallel to mediaPaths). */
  mediaTypes?: string[];
};

export function buildHistoryContext(params: {
  historyText: string;
  currentMessage: string;
  lineBreak?: string;
}): string {
  const { historyText, currentMessage } = params;
  const lineBreak = params.lineBreak ?? "\n";
  if (!historyText.trim()) {
    return currentMessage;
  }
  return [HISTORY_CONTEXT_MARKER, historyText, "", CURRENT_MESSAGE_MARKER, currentMessage].join(
    lineBreak,
  );
}

export function appendHistoryEntry<T extends HistoryEntry>(params: {
  historyMap: Map<string, T[]>;
  historyKey: string;
  entry: T;
  limit: number;
  /** Called when an entry is shifted out due to limit. Use to delete persisted media. */
  onEvictEntry?: (entry: T) => void;
  /** Passed to evictOldHistoryKeys when map exceeds max keys. Use to delete key-scoped cache. */
  onEvictKey?: (key: string, entries: T[]) => void;
}): T[] {
  const { historyMap, historyKey, entry } = params;
  if (params.limit <= 0) {
    return [];
  }
  const history = historyMap.get(historyKey) ?? [];
  history.push(entry);
  while (history.length > params.limit) {
    const evicted = history.shift();
    if (evicted !== undefined && params.onEvictEntry) {
      params.onEvictEntry(evicted);
    }
  }
  if (historyMap.has(historyKey)) {
    // Refresh insertion order so eviction keeps recently used histories.
    historyMap.delete(historyKey);
  }
  historyMap.set(historyKey, history);
  evictOldHistoryKeys(historyMap, MAX_HISTORY_KEYS, params.onEvictKey);
  return history;
}

export function recordPendingHistoryEntry<T extends HistoryEntry>(params: {
  historyMap: Map<string, T[]>;
  historyKey: string;
  entry: T;
  limit: number;
  onEvictEntry?: (entry: T) => void;
  onEvictKey?: (key: string, entries: T[]) => void;
}): T[] {
  return appendHistoryEntry(params);
}

export function recordPendingHistoryEntryIfEnabled<T extends HistoryEntry>(params: {
  historyMap: Map<string, T[]>;
  historyKey: string;
  entry?: T | null;
  limit: number;
  onEvictEntry?: (entry: T) => void;
  onEvictKey?: (key: string, entries: T[]) => void;
}): T[] {
  if (!params.entry) {
    return [];
  }
  if (params.limit <= 0) {
    return [];
  }
  return recordPendingHistoryEntry({
    historyMap: params.historyMap,
    historyKey: params.historyKey,
    entry: params.entry,
    limit: params.limit,
    onEvictEntry: params.onEvictEntry,
    onEvictKey: params.onEvictKey,
  });
}

export function buildPendingHistoryContextFromMap(params: {
  historyMap: Map<string, HistoryEntry[]>;
  historyKey: string;
  limit: number;
  currentMessage: string;
  formatEntry: (entry: HistoryEntry) => string;
  lineBreak?: string;
}): string {
  if (params.limit <= 0) {
    return params.currentMessage;
  }
  const entries = params.historyMap.get(params.historyKey) ?? [];
  return buildHistoryContextFromEntries({
    entries,
    currentMessage: params.currentMessage,
    formatEntry: params.formatEntry,
    lineBreak: params.lineBreak,
    excludeLast: false,
  });
}

export function buildHistoryContextFromMap(params: {
  historyMap: Map<string, HistoryEntry[]>;
  historyKey: string;
  limit: number;
  entry?: HistoryEntry;
  currentMessage: string;
  formatEntry: (entry: HistoryEntry) => string;
  lineBreak?: string;
  excludeLast?: boolean;
}): string {
  if (params.limit <= 0) {
    return params.currentMessage;
  }
  const entries = params.entry
    ? appendHistoryEntry({
        historyMap: params.historyMap,
        historyKey: params.historyKey,
        entry: params.entry,
        limit: params.limit,
      })
    : (params.historyMap.get(params.historyKey) ?? []);
  return buildHistoryContextFromEntries({
    entries,
    currentMessage: params.currentMessage,
    formatEntry: params.formatEntry,
    lineBreak: params.lineBreak,
    excludeLast: params.excludeLast,
  });
}

export function clearHistoryEntries(params: {
  historyMap: Map<string, HistoryEntry[]>;
  historyKey: string;
}): void {
  params.historyMap.set(params.historyKey, []);
}

export function clearHistoryEntriesIfEnabled(params: {
  historyMap: Map<string, HistoryEntry[]>;
  historyKey: string;
  limit: number;
}): void {
  if (params.limit <= 0) {
    return;
  }
  clearHistoryEntries({ historyMap: params.historyMap, historyKey: params.historyKey });
}

export function buildHistoryContextFromEntries(params: {
  entries: HistoryEntry[];
  currentMessage: string;
  formatEntry: (entry: HistoryEntry) => string;
  lineBreak?: string;
  excludeLast?: boolean;
}): string {
  const lineBreak = params.lineBreak ?? "\n";
  const entries = params.excludeLast === false ? params.entries : params.entries.slice(0, -1);
  if (entries.length === 0) {
    return params.currentMessage;
  }
  const historyText = entries.map(params.formatEntry).join(lineBreak);
  return buildHistoryContext({
    historyText,
    currentMessage: params.currentMessage,
    lineBreak,
  });
}

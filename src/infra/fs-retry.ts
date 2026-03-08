/**
 * File-system write helpers that retry on transient lock errors
 * (EBUSY / EACCES / EPERM) instead of crashing the process.
 *
 * These errors commonly occur when cloud-sync services (OneDrive,
 * Dropbox, Google Drive, Baidu Netdisk) temporarily lock files
 * during upload/download.
 *
 * @see https://github.com/openclaw/openclaw/issues/39446
 */

import fs from "node:fs";
import os from "node:os";

const RETRYABLE_CODES = new Set(["EBUSY", "EACCES", "EPERM"]);
const MAX_RETRIES = 3;
const BASE_DELAY_MS = 50;

function isRetryableError(err: unknown): boolean {
  return RETRYABLE_CODES.has((err as { code?: string }).code ?? "");
}

function sleepSync(ms: number): void {
  Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, ms);
}

/**
 * `fs.writeFileSync` with retry on transient lock errors.
 * Throws the original error after exhausting all retries.
 */
export function writeFileSyncRetry(
  filePath: string,
  data: string | Buffer,
  options?: fs.WriteFileOptions,
): void {
  for (let attempt = 0; attempt <= MAX_RETRIES; attempt++) {
    try {
      fs.writeFileSync(filePath, data, options);
      return;
    } catch (err) {
      if (isRetryableError(err) && attempt < MAX_RETRIES) {
        sleepSync(BASE_DELAY_MS * 2 ** attempt);
        continue;
      }
      throw err;
    }
  }
}

/**
 * `fs.appendFileSync` with retry on transient lock errors.
 * Throws the original error after exhausting all retries.
 */
export function appendFileSyncRetry(
  filePath: string,
  data: string | Buffer,
  options?: fs.WriteFileOptions,
): void {
  for (let attempt = 0; attempt <= MAX_RETRIES; attempt++) {
    try {
      fs.appendFileSync(filePath, data, options);
      return;
    } catch (err) {
      if (isRetryableError(err) && attempt < MAX_RETRIES) {
        sleepSync(BASE_DELAY_MS * 2 ** attempt);
        continue;
      }
      throw err;
    }
  }
}

/**
 * Async `fs.promises.appendFile` with retry on transient lock errors.
 */
export async function appendFileRetry(
  filePath: string,
  data: string | Buffer,
  options?: Parameters<typeof fs.promises.appendFile>[2],
): Promise<void> {
  for (let attempt = 0; attempt <= MAX_RETRIES; attempt++) {
    try {
      await fs.promises.appendFile(filePath, data, options);
      return;
    } catch (err) {
      if (isRetryableError(err) && attempt < MAX_RETRIES) {
        await new Promise((resolve) => setTimeout(resolve, BASE_DELAY_MS * 2 ** attempt));
        continue;
      }
      throw err;
    }
  }
}

/**
 * Async `fs.promises.writeFile` with retry on transient lock errors.
 */
export async function writeFileRetry(
  filePath: string,
  data: string | Buffer,
  options?: Parameters<typeof fs.promises.writeFile>[2],
): Promise<void> {
  for (let attempt = 0; attempt <= MAX_RETRIES; attempt++) {
    try {
      await fs.promises.writeFile(filePath, data, options);
      return;
    } catch (err) {
      if (isRetryableError(err) && attempt < MAX_RETRIES) {
        await new Promise((resolve) => setTimeout(resolve, BASE_DELAY_MS * 2 ** attempt));
        continue;
      }
      throw err;
    }
  }
}

/**
 * Async `fs.promises.rename` with retry on transient lock errors.
 * Falls back to copy + unlink on Windows when rename fails with EPERM/EEXIST.
 */
export async function renameRetry(src: string, dest: string): Promise<void> {
  for (let attempt = 0; attempt <= MAX_RETRIES; attempt++) {
    try {
      await fs.promises.rename(src, dest);
      return;
    } catch (err) {
      const code = (err as { code?: string }).code;
      if (code && RETRYABLE_CODES.has(code) && attempt < MAX_RETRIES) {
        await new Promise((resolve) => setTimeout(resolve, BASE_DELAY_MS * 2 ** attempt));
        continue;
      }
      // Windows fallback: copy + unlink when rename fails (EPERM on
      // non-Windows is a real permission error, not a transient lock)
      if ((code === "EPERM" || code === "EEXIST") && os.platform() === "win32") {
        await fs.promises.copyFile(src, dest);
        await fs.promises.unlink(src).catch(() => {});
        return;
      }
      throw err;
    }
  }
}

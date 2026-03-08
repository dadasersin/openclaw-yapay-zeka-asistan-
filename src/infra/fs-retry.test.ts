import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import {
  appendFileRetry,
  appendFileSyncRetry,
  renameRetry,
  writeFileRetry,
  writeFileSyncRetry,
} from "./fs-retry.js";

describe("fs-retry", () => {
  let tmpDir: string;

  beforeEach(() => {
    tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "fs-retry-test-"));
  });

  afterEach(() => {
    vi.restoreAllMocks();
    fs.rmSync(tmpDir, { recursive: true, force: true });
  });

  describe("writeFileSyncRetry", () => {
    it("writes a file successfully on first attempt", () => {
      const filePath = path.join(tmpDir, "test.txt");
      writeFileSyncRetry(filePath, "hello", "utf8");
      expect(fs.readFileSync(filePath, "utf8")).toBe("hello");
    });

    it("retries on EBUSY and succeeds", () => {
      const filePath = path.join(tmpDir, "test.txt");
      let attempt = 0;
      const originalWriteFileSync = fs.writeFileSync;
      vi.spyOn(fs, "writeFileSync").mockImplementation((...args: unknown[]) => {
        attempt++;
        if (attempt <= 2) {
          const err = new Error("EBUSY") as NodeJS.ErrnoException;
          err.code = "EBUSY";
          throw err;
        }
        return originalWriteFileSync.call(fs, ...(args as Parameters<typeof fs.writeFileSync>));
      });

      writeFileSyncRetry(filePath, "hello", "utf8");
      expect(fs.readFileSync(filePath, "utf8")).toBe("hello");
      expect(attempt).toBe(3);
    });

    it("throws non-retryable errors immediately", () => {
      const filePath = path.join(tmpDir, "nonexistent", "deep", "test.txt");
      // ENOENT is not retryable
      expect(() => writeFileSyncRetry(filePath, "hello", "utf8")).toThrow();
    });

    it("throws after exhausting retries", () => {
      const filePath = path.join(tmpDir, "test.txt");
      vi.spyOn(fs, "writeFileSync").mockImplementation(() => {
        const err = new Error("EBUSY") as NodeJS.ErrnoException;
        err.code = "EBUSY";
        throw err;
      });

      expect(() => writeFileSyncRetry(filePath, "hello", "utf8")).toThrow("EBUSY");
    });
  });

  describe("appendFileSyncRetry", () => {
    it("appends to a file successfully", () => {
      const filePath = path.join(tmpDir, "append.txt");
      fs.writeFileSync(filePath, "line1\n", "utf8");
      appendFileSyncRetry(filePath, "line2\n", { encoding: "utf8" });
      expect(fs.readFileSync(filePath, "utf8")).toBe("line1\nline2\n");
    });

    it("retries on EPERM and succeeds", () => {
      const filePath = path.join(tmpDir, "append.txt");
      fs.writeFileSync(filePath, "", "utf8");
      let attempt = 0;
      const originalAppendFileSync = fs.appendFileSync;
      vi.spyOn(fs, "appendFileSync").mockImplementation((...args: unknown[]) => {
        attempt++;
        if (attempt === 1) {
          const err = new Error("EPERM") as NodeJS.ErrnoException;
          err.code = "EPERM";
          throw err;
        }
        return originalAppendFileSync.call(fs, ...(args as Parameters<typeof fs.appendFileSync>));
      });

      appendFileSyncRetry(filePath, "data", { encoding: "utf8" });
      expect(attempt).toBe(2);
    });
  });

  describe("writeFileRetry (async)", () => {
    it("writes a file successfully on first attempt", async () => {
      const filePath = path.join(tmpDir, "async-test.txt");
      await writeFileRetry(filePath, "hello-async", "utf8");
      expect(fs.readFileSync(filePath, "utf8")).toBe("hello-async");
    });

    it("retries on EACCES and succeeds", async () => {
      const filePath = path.join(tmpDir, "async-test.txt");
      let attempt = 0;
      const originalWriteFile = fs.promises.writeFile;
      vi.spyOn(fs.promises, "writeFile").mockImplementation(async (...args: unknown[]) => {
        attempt++;
        if (attempt === 1) {
          const err = new Error("EACCES") as NodeJS.ErrnoException;
          err.code = "EACCES";
          throw err;
        }
        return originalWriteFile.call(
          fs.promises,
          ...(args as Parameters<typeof fs.promises.writeFile>),
        );
      });

      await writeFileRetry(filePath, "hello-async", "utf8");
      expect(fs.readFileSync(filePath, "utf8")).toBe("hello-async");
      expect(attempt).toBe(2);
    });
  });

  describe("appendFileRetry (async)", () => {
    it("appends to a file successfully", async () => {
      const filePath = path.join(tmpDir, "async-append.txt");
      fs.writeFileSync(filePath, "first\n", "utf8");
      await appendFileRetry(filePath, "second\n", "utf8");
      expect(fs.readFileSync(filePath, "utf8")).toBe("first\nsecond\n");
    });

    it("retries on EBUSY and succeeds", async () => {
      const filePath = path.join(tmpDir, "async-append.txt");
      fs.writeFileSync(filePath, "", "utf8");
      let attempt = 0;
      const originalAppendFile = fs.promises.appendFile;
      vi.spyOn(fs.promises, "appendFile").mockImplementation(async (...args: unknown[]) => {
        attempt++;
        if (attempt <= 2) {
          const err = new Error("EBUSY") as NodeJS.ErrnoException;
          err.code = "EBUSY";
          throw err;
        }
        return originalAppendFile.call(
          fs.promises,
          ...(args as Parameters<typeof fs.promises.appendFile>),
        );
      });

      await appendFileRetry(filePath, "data", "utf8");
      expect(attempt).toBe(3);
    });
  });

  describe("renameRetry", () => {
    it("renames a file successfully on first attempt", async () => {
      const src = path.join(tmpDir, "src.txt");
      const dest = path.join(tmpDir, "dest.txt");
      fs.writeFileSync(src, "data", "utf8");
      await renameRetry(src, dest);
      expect(fs.readFileSync(dest, "utf8")).toBe("data");
      expect(fs.existsSync(src)).toBe(false);
    });

    it("retries on EBUSY and succeeds", async () => {
      const src = path.join(tmpDir, "src.txt");
      const dest = path.join(tmpDir, "dest.txt");
      fs.writeFileSync(src, "data", "utf8");
      let attempt = 0;
      const originalRename = fs.promises.rename;
      vi.spyOn(fs.promises, "rename").mockImplementation(async (...args: unknown[]) => {
        attempt++;
        if (attempt === 1) {
          const err = new Error("EBUSY") as NodeJS.ErrnoException;
          err.code = "EBUSY";
          throw err;
        }
        return originalRename.call(fs.promises, ...(args as Parameters<typeof fs.promises.rename>));
      });
      await renameRetry(src, dest);
      expect(fs.readFileSync(dest, "utf8")).toBe("data");
      expect(attempt).toBe(2);
    });
  });
});

import { describe, expect, it } from "vitest";
import { normalizeAllowFrom } from "./bot-access.js";

describe("normalizeAllowFrom", () => {
  it("accepts positive sender IDs and negative group/supergroup chat IDs", () => {
    const result = normalizeAllowFrom(["-1001234567890", " tg:-100999 ", "745123456", "@someone"]);

    expect(result).toEqual({
      entries: ["-1001234567890", "-100999", "745123456"],
      hasWildcard: false,
      hasEntries: true,
      invalidEntries: ["@someone"],
    });
  });

  it("rejects non-numeric entries but accepts negative IDs", () => {
    const result = normalizeAllowFrom(["-1003890514701", "123456789", "@badentry", "tg:-999"]);

    expect(result).toEqual({
      entries: ["-1003890514701", "123456789", "-999"],
      hasWildcard: false,
      hasEntries: true,
      invalidEntries: ["@badentry"],
    });
  });
});

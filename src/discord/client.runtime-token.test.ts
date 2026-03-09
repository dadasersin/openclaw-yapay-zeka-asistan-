import { describe, expect, it } from "vitest";
import type { OpenClawConfig } from "../config/config.js";
import { createDiscordRestClient } from "./client.js";

describe("createDiscordRestClient", () => {
  it("prefers the explicit runtime token before resolving SecretRef-backed config", () => {
    const rest = { marker: "rest" } as const;
    const cfg: OpenClawConfig = {
      channels: {
        discord: {
          token: {
            source: "file",
            provider: "filemain",
            id: "/discord/token",
          },
          accounts: {
            default: {
              retry: {
                attempts: 5,
              },
            },
          },
        },
      },
    };

    const resolved = createDiscordRestClient(
      {
        accountId: "default",
        token: "runtime-token",
        rest: rest as never,
      },
      cfg,
    );

    expect(resolved.token).toBe("runtime-token");
    expect(resolved.rest).toBe(rest);
    expect(resolved.account.accountId).toBe("default");
    expect(resolved.account.config.retry?.attempts).toBe(5);
  });
});

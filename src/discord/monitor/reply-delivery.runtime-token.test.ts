import { beforeEach, describe, expect, it, vi } from "vitest";
import type { RuntimeEnv } from "../../runtime.js";

const sendMessageDiscordMock = vi.hoisted(() => vi.fn());
const sendVoiceMessageDiscordMock = vi.hoisted(() => vi.fn());
const sendWebhookMessageDiscordMock = vi.hoisted(() => vi.fn());
const sendDiscordTextMock = vi.hoisted(() => vi.fn());
const loadConfigMock = vi.hoisted(() => vi.fn());

vi.mock("../../config/config.js", () => ({
  loadConfig: () => loadConfigMock(),
}));

vi.mock("../send.js", () => ({
  sendMessageDiscord: (...args: unknown[]) => sendMessageDiscordMock(...args),
  sendVoiceMessageDiscord: (...args: unknown[]) => sendVoiceMessageDiscordMock(...args),
  sendWebhookMessageDiscord: (...args: unknown[]) => sendWebhookMessageDiscordMock(...args),
}));

vi.mock("../send.shared.js", () => ({
  sendDiscordText: (...args: unknown[]) => sendDiscordTextMock(...args),
}));

import { deliverDiscordReply } from "./reply-delivery.js";

describe("deliverDiscordReply runtime token handling", () => {
  const runtime = {
    log: vi.fn(),
    error: vi.fn(),
    exit: vi.fn(),
  } as unknown as RuntimeEnv;

  beforeEach(() => {
    loadConfigMock.mockReset().mockReturnValue({
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
                attempts: 4,
              },
            },
          },
        },
      },
    });
    sendMessageDiscordMock.mockReset().mockResolvedValue({
      messageId: "msg-1",
      channelId: "channel-123",
    });
    sendVoiceMessageDiscordMock.mockReset();
    sendWebhookMessageDiscordMock.mockReset();
    sendDiscordTextMock.mockReset();
  });

  it("does not resolve the configured token SecretRef when a live token is already supplied", async () => {
    await deliverDiscordReply({
      replies: [{ text: "hello from runtime token" }],
      target: "channel:123",
      token: "runtime-token",
      accountId: "default",
      runtime,
      textLimit: 2000,
    });

    expect(sendMessageDiscordMock).toHaveBeenCalledWith(
      "channel:123",
      "hello from runtime token",
      expect.objectContaining({
        token: "runtime-token",
        accountId: "default",
      }),
    );
  });
});

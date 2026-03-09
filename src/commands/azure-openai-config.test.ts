import { describe, expect, it } from "vitest";
import {
  AZURE_OPENAI_DEFAULT_API_VERSION,
  applyAzureOpenAIConfig,
  normalizeAzureOpenAIBaseUrl,
  normalizeAzureOpenAIApiVersion,
  normalizeAzureOpenAIModelId,
} from "./azure-openai-config.js";

describe("azure-openai-config", () => {
  it("normalizes Azure base URL to /openai/v1", () => {
    const cases = [
      ["https://example.openai.azure.com", "https://example.openai.azure.com/openai/v1"],
      ["https://example.openai.azure.com/openai/v1", "https://example.openai.azure.com/openai/v1"],
      ["https://example.services.ai.azure.com", "https://example.services.ai.azure.com/openai/v1"],
      [
        "https://example.cognitiveservices.azure.com",
        "https://example.cognitiveservices.azure.com/openai/v1",
      ],
    ] as const;

    for (const [input, expected] of cases) {
      expect(normalizeAzureOpenAIBaseUrl(input)).toBe(expected);
    }
  });

  it("rejects non-Azure hosts", () => {
    expect(() => normalizeAzureOpenAIBaseUrl("https://api.openai.com/v1")).toThrow(
      /Azure OpenAI base URL must use an Azure host/i,
    );
  });

  it("rejects non-HTTPS base URLs", () => {
    expect(() => normalizeAzureOpenAIBaseUrl("http://example.openai.azure.com/openai/v1")).toThrow(
      /Azure OpenAI base URL must use HTTPS/i,
    );
  });

  it("rejects base URLs with query params", () => {
    expect(() =>
      normalizeAzureOpenAIBaseUrl(
        "https://example.openai.azure.com/openai/v1?api-version=2025-04-01-preview",
      ),
    ).toThrow(/must not include query parameters/i);
  });

  it("rejects empty model IDs", () => {
    expect(() => normalizeAzureOpenAIModelId("   ")).toThrow(/deployment\/model ID is required/i);
  });

  it("validates apiVersion input", () => {
    expect(normalizeAzureOpenAIApiVersion(" 2025-04-01-preview ")).toBe("2025-04-01-preview");
    expect(() => normalizeAzureOpenAIApiVersion("  ")).toThrow(/API version/i);
  });

  it("applies provider + default model config", () => {
    const cfg = applyAzureOpenAIConfig(
      {},
      {
        baseUrl: "https://example.openai.azure.com/openai/v1",
        modelId: "gpt-4.1",
        apiVersion: "2025-04-01-preview",
      },
    );

    expect(cfg.models?.providers?.["azure-openai-responses"]?.api).toBe("openai-responses");
    expect(cfg.models?.providers?.["azure-openai-responses"]?.baseUrl).toBe(
      "https://example.openai.azure.com/openai/v1",
    );
    expect(cfg.agents?.defaults?.models?.["azure-openai-responses/gpt-4.1"]?.params).toMatchObject({
      azureApiVersion: "2025-04-01-preview",
    });
    expect(cfg.agents?.defaults?.model).toEqual({ primary: "azure-openai-responses/gpt-4.1" });
  });

  it("uses default v1 apiVersion without adding explicit params", () => {
    const cfg = applyAzureOpenAIConfig(
      {},
      {
        baseUrl: "https://example.openai.azure.com/openai/v1",
        modelId: "gpt-4.1",
        apiVersion: AZURE_OPENAI_DEFAULT_API_VERSION,
      },
    );
    expect(cfg.agents?.defaults?.models?.["azure-openai-responses/gpt-4.1"]?.params).toEqual({});
  });

  it("backfills supportsStore=false for existing Azure model entries", () => {
    const cfg = applyAzureOpenAIConfig(
      {
        models: {
          providers: {
            "azure-openai-responses": {
              api: "openai-responses",
              baseUrl: "https://example.openai.azure.com/openai/v1",
              models: [
                {
                  id: "gpt-4.1",
                  name: "Existing Azure model",
                  reasoning: false,
                  input: ["text"],
                  cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
                  contextWindow: 128000,
                  maxTokens: 4096,
                },
              ],
            },
          },
        },
      },
      {
        baseUrl: "https://example.openai.azure.com/openai/v1",
        modelId: "gpt-4.1",
      },
    );

    expect(cfg.models?.providers?.["azure-openai-responses"]?.models?.[0]?.compat).toMatchObject({
      supportsStore: false,
    });
  });
});

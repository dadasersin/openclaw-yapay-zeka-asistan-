import type { ModelDefinitionConfig } from "../config/types.models.js";

export const TOGETHER_BASE_URL = "https://api.together.xyz/v1";

export const TOGETHER_MODEL_CATALOG: ModelDefinitionConfig[] = [
  {
    id: "zai-org/GLM-4.7",
    name: "GLM 4.7 Fp8",
    reasoning: false,
    input: ["text"],
    contextWindow: 202752,
    maxTokens: 8192,
    cost: {
      input: 1.35,
      output: 6.0,
      cacheRead: 1.35,
      cacheWrite: 6.0,
    },
  },
  {
    id: "moonshotai/Kimi-K2.5",
    name: "Kimi K2.5",
    reasoning: true,
    input: ["text", "image"],
    cost: {
      input: 1.5,
      output: 8.4,
      cacheRead: 1.5,
      cacheWrite: 8.4,
    },
    contextWindow: 262144,
    maxTokens: 32768,
  },
  {
    id: "meta-llama/Llama-3.3-70B-Instruct-Turbo",
    name: "Llama 3.3 70B Instruct Turbo",
    reasoning: false,
    input: ["text"],
    contextWindow: 131072,
    maxTokens: 8192,
    cost: {
      input: 2.64,
      output: 2.64,
      cacheRead: 2.64,
      cacheWrite: 2.64,
    },
  },
  {
    id: "meta-llama/Llama-4-Scout-17B-16E-Instruct",
    name: "Llama 4 Scout 17B 16E Instruct",
    reasoning: false,
    input: ["text", "image"],
    contextWindow: 10000000,
    maxTokens: 32768,
    cost: {
      input: 0.54,
      output: 1.77,
      cacheRead: 0.54,
      cacheWrite: 0.54,
    },
  },
  {
    id: "meta-llama/Llama-4-Maverick-17B-128E-Instruct-FP8",
    name: "Llama 4 Maverick 17B 128E Instruct FP8",
    reasoning: false,
    input: ["text", "image"],
    contextWindow: 20000000,
    maxTokens: 32768,
    cost: {
      input: 0.81,
      output: 2.55,
      cacheRead: 0.81,
      cacheWrite: 0.81,
    },
  },
  {
    id: "deepseek-ai/DeepSeek-V3.1",
    name: "DeepSeek V3.1",
    reasoning: false,
    input: ["text"],
    contextWindow: 131072,
    maxTokens: 8192,
    cost: {
      input: 1.8,
      output: 3.75,
      cacheRead: 1.8,
      cacheWrite: 1.8,
    },
  },
  {
    id: "deepseek-ai/DeepSeek-R1",
    name: "DeepSeek R1",
    reasoning: true,
    input: ["text"],
    contextWindow: 131072,
    maxTokens: 8192,
    cost: {
      input: 9.0,
      output: 21.0,
      cacheRead: 9.0,
      cacheWrite: 9.0,
    },
  },
  {
    id: "moonshotai/Kimi-K2-Instruct-0905",
    name: "Kimi K2-Instruct 0905",
    reasoning: false,
    input: ["text"],
    contextWindow: 262144,
    maxTokens: 8192,
    cost: {
      input: 3.0,
      output: 9.0,
      cacheRead: 3.0,
      cacheWrite: 9.0,
    },
  },
];

export function buildTogetherModelDefinition(
  model: (typeof TOGETHER_MODEL_CATALOG)[number],
): ModelDefinitionConfig {
  return {
    id: model.id,
    name: model.name,
    api: "openai-completions",
    reasoning: model.reasoning,
    input: model.input,
    cost: model.cost,
    contextWindow: model.contextWindow,
    maxTokens: model.maxTokens,
  };
}

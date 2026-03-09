import type { ApplyAuthChoiceParams, ApplyAuthChoiceResult } from "./auth-choice.apply.js";
import { promptAndConfigureOllama } from "./ollama-setup.js";
import { applyAgentDefaultModelPrimary } from "./onboard-auth.config-shared.js";

export async function applyAuthChoiceOllama(
  params: ApplyAuthChoiceParams,
): Promise<ApplyAuthChoiceResult | null> {
  if (params.authChoice !== "ollama") {
    return null;
  }

  const { config, defaultModelId } = await promptAndConfigureOllama({
    cfg: params.config,
    prompter: params.prompter,
    agentDir: params.agentDir,
  });

  // Set an Ollama default so the model picker pre-selects an Ollama model.
  const defaultModel = `ollama/${defaultModelId}`;
  if (!params.setDefaultModel) {
    return { config, agentModelOverride: defaultModel };
  }

  return { config: applyAgentDefaultModelPrimary(config, defaultModel) };
}

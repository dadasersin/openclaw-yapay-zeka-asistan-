import type { OpenClawPluginApi } from "openclaw/plugin-sdk/core";

const plugin = {
  id: "agent-debugger",
  name: "Agent Debugger",
  description: "Logs agent interaction events (LLM, tools, prompts) to console for debugging.",
  register(api: OpenClawPluginApi) {
    api.logger.info("[agent-debugger] Console logging enabled");

    const logEvent = (type: string, event: unknown) => {
      const timestamp = new Date().toISOString();
      const payload = {
        ts: timestamp,
        type,
        data: event,
      };

      if (api.logger.debug) {
        api.logger.debug(`>>> LLM ${type} >>>`);
        api.logger.debug(JSON.stringify(payload, null, 2));
      }
    };

    // LLM Traffic
    api.on("llm_input", (event) => logEvent("llm_input", event));
    api.on("llm_output", (event) => logEvent("llm_output", event));

    // Prompt Construction
    api.on("before_prompt_build", (event) => logEvent("before_prompt_build", event));
    api.on("before_model_resolve", (event) => logEvent("before_model_resolve", event));

    // Tool Execution
    api.on("before_tool_call", (event) => logEvent("before_tool_call", event));
    api.on("after_tool_call", (event) => logEvent("after_tool_call", event));

    // Session Lifecycle
    api.on("session_start", (event) => logEvent("session_start", event));
    api.on("session_end", (event) => logEvent("session_end", event));
  },
};

export default plugin;

import type { TextToSpeechRequest, TextToSpeechResult } from "../media-understanding/types.js";

export type TtsProvider = {
  id: string;
  textToSpeech: (req: TextToSpeechRequest) => Promise<TextToSpeechResult>;
};

export type TtsProviderRegistry = Map<string, TtsProvider>;

function mapCapability(cap: string): cap is "tts" {
  return cap === "tts";
}

async function getPluginTtsProviderOverrides(): Promise<Record<string, TtsProvider>> {
  try {
    const { requireActivePluginRegistry } = await import("../plugins/runtime.js");
    const registry = requireActivePluginRegistry();
    const overrides: Record<string, TtsProvider> = {};

    for (const entry of registry.mediaProviders) {
      const p = entry.provider;
      const hasTtsCapability = p.capabilities?.some(mapCapability) ?? false;
      if (!hasTtsCapability || !p.textToSpeech) {
        continue;
      }
      const provider: TtsProvider = {
        id: p.id,
        textToSpeech: p.textToSpeech,
      };
      overrides[p.id] = provider;
    }

    return overrides;
  } catch {
    return {};
  }
}

let cachedPluginOverrides: Record<string, TtsProvider> | null = null;
let pluginOverridesPromise: Promise<Record<string, TtsProvider>> | null = null;

export function buildTtsProviderRegistry(
  overrides?: Record<string, TtsProvider>,
): TtsProviderRegistry {
  const registry = new Map<string, TtsProvider>();

  if (cachedPluginOverrides) {
    for (const [key, provider] of Object.entries(cachedPluginOverrides)) {
      if (!registry.has(key)) {
        registry.set(key, provider);
      }
    }
  }

  if (overrides) {
    for (const [key, provider] of Object.entries(overrides)) {
      const existing = registry.get(key);
      const merged = existing ? { ...existing, ...provider } : provider;
      registry.set(key, merged);
    }
  }
  return registry;
}

export async function buildTtsProviderRegistryAsync(
  overrides?: Record<string, TtsProvider>,
): Promise<TtsProviderRegistry> {
  if (!cachedPluginOverrides && !pluginOverridesPromise) {
    pluginOverridesPromise = getPluginTtsProviderOverrides().then((overrides) => {
      cachedPluginOverrides = overrides;
      return overrides;
    });
  }

  const pluginOverrides = await pluginOverridesPromise;
  return buildTtsProviderRegistry({ ...pluginOverrides, ...overrides });
}

export function invalidateTtsProviderCache(): void {
  cachedPluginOverrides = null;
  pluginOverridesPromise = null;
}

export function getTtsProvider(id: string, registry: TtsProviderRegistry): TtsProvider | undefined {
  return registry.get(id.toLowerCase());
}

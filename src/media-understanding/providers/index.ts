import { normalizeProviderId } from "../../agents/model-selection.js";
import type { MediaUnderstandingProvider, MediaUnderstandingCapability } from "../types.js";
import { anthropicProvider } from "./anthropic/index.js";
import { deepgramProvider } from "./deepgram/index.js";
import { googleProvider } from "./google/index.js";
import { groqProvider } from "./groq/index.js";
import { minimaxPortalProvider, minimaxProvider } from "./minimax/index.js";
import { mistralProvider } from "./mistral/index.js";
import { moonshotProvider } from "./moonshot/index.js";
import { openaiProvider } from "./openai/index.js";
import { zaiProvider } from "./zai/index.js";

const PROVIDERS: MediaUnderstandingProvider[] = [
  groqProvider,
  openaiProvider,
  googleProvider,
  anthropicProvider,
  minimaxProvider,
  minimaxPortalProvider,
  moonshotProvider,
  mistralProvider,
  zaiProvider,
  deepgramProvider,
];

export function normalizeMediaProviderId(id: string): string {
  const normalized = normalizeProviderId(id);
  if (normalized === "gemini") {
    return "google";
  }
  return normalized;
}

function mapCapability(cap: string): MediaUnderstandingCapability | undefined {
  if (cap === "audio") {
    return "audio";
  }
  if (cap === "image") {
    return "image";
  }
  if (cap === "video") {
    return "video";
  }
  return undefined;
}

async function getPluginMediaProviderOverrides(): Promise<
  Record<string, MediaUnderstandingProvider>
> {
  try {
    const { requireActivePluginRegistry } = await import("../../plugins/runtime.js");
    const registry = requireActivePluginRegistry();
    const overrides: Record<string, MediaUnderstandingProvider> = {};

    for (const entry of registry.mediaProviders) {
      const p = entry.provider;
      const capabilities = p.capabilities
        ?.map(mapCapability)
        .filter((c): c is MediaUnderstandingCapability => c !== undefined);
      const provider: MediaUnderstandingProvider = {
        id: p.id,
        capabilities: capabilities.length > 0 ? capabilities : undefined,
        transcribeAudio: p.transcribeAudio as MediaUnderstandingProvider["transcribeAudio"],
        describeImage: p.describeImage as MediaUnderstandingProvider["describeImage"],
        describeVideo: p.describeVideo as MediaUnderstandingProvider["describeVideo"],
        textToSpeech: p.textToSpeech as MediaUnderstandingProvider["textToSpeech"],
      };
      overrides[p.id] = provider;
    }

    return overrides;
  } catch {
    return {};
  }
}

let cachedPluginOverrides: Record<string, MediaUnderstandingProvider> | null = null;
let pluginOverridesPromise: Promise<Record<string, MediaUnderstandingProvider>> | null = null;

export function buildMediaUnderstandingRegistry(
  overrides?: Record<string, MediaUnderstandingProvider>,
): Map<string, MediaUnderstandingProvider> {
  const registry = new Map<string, MediaUnderstandingProvider>();
  for (const provider of PROVIDERS) {
    registry.set(normalizeMediaProviderId(provider.id), provider);
  }

  if (cachedPluginOverrides) {
    for (const [key, provider] of Object.entries(cachedPluginOverrides)) {
      const normalizedKey = normalizeMediaProviderId(key);
      if (!registry.has(normalizedKey)) {
        registry.set(normalizedKey, provider);
      }
    }
  }

  if (overrides) {
    for (const [key, provider] of Object.entries(overrides)) {
      const normalizedKey = normalizeMediaProviderId(key);
      const existing = registry.get(normalizedKey);
      const merged = existing
        ? {
            ...existing,
            ...provider,
            capabilities: provider.capabilities ?? existing.capabilities,
          }
        : provider;
      registry.set(normalizedKey, merged);
    }
  }
  return registry;
}

export async function buildMediaUnderstandingRegistryAsync(
  overrides?: Record<string, MediaUnderstandingProvider>,
): Promise<Map<string, MediaUnderstandingProvider>> {
  if (!cachedPluginOverrides && !pluginOverridesPromise) {
    pluginOverridesPromise = getPluginMediaProviderOverrides().then((overrides) => {
      cachedPluginOverrides = overrides;
      return overrides;
    });
  }

  const pluginOverrides = await pluginOverridesPromise;
  return buildMediaUnderstandingRegistry({ ...pluginOverrides, ...overrides });
}

export function invalidateMediaProviderCache(): void {
  cachedPluginOverrides = null;
  pluginOverridesPromise = null;
}

export function getMediaUnderstandingProvider(
  id: string,
  registry: Map<string, MediaUnderstandingProvider>,
): MediaUnderstandingProvider | undefined {
  return registry.get(normalizeMediaProviderId(id));
}

import type { ProviderId } from "../core/types.js";
import type { ProviderAdapter } from "./adapter.js";
import { claudeProvider } from "./claude.js";
import { clineProvider } from "./cline.js";
import { codexProvider } from "./codex.js";
import { geminiProvider } from "./gemini.js";
import { githubModelsProvider } from "./github-models.js";
import { groqProvider } from "./groq.js";
import { manualProvider } from "./manual.js";
import { mistralProvider } from "./mistral.js";
import { nvidiaNimProvider } from "./nvidia-nim.js";
import { opencodeProvider } from "./opencode.js";
import { openRouterProvider } from "./openrouter.js";
import { zaiProvider } from "./zai.js";
import { kiloProvider } from "./kilo.js";

const PROVIDERS: Record<ProviderId, ProviderAdapter> = {
  manual: manualProvider,
  codex: codexProvider,
  claude: claudeProvider,
  zai: zaiProvider,
  opencode: opencodeProvider,
  kilo: kiloProvider,
  cline: clineProvider,
  openrouter: openRouterProvider,
  "github-models": githubModelsProvider,
  gemini: geminiProvider,
  "nvidia-nim": nvidiaNimProvider,
  mistral: mistralProvider,
  groq: groqProvider,
};

export function providerAdapter(provider: ProviderId): ProviderAdapter {
  return PROVIDERS[provider];
}

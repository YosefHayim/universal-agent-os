import { accountBackedSource } from "./static-cloud.js";

export const anthropicSource = accountBackedSource("claude", "https://docs.anthropic.com/", "subscription");

export async function discoverAnthropicModels() {
  return anthropicSource.discover();
}

export const anthropicModelSource = anthropicSource;

import { accountBackedSource } from "./static-cloud.js";

export const zaiSource = accountBackedSource("zai", "https://docs.z.ai/guides/overview/pricing", "subscription");

export async function discoverZaiModels() {
  return zaiSource.discover();
}

export const zaiModelSource = zaiSource;

import { githubModelsSource } from "../models/sources/github-models.js";
import { cloudCatalogProvider } from "./provider-factory.js";

export const githubModelsProvider = cloudCatalogProvider("github-models", githubModelsSource, { envVars: ["GITHUB_TOKEN", "GH_TOKEN"] });

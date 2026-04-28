import { openRouterSource } from "../models/sources/openrouter.js";
import { cloudCatalogProvider } from "./provider-factory.js";

export const openRouterProvider = cloudCatalogProvider("openrouter", openRouterSource, { envVars: ["OPENROUTER_API_KEY"] });

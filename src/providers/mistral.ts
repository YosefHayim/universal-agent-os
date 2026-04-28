import { mistralSource } from "../models/sources/mistral.js";
import { cloudCatalogProvider } from "./provider-factory.js";

export const mistralProvider = cloudCatalogProvider("mistral", mistralSource, { envVars: ["MISTRAL_API_KEY"] });

import { groqSource } from "../models/sources/groq.js";
import { cloudCatalogProvider } from "./provider-factory.js";

export const groqProvider = cloudCatalogProvider("groq", groqSource, { envVars: ["GROQ_API_KEY"] });

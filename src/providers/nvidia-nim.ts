import { nvidiaNimSource } from "../models/sources/nvidia-nim.js";
import { cloudCatalogProvider } from "./provider-factory.js";

export const nvidiaNimProvider = cloudCatalogProvider("nvidia-nim", nvidiaNimSource, { envVars: ["NVIDIA_API_KEY", "NGC_API_KEY"] });

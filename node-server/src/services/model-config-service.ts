import { mkdir, readFile, rename, writeFile } from "node:fs/promises";
import { dirname, join } from "node:path";

import { ApiError } from "../errors.js";

const ENV_REFERENCE = /^\$[A-Z_][A-Z0-9_]*$/;
const THINKING_LEVELS = new Set(["off", "minimal", "low", "medium", "high", "xhigh", "max"]);

export class ModelConfigService {
  private readonly path: string;

  constructor(agentDir: string) { this.path = join(agentDir, "models.json"); }

  async read(): Promise<Record<string, unknown>> {
    try {
      const parsed: unknown = JSON.parse(await readFile(this.path, "utf8"));
      return this.sanitize(parsed);
    } catch { return { providers: {} }; }
  }

  async write(value: unknown): Promise<void> {
    const validated = this.validate(value);
    await mkdir(dirname(this.path), { recursive: true });
    const temporary = `${this.path}.${crypto.randomUUID()}.tmp`;
    await writeFile(temporary, `${JSON.stringify(validated, null, 2)}\n`, "utf8");
    await rename(temporary, this.path);
  }

  private sanitize(value: unknown): Record<string, unknown> {
    if (!this.isObject(value) || !this.isObject(value.providers)) return { providers: {} };
    const providers: Record<string, unknown> = {};
    for (const [name, candidate] of Object.entries(value.providers)) {
      if (!this.isObject(candidate)) continue;
      const provider: Record<string, unknown> = {};
      if (typeof candidate.api === "string") provider.api = candidate.api;
      if (typeof candidate.baseUrl === "string") provider.baseUrl = candidate.baseUrl;
      if (typeof candidate.apiKey === "string" && ENV_REFERENCE.test(candidate.apiKey)) provider.apiKey = candidate.apiKey;
      if (Array.isArray(candidate.models)) provider.models = candidate.models.filter(this.isObject).map((model) => ({ ...model }));
      providers[name] = provider;
    }
    return { providers };
  }

  private validate(value: unknown): Record<string, unknown> {
    if (!this.isObject(value) || !this.isObject(value.providers)) {
      throw new ApiError(422, "invalid_models_config", "models config must contain a providers object");
    }
    const providers: Record<string, unknown> = {};
    for (const [name, candidate] of Object.entries(value.providers)) {
      if (!name.trim() || !this.isObject(candidate)) {
        throw new ApiError(422, "invalid_models_config", "provider names must be non-empty and values must be objects");
      }
      const provider = { ...candidate };
      if (provider.apiKey !== undefined && (typeof provider.apiKey !== "string" || !ENV_REFERENCE.test(provider.apiKey))) {
        throw new ApiError(422, "invalid_models_config", `provider ${name} apiKey must reference an environment variable`);
      }
      if (provider.models !== undefined && !Array.isArray(provider.models)) {
        throw new ApiError(422, "invalid_models_config", `provider ${name} models must be an array`);
      }
      for (const model of (provider.models ?? [])) {
        if (!this.isObject(model) || typeof model.id !== "string" || !model.id.trim()) {
          throw new ApiError(422, "invalid_models_config", `provider ${name} models must contain non-empty ids`);
        }
        if (model.contextWindow !== undefined && (!Number.isInteger(model.contextWindow) || (model.contextWindow as number) <= 0)) {
          throw new ApiError(422, "invalid_models_config", `model ${name}:${model.id} contextWindow must be a positive integer`);
        }
        if (model.reasoning !== undefined && typeof model.reasoning !== "boolean") {
          throw new ApiError(422, "invalid_models_config", `model ${name}:${model.id} reasoning must be a boolean`);
        }
        if (model.thinkingLevels !== undefined && (!Array.isArray(model.thinkingLevels) || model.thinkingLevels.some((level) => typeof level !== "string" || !THINKING_LEVELS.has(level)))) {
          throw new ApiError(422, "invalid_models_config", `model ${name}:${model.id} contains an unsupported thinking level`);
        }
      }
      providers[name] = provider;
    }
    return { providers };
  }

  private isObject(value: unknown): value is Record<string, unknown> { return value !== null && typeof value === "object" && !Array.isArray(value); }
}

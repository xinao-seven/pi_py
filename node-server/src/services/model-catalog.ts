/** Original Pi model catalog adapter.
 *
 * 中文说明：模型、思考能力和默认选择均从原版 Pi SDK 读取；初始化禁用网络目录刷新，
 * 不会在加载 Vue 模型选择器时发出 Provider 请求。
 */

import { ModelRuntime, SettingsManager } from "@earendil-works/pi-coding-agent";
import { join } from "node:path";

const THINKING_LEVELS = ["off", "minimal", "low", "medium", "high", "xhigh", "max"];

export class ModelCatalogService {
  private runtimePromise: Promise<ModelRuntime> | undefined;

  constructor(private readonly agentDir: string, private readonly cwd: string) {}

  async catalog(): Promise<Record<string, unknown>> {
    const runtime = await this.getRuntime();
    const models = runtime.getModels();
    const settings = SettingsManager.create(this.cwd, this.agentDir);
    const configured = settings.getDefaultProvider() && settings.getDefaultModel()
      ? runtime.getModel(settings.getDefaultProvider()!, settings.getDefaultModel()!)
      : undefined;
    // 与 Pi 的 Session 初始化保持一致：默认设置仅在对应认证可用时生效，
    // 否则优先选择任一已认证 provider 的模型。
    const defaultModel = configured && runtime.hasConfiguredAuth(configured.provider)
      ? configured
      : models.find((model) => runtime.hasConfiguredAuth(model.provider)) ?? models[0];
    if (defaultModel === undefined) {
      return {
        models: {},
        modelList: [],
        defaultModel: { provider: "", modelId: "" },
        thinkingLevels: {},
        thinkingLevelMaps: {},
      };
    }
    const modelList = models.map((model) => ({
      id: model.id,
      name: model.name,
      provider: model.provider,
      contextWindow: model.contextWindow,
    }));
    const thinkingLevels = Object.fromEntries(models.map((model) => {
      const key = `${model.provider}:${model.id}`;
      const levels = model.reasoning ? THINKING_LEVELS : ["off"];
      return [key, levels];
    }));
    const thinkingLevelMaps = Object.fromEntries(models
      .filter((model) => model.thinkingLevelMap !== undefined)
      .map((model) => [`${model.provider}:${model.id}`, model.thinkingLevelMap]));
    return {
      models: Object.fromEntries(modelList.map((model) => [`${model.provider}:${model.id}`, model.name])),
      modelList,
      defaultModel: { provider: defaultModel.provider, modelId: defaultModel.id },
      thinkingLevels,
      thinkingLevelMaps,
    };
  }

  invalidate(): void { this.runtimePromise = undefined; }

  private getRuntime(): Promise<ModelRuntime> {
    this.runtimePromise ??= ModelRuntime.create({
      authPath: join(this.agentDir, "auth.json"),
      modelsPath: join(this.agentDir, "models.json"),
      allowModelNetwork: false,
    });
    return this.runtimePromise;
  }
}

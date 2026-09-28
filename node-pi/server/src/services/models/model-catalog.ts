/**
 * 原版 Pi 模型目录适配器。
 *
 * 中文说明：模型、思考能力、默认选择全部从原版 Pi SDK（ModelRuntime +
 * SettingsManager）读取。初始化时 allowModelNetwork: false，
 * 不会在加载 Vue 模型选择器时发出任何 Provider 网络请求。
 */

import { ModelRuntime, SettingsManager } from '@earendil-works/pi-coding-agent';
import { join } from 'node:path';

/** 全部可用的思考强度等级（Pi 语义）。 */
const THINKING_LEVELS = ['off', 'minimal', 'low', 'medium', 'high', 'xhigh', 'max'];

export class ModelCatalogService {
  /** ModelRuntime 是重量级对象，做单例缓存；invalidate() 后重建。 */
  private runtimePromise: Promise<ModelRuntime> | undefined;

  constructor(
    private readonly agentDir: string,
    private readonly cwd: string,
  ) {}

  /**
   * 生成前端模型选择器需要的完整目录结构。
   * 返回结构（与 Python 后端一致）：
   * - models: { "provider:modelId": "显示名" } 快捷映射；
   * - modelList: 完整模型列表（id/name/provider/contextWindow）；
   * - defaultModel: { provider, modelId }；
   * - thinkingLevels: { "provider:modelId": string[] } 各模型可选思考等级；
   * - thinkingLevelMaps: { "provider:modelId": map } 模型自身的等级映射。
   */
  async catalog(): Promise<Record<string, unknown>> {
    const runtime = await this.getRuntime();
    const models = runtime.getModels();
    // SettingsManager 读取 Pi 的 settings.json（用户配置的默认 provider/model）。
    const settings = SettingsManager.create(this.cwd, this.agentDir);
    const configured =
      settings.getDefaultProvider() && settings.getDefaultModel()
        ? runtime.getModel(settings.getDefaultProvider()!, settings.getDefaultModel()!)
        : undefined;
    // 与 Pi 的 Session 初始化保持一致：默认设置仅在对应认证可用时生效，
    // 否则优先选择任一已认证 provider 的模型，最后兜底 models[0]。
    const defaultModel =
      configured && runtime.hasConfiguredAuth(configured.provider)
        ? configured
        : (models.find((model) => runtime.hasConfiguredAuth(model.provider)) ?? models[0]);
    // 没有任何模型/认证（全新安装）时返回空目录，前端显示"无可用模型"。
    if (defaultModel === undefined) {
      return {
        models: {},
        modelList: [],
        defaultModel: { provider: '', modelId: '' },
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
    // 每个模型的思考等级：支持推理的模型才有完整等级列表，否则只有 "off"。
    const thinkingLevels = Object.fromEntries(
      models.map((model) => {
        const key = `${model.provider}:${model.id}`;
        const levels = model.reasoning ? THINKING_LEVELS : ['off'];
        return [key, levels];
      }),
    );
    // 模型自带的等级映射（如 "medium" → "思考预算 2048 tokens"），没有则省略。
    const thinkingLevelMaps = Object.fromEntries(
      models
        .filter((model) => model.thinkingLevelMap !== undefined)
        .map((model) => [`${model.provider}:${model.id}`, model.thinkingLevelMap]),
    );
    return {
      models: Object.fromEntries(
        modelList.map((model) => [`${model.provider}:${model.id}`, model.name]),
      ),
      modelList,
      defaultModel: { provider: defaultModel.provider, modelId: defaultModel.id },
      thinkingLevels,
      thinkingLevelMaps,
    };
  }

  /** 使目录缓存失效（models.json 修改后调用，下次 catalog() 重新读取）。 */
  invalidate(): void {
    this.runtimePromise = undefined;
  }

  /** 惰性创建并缓存 ModelRuntime（与 agent-registry 里的配置保持一致）。 */
  private getRuntime(): Promise<ModelRuntime> {
    this.runtimePromise ??= ModelRuntime.create({
      authPath: join(this.agentDir, 'auth.json'),
      modelsPath: join(this.agentDir, 'models.json'),
      allowModelNetwork: false, // 不从网络刷新模型目录（离线、隐私）
    });
    return this.runtimePromise;
  }
}

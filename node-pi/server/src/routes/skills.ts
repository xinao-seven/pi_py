/**
 * 技能（Skills）路由。
 *
 * 中文说明：为 Vue 的技能管理界面提供 技能列表 与 开关（disable-model-invocation）
 * 能力。技能是 Pi 的 SKILL.md 机制：放在工作区/.pi 下的 markdown 文件，
 * 模型可以读取其内容来获得领域知识或操作指引。
 *
 * Fastify 概念：
 * - GET/PATCH 同路径不同方法：分别处理"查询"与"修改"；
 * - PATCH 的 request.body 是部分更新字段，这里只接受 filePath + disableModelInvocation；
 * - handler 直接 return 对象会自动 JSON 序列化。
 */

import type { FastifyPluginAsync } from 'fastify';

import { ApiError } from '../errors.js';
import { AgentRegistry } from '../services/agent-registry.js';
import { SkillService } from '../services/skill-service.js';

/** 插件选项：技能服务 + 会话注册表（改完后需要刷新 Pi 的资源加载器）。 */
export const skillRoutes: FastifyPluginAsync<{
  service: SkillService;
  registry: AgentRegistry;
}> = async (app, options) => {
  // GET /api/skills?cwd=<工作区目录> —— 列出该工作区可见的所有技能。
  app.get<{ Querystring: { cwd?: string } }>('/api/skills', async (request) => {
    // cwd 必填且必须是已登记的工作区根目录（SkillService 内部校验）。
    if (!request.query.cwd) throw new ApiError(422, 'validation_error', 'cwd is required');
    return options.service.list(request.query.cwd);
  });

  // PATCH /api/skills —— 打开/关闭某个技能文件的模型调用能力。
  // 中文说明：disableModelInvocation 会写进 SKILL.md 的 YAML frontmatter，
  // 模型将不再自动加载该技能（但仍保留给人工阅读）。
  app.patch<{ Body: { filePath?: unknown; disableModelInvocation?: unknown } }>(
    '/api/skills',
    async (request) => {
      const { filePath, disableModelInvocation } = request.body ?? {};
      if (typeof filePath !== 'string' || typeof disableModelInvocation !== 'boolean') {
        throw new ApiError(
          422,
          'validation_error',
          'filePath and disableModelInvocation are required',
        );
      }
      await options.service.toggle(filePath, disableModelInvocation);
      // 修改后让所有活跃会话重新加载技能/资源，使新配置立即生效。
      await options.registry.reloadResources();
      return { success: true };
    },
  );
};

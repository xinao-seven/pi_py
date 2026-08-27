/**
 * 会话预设（Preset）的 REST 路由。
 *
 * 中文说明：为前端设置页提供预设的增删改查。校验集中在 PresetService 的
 * parsePresetInput（写方向），路由层保持薄，只做转发。
 */

import type { FastifyPluginAsync } from 'fastify';

import { PresetService } from '../services/preset-service.js';

/** 注册 presetRoutes 插件时所需的选项（由 app.ts 传入）。 */
export interface PresetRouteOptions {
  service: PresetService;
}

export const presetRoutes: FastifyPluginAsync<PresetRouteOptions> = async (app, options) => {
  // GET /api/presets —— 全部预设（内置 coding-agent + 自定义）。
  app.get('/', async () => ({ presets: await options.service.list() }));

  // POST /api/presets —— 新建自定义预设。
  app.post('/', async (request) => {
    const preset = await options.service.create(request.body);
    return { success: true, preset };
  });

  // PATCH /api/presets/:id —— 覆盖更新自定义预设（内置预设被服务层拒绝）。
  app.patch<{ Params: { id: string } }>('/:id', async (request) => {
    const preset = await options.service.update(request.params.id, request.body);
    return { success: true, preset };
  });

  // DELETE /api/presets/:id —— 删除自定义预设（内置预设被服务层拒绝）。
  app.delete<{ Params: { id: string } }>('/:id', async (request) => {
    await options.service.delete(request.params.id);
    return { success: true };
  });
};

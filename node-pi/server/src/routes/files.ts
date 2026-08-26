/**
 * 工作区文件浏览路由。
 *
 * 中文说明：为 Vue 的文件浏览器提供 目录列表 / 文本预览 / 图片媒体 三种能力，
 * 全部限定在用户登记过的工作区根目录内（越权保护在 FileService 中实现）。
 *
 * Fastify 概念：
 * - 通配路径参数："/\*" 会把路径剩余部分捕获到 request.params["*"]，
 *   例如 GET /api/files/a/b/c.txt → params["*"] === "a/b/c.txt"；
 * - 查询参数：request.query 由 Fastify 自动解析 URL 查询串（?root=...&type=...），
 *   尖括号泛型里声明了 Querystring 的类型；
 * - reply.type(mime).send(buffer)：显式设置 Content-Type 后发送二进制内容。
 */

import type { FastifyPluginAsync } from 'fastify';

import { ApiError } from '../errors.js';
import { FileService } from '../services/file-service.js';

/** 插件选项：文件服务实例（由 app.ts 传入，可注入 mock）。 */
export const fileRoutes: FastifyPluginAsync<{ service: FileService }> = async (app, options) => {
  // GET /api/files/*?root=<工作区根目录>&type=list|read|media
  app.get<{
    Params: { '*': string };
    Querystring: { root?: string; type?: string };
  }>('/*', async (request, reply) => {
    // root 必填：前端必须显式指定从哪个工作区根目录开始浏览。
    const root = request.query.root;
    if (!root) throw new ApiError(422, 'validation_error', 'root is required');
    // 通配符捕获的路径，相对 root 的路径（空串表示根目录本身）。
    const path = request.params['*'] ?? '';
    // type 决定操作：list 列目录 / read 读文本 / media 读二进制媒体。
    switch (request.query.type ?? 'list') {
      case 'list':
        return options.service.list(path, root);
      case 'read':
        return options.service.readText(path, root);
      case 'media': {
        const media = await options.service.media(path, root);
        // reply.type() 设置 Content-Type，然后 send Buffer 内容（图片/音频原样返回）。
        return reply.type(media.mimeType).send(media.content);
      }
      default:
        throw new ApiError(422, 'validation_error', 'type must be list, read, or media');
    }
  });
};

/**
 * 工作区文件服务：目录列表 / 文本预览 / 媒体预览。
 *
 * 中文说明：为前端文件浏览器提供能力，安全模型是"一切操作都被限制在用户
 * 登记过的工作区根目录内"：
 * - 根目录必须是已登记的 workspace（roots() 校验）；
 * - 解析后的路径必须仍在根目录内（防 ../ 路径穿越）；
 * - 敏感文件/目录（.env、.ssh、密钥、凭据等）一律拒绝预览；
 * - 大文件超限（文本 256KB / 媒体 10MB）拒绝，防止内存被打爆。
 */

import { readFile, readdir, realpath, stat } from 'node:fs/promises';
import { extname, relative, resolve } from 'node:path';

import { ApiError } from '../errors.js';
import { WorkspaceService } from './workspace-service.js';

// 列表时直接隐藏的目录名（构建产物、依赖、缓存、版本控制等）。
const IGNORED_NAMES = new Set([
  'node_modules',
  '.git',
  '.next',
  'dist',
  'build',
  '__pycache__',
  '.turbo',
  '.cache',
  'coverage',
  '.pytest_cache',
  '.mypy_cache',
  'target',
  'vendor',
  '.ds_store',
]);
// 目录级敏感名单：位于这些目录内的任何文件都不可预览。
const SENSITIVE_DIRECTORIES = new Set(['.ssh', '.aws', '.azure', '.gnupg']);
// 文件名级敏感名单（含 .env.* 前缀匹配与 *.pyc 后缀匹配）。
const SENSITIVE_NAMES = new Set(['.env', 'secrets.env', 'credentials', 'credentials.json']);
const SENSITIVE_SUFFIXES = new Set(['.pem', '.key', '.p12', '.pfx']);
// 预览体积上限：文本 256KB，媒体 10MB。
const TEXT_LIMIT = 256 * 1024;
const MEDIA_LIMIT = 10 * 1024 * 1024;

// 扩展名 → 语法高亮语言（前端代码预览用）。
const LANGUAGES: Record<string, string> = {
  '.ts': 'typescript',
  '.tsx': 'typescript',
  '.js': 'javascript',
  '.jsx': 'javascript',
  '.mjs': 'javascript',
  '.cjs': 'javascript',
  '.py': 'python',
  '.go': 'go',
  '.rs': 'rust',
  '.java': 'java',
  '.html': 'html',
  '.css': 'css',
  '.json': 'json',
  '.yaml': 'yaml',
  '.yml': 'yaml',
  '.toml': 'toml',
  '.md': 'markdown',
  '.sh': 'bash',
  '.sql': 'sql',
};

/** 目录列表中的单个条目。 */
export interface FileEntry {
  name: string;
  isDir: boolean;
  size: number; // 字节数（目录为 0）
  modified: string; // ISO 时间字符串
}

export class FileService {
  constructor(private readonly workspaces: WorkspaceService) {}

  /** 列出目录内容：过滤忽略项，目录优先、再按名称排序。 */
  async list(path: string, root: string): Promise<{ entries: FileEntry[]; path: string }> {
    const target = await this.resolve(path, root);
    const targetStat = await this.fileStat(target, 'Directory');
    if (!targetStat.isDirectory())
      throw new ApiError(400, 'not_a_directory', 'Path is not a directory');
    const entries = await readdir(target, { withFileTypes: true });
    // 并行 stat 每个条目拿大小/修改时间；个别条目 stat 失败（权限/已被删除）
    // 时跳过而不是让整个请求失败。
    const result = await Promise.all(
      entries
        .filter((entry) => !this.ignored(entry.name))
        .map(async (entry) => {
          try {
            const item = await stat(resolve(target, entry.name));
            return {
              name: entry.name,
              isDir: entry.isDirectory(),
              size: entry.isFile() ? item.size : 0,
              modified: item.mtime.toISOString(),
            };
          } catch {
            return undefined;
          }
        }),
    );
    return {
      // 排序：目录在前（isDir 1 > 0），同类型按名称字典序。
      entries: result
        .filter((entry): entry is FileEntry => entry !== undefined)
        .sort(
          (left, right) =>
            Number(right.isDir) - Number(left.isDir) || left.name.localeCompare(right.name),
        ),
      path: target,
    };
  }

  /** 读取文本文件预览：返回内容 + 高亮语言 + 大小。 */
  async readText(
    path: string,
    root: string,
  ): Promise<{ content: string; language: string; size: number }> {
    const target = await this.resolve(path, root);
    const info = await this.fileStat(target, 'File');
    if (!info.isFile()) throw new ApiError(400, 'not_a_file', 'Path is not a file');
    if (info.size > TEXT_LIMIT)
      throw new ApiError(413, 'file_too_large', `Text preview exceeds ${TEXT_LIMIT} bytes`);
    // 按 UTF-8 读取；非文本（二进制）文件会抛 ERR_INVALID_ARG_VALUE 之类的
    // 解码错误，这里转成 415（不支持的媒体类型）。
    const content = await readFile(target, 'utf8').catch((error: NodeJS.ErrnoException) => {
      if (error.code === 'ERR_INVALID_ARG_VALUE') throw error;
      throw new ApiError(415, 'binary_file', 'File is not valid UTF-8 text');
    });
    return { content, language: this.language(target), size: info.size };
  }

  /** 读取二进制媒体（图片/音频）预览：返回 Buffer + MIME 类型。 */
  async media(path: string, root: string): Promise<{ content: Buffer; mimeType: string }> {
    const target = await this.resolve(path, root);
    const info = await this.fileStat(target, 'File');
    if (!info.isFile()) throw new ApiError(400, 'not_a_file', 'Path is not a file');
    const mimeType = this.mimeType(target);
    if (mimeType === undefined)
      throw new ApiError(415, 'unsupported_media', 'File is not previewable media');
    if (info.size > MEDIA_LIMIT)
      throw new ApiError(413, 'file_too_large', `Media preview exceeds ${MEDIA_LIMIT} bytes`);
    return { content: await readFile(target), mimeType };
  }

  /**
   * 路径解析 + 安全校验（所有读操作的第一步）。
   * 流程：根目录必须是已登记工作区 → 拼接目标路径 → 防穿越检查 →
   * realpath 解析真实路径（防符号链接逃逸）→ 二次防穿越 + 敏感文件检查。
   */
  private async resolve(path: string, rootInput: string): Promise<string> {
    const roots = await this.workspaces.roots();
    let root: string;
    try {
      root = await realpath(rootInput);
    } catch {
      throw new ApiError(403, 'root_not_allowed', 'Workspace root is not allowed');
    }
    // 根目录必须属于已登记工作区（大小写不敏感比较，Windows 路径不分大小写）。
    if (!roots.some((item) => this.samePath(item, root))) {
      throw new ApiError(403, 'root_not_allowed', 'Workspace root is not allowed');
    }
    // 第一次拼接与穿越检查（resolve 会规范化 ../）。
    const candidate = resolve(root, path || '.');
    const candidateRemainder = relative(root, candidate);
    if (candidateRemainder.startsWith('..') || candidateRemainder.includes(':')) {
      throw new ApiError(403, 'path_outside_workspace', 'Path escapes the selected workspace');
    }
    // realpath 解析符号链接/快捷方式到真实位置，防止通过链接指向根目录之外。
    let target: string;
    try {
      target = await realpath(candidate);
    } catch {
      throw new ApiError(404, 'file_not_found', 'File was not found');
    }
    const remainder = relative(root, target);
    if (remainder.startsWith('..') || remainder.includes(':')) {
      throw new ApiError(403, 'path_outside_workspace', 'Path escapes the selected workspace');
    }
    // 敏感文件（.env / .ssh 下 / 密钥后缀等）拒绝预览。
    if (this.sensitive(remainder))
      throw new ApiError(403, 'sensitive_file', 'Sensitive files cannot be previewed');
    return target;
  }

  /** stat 封装：文件不存在统一转 404。 */
  private async fileStat(path: string, label: string) {
    try {
      return await stat(path);
    } catch {
      throw new ApiError(404, 'file_not_found', `${label} was not found`);
    }
  }

  /** Windows 路径比较（大小写不敏感）。 */
  private samePath(left: string, right: string): boolean {
    return left.toLocaleLowerCase() === right.toLocaleLowerCase();
  }

  /** 列表时是否隐藏该名称（忽略目录 / 敏感文件 / .env.* / *.pyc / 密钥后缀）。 */
  private ignored(name: string): boolean {
    const lower = name.toLocaleLowerCase();
    return (
      IGNORED_NAMES.has(lower) ||
      SENSITIVE_NAMES.has(lower) ||
      lower.startsWith('.env.') ||
      lower.endsWith('.pyc') ||
      SENSITIVE_SUFFIXES.has(extname(lower))
    );
  }

  /** 相对路径是否命中敏感规则（目录级 + 文件级 + .git/config 组合）。 */
  private sensitive(relativePath: string): boolean {
    const parts = relativePath.split(/[\\/]/).map((part) => part.toLocaleLowerCase());
    const name = parts.at(-1) ?? '';
    return (
      parts.some((part) => SENSITIVE_DIRECTORIES.has(part)) ||
      SENSITIVE_NAMES.has(name) ||
      name.startsWith('.env.') ||
      SENSITIVE_SUFFIXES.has(extname(name)) ||
      (name === 'config' && parts.includes('.git'))
    );
  }

  /** 扩展名 → 高亮语言；未知返回 "text"。 */
  private language(path: string): string {
    return LANGUAGES[extname(path).toLocaleLowerCase()] ?? 'text';
  }

  /** 扩展名 → MIME 类型（图片 + 音频）；未知返回 undefined。 */
  private mimeType(path: string): string | undefined {
    const extension = extname(path).toLocaleLowerCase();
    const image: Record<string, string> = {
      '.png': 'image/png',
      '.jpg': 'image/jpeg',
      '.jpeg': 'image/jpeg',
      '.gif': 'image/gif',
      '.webp': 'image/webp',
      '.svg': 'image/svg+xml',
      '.bmp': 'image/bmp',
      '.ico': 'image/x-icon',
    };
    const audio: Record<string, string> = {
      '.mp3': 'audio/mpeg',
      '.wav': 'audio/wav',
      '.ogg': 'audio/ogg',
      '.m4a': 'audio/mp4',
      '.aac': 'audio/aac',
      '.flac': 'audio/flac',
    };
    return image[extension] ?? audio[extension];
  }
}

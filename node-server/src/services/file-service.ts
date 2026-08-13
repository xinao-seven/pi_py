import { readFile, readdir, realpath, stat } from "node:fs/promises";
import { extname, relative, resolve } from "node:path";

import { ApiError } from "../errors.js";
import { WorkspaceService } from "./workspace-service.js";

const IGNORED_NAMES = new Set(["node_modules", ".git", ".next", "dist", "build", "__pycache__", ".turbo", ".cache", "coverage", ".pytest_cache", ".mypy_cache", "target", "vendor", ".ds_store"]);
const SENSITIVE_DIRECTORIES = new Set([".ssh", ".aws", ".azure", ".gnupg"]);
const SENSITIVE_NAMES = new Set([".env", "secrets.env", "credentials", "credentials.json"]);
const SENSITIVE_SUFFIXES = new Set([".pem", ".key", ".p12", ".pfx"]);
const TEXT_LIMIT = 256 * 1024;
const MEDIA_LIMIT = 10 * 1024 * 1024;

const LANGUAGES: Record<string, string> = {
  ".ts": "typescript", ".tsx": "typescript", ".js": "javascript", ".jsx": "javascript", ".mjs": "javascript", ".cjs": "javascript",
  ".py": "python", ".go": "go", ".rs": "rust", ".java": "java", ".html": "html", ".css": "css", ".json": "json",
  ".yaml": "yaml", ".yml": "yaml", ".toml": "toml", ".md": "markdown", ".sh": "bash", ".sql": "sql",
};

export interface FileEntry {
  name: string;
  isDir: boolean;
  size: number;
  modified: string;
}

export class FileService {
  constructor(private readonly workspaces: WorkspaceService) {}

  async list(path: string, root: string): Promise<{ entries: FileEntry[]; path: string }> {
    const target = await this.resolve(path, root);
    const targetStat = await this.fileStat(target, "Directory");
    if (!targetStat.isDirectory()) throw new ApiError(400, "not_a_directory", "Path is not a directory");
    const entries = await readdir(target, { withFileTypes: true });
    const result = await Promise.all(entries
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
      }));
    return {
      entries: result.filter((entry): entry is FileEntry => entry !== undefined)
        .sort((left, right) => Number(right.isDir) - Number(left.isDir) || left.name.localeCompare(right.name)),
      path: target,
    };
  }

  async readText(path: string, root: string): Promise<{ content: string; language: string; size: number }> {
    const target = await this.resolve(path, root);
    const info = await this.fileStat(target, "File");
    if (!info.isFile()) throw new ApiError(400, "not_a_file", "Path is not a file");
    if (info.size > TEXT_LIMIT) throw new ApiError(413, "file_too_large", `Text preview exceeds ${TEXT_LIMIT} bytes`);
    const content = await readFile(target, "utf8").catch((error: NodeJS.ErrnoException) => {
      if (error.code === "ERR_INVALID_ARG_VALUE") throw error;
      throw new ApiError(415, "binary_file", "File is not valid UTF-8 text");
    });
    return { content, language: this.language(target), size: info.size };
  }

  async media(path: string, root: string): Promise<{ content: Buffer; mimeType: string }> {
    const target = await this.resolve(path, root);
    const info = await this.fileStat(target, "File");
    if (!info.isFile()) throw new ApiError(400, "not_a_file", "Path is not a file");
    const mimeType = this.mimeType(target);
    if (mimeType === undefined) throw new ApiError(415, "unsupported_media", "File is not previewable media");
    if (info.size > MEDIA_LIMIT) throw new ApiError(413, "file_too_large", `Media preview exceeds ${MEDIA_LIMIT} bytes`);
    return { content: await readFile(target), mimeType };
  }

  private async resolve(path: string, rootInput: string): Promise<string> {
    const roots = await this.workspaces.roots();
    let root: string;
    try { root = await realpath(rootInput); } catch { throw new ApiError(403, "root_not_allowed", "Workspace root is not allowed"); }
    if (!roots.some((item) => this.samePath(item, root))) {
      throw new ApiError(403, "root_not_allowed", "Workspace root is not allowed");
    }
    const candidate = resolve(root, path || ".");
    const candidateRemainder = relative(root, candidate);
    if (candidateRemainder.startsWith("..") || candidateRemainder.includes(":")) {
      throw new ApiError(403, "path_outside_workspace", "Path escapes the selected workspace");
    }
    let target: string;
    try { target = await realpath(candidate); } catch { throw new ApiError(404, "file_not_found", "File was not found"); }
    const remainder = relative(root, target);
    if (remainder.startsWith("..") || remainder.includes(":")) {
      throw new ApiError(403, "path_outside_workspace", "Path escapes the selected workspace");
    }
    if (this.sensitive(remainder)) throw new ApiError(403, "sensitive_file", "Sensitive files cannot be previewed");
    return target;
  }

  private async fileStat(path: string, label: string) {
    try { return await stat(path); } catch { throw new ApiError(404, "file_not_found", `${label} was not found`); }
  }

  private samePath(left: string, right: string): boolean { return left.toLocaleLowerCase() === right.toLocaleLowerCase(); }
  private ignored(name: string): boolean {
    const lower = name.toLocaleLowerCase();
    return IGNORED_NAMES.has(lower) || SENSITIVE_NAMES.has(lower) || lower.startsWith(".env.") || lower.endsWith(".pyc") || SENSITIVE_SUFFIXES.has(extname(lower));
  }
  private sensitive(relativePath: string): boolean {
    const parts = relativePath.split(/[\\/]/).map((part) => part.toLocaleLowerCase());
    const name = parts.at(-1) ?? "";
    return parts.some((part) => SENSITIVE_DIRECTORIES.has(part)) || SENSITIVE_NAMES.has(name) || name.startsWith(".env.") || SENSITIVE_SUFFIXES.has(extname(name)) || (name === "config" && parts.includes(".git"));
  }
  private language(path: string): string { return LANGUAGES[extname(path).toLocaleLowerCase()] ?? "text"; }
  private mimeType(path: string): string | undefined {
    const extension = extname(path).toLocaleLowerCase();
    const image: Record<string, string> = { ".png": "image/png", ".jpg": "image/jpeg", ".jpeg": "image/jpeg", ".gif": "image/gif", ".webp": "image/webp", ".svg": "image/svg+xml", ".bmp": "image/bmp", ".ico": "image/x-icon" };
    const audio: Record<string, string> = { ".mp3": "audio/mpeg", ".wav": "audio/wav", ".ogg": "audio/ogg", ".m4a": "audio/mp4", ".aac": "audio/aac", ".flac": "audio/flac" };
    return image[extension] ?? audio[extension];
  }
}

/**
 * trace 的脱敏与内容摘要。
 *
 * 中文说明：trace 的默认口径是「只存结论，不存正文」——参数与结果只落
 * `sha256(内容).slice(0,12)` 的 digest、字节数与 120 字符的预览。需要正文调试时
 * 才显式打开 `PI_NODE_TRACE_CONTENT=1`。
 *
 * 三层防护：
 * 1. 键名命中密钥模式（apiKey / authorization / token / password / privateKey …）→ 整个值替换；
 * 2. 值里出现密钥形态（sk-、Bearer、ghp_、AKIA、xoxb-、私钥块）→ 替换；
 * 3. 大字符串不参与全文扫描（避免把事件循环拖住），只脱敏预览用到的前缀，
 *    digest 输入也封顶。
 */

import { createHash } from 'node:crypto';

/** 被脱敏后的占位文本。 */
export const REDACTED = '[redacted]';

/** 命中即整值替换的键名（大小写不敏感）。 */
const SECRET_KEY =
  /^(api[-_]?key|apikey|authorization|auth|access[-_]?token|refresh[-_]?token|id[-_]?token|token|secret|client[-_]?secret|password|passwd|credential|credentials|cookie|set[-_]?cookie|private[-_]?key)$/i;

/** 值里出现的密钥形态。 */
const SECRET_VALUE =
  /(sk-[A-Za-z0-9_-]{6,}|Bearer\s+[A-Za-z0-9._~+/=-]{8,}|gh[pousr]_[A-Za-z0-9]{10,}|xox[abpr]-[A-Za-z0-9-]{10,}|AKIA[0-9A-Z]{8,}|-----BEGIN [A-Z ]*PRIVATE KEY-----)/g;

/** 全文脱敏扫描的字符上限（超过只扫描/脱敏前缀）。 */
const MAX_SCAN_CHARS = 64 * 1024;
/** digest 输入的字符上限（超出即标记 truncated）。 */
const MAX_DIGEST_CHARS = 256 * 1024;
/** `PI_NODE_TRACE_CONTENT=1` 时保留的正文上限。 */
const MAX_CONTENT_CHARS = 8 * 1024;
/** 预览长度。 */
const PREVIEW_CHARS = 120;
/** 递归深度上限（防止深层结构拖慢事件回调）。 */
const MAX_DEPTH = 6;
/** 数组元素上限。 */
const MAX_ITEMS = 100;

export interface SummarizeOptions {
  /** 是否保留正文（PI_NODE_TRACE_CONTENT=1）。 */
  content?: boolean;
}

/** 一份内容的可落库摘要。 */
export interface ContentSummary {
  digest: string;
  bytes: number;
  preview: string;
  truncated: boolean;
  /** 仅当 options.content 为真时存在，且已脱敏、已截断。 */
  text?: string;
}

/** 文本脱敏（密钥形态替换）。 */
export function redactText(text: string): string {
  return text.replace(SECRET_VALUE, REDACTED);
}

/**
 * 递归脱敏任意 JSON 值。
 * 中文说明：字符串按大小分层——小字符串全文脱敏，大字符串只脱敏前缀（预览用），
 * 其余部分不扫描但也不会被落库（digest 是单向哈希）。
 */
export function redactValue(value: unknown, depth = 0): unknown {
  if (depth > MAX_DEPTH) return '[depth-limit]';
  if (typeof value === 'string') {
    const head = redactText(value.slice(0, MAX_SCAN_CHARS));
    return value.length > MAX_SCAN_CHARS ? `${head}…` : head;
  }
  if (Array.isArray(value)) {
    return value.slice(0, MAX_ITEMS).map((item) => redactValue(item, depth + 1));
  }
  if (value !== null && typeof value === 'object') {
    const result: Record<string, unknown> = {};
    for (const [key, item] of Object.entries(value)) {
      result[key] = SECRET_KEY.test(key) ? REDACTED : redactValue(item, depth + 1);
    }
    return result;
  }
  return value;
}

/** 安全序列化（循环引用/不可序列化对象退化为 String()）。 */
export function safeStringify(value: unknown): string {
  if (typeof value === 'string') return value;
  if (value === undefined) return '';
  try {
    const text = JSON.stringify(value);
    return text === undefined ? String(value) : text;
  } catch {
    return String(value);
  }
}

/** 稳定 digest：sha256 前 12 位十六进制。 */
export function digestOf(text: string): string {
  return createHash('sha256').update(text).digest('hex').slice(0, 12);
}

/**
 * 生成「可落库的内容摘要」：digest + 字节数 + 预览（+ 可选的脱敏正文）。
 * 中文说明：bytes 反映原始内容大小（用于诊断「参数有多大」），digest 与 preview
 * 都基于脱敏后的内容，因此不会把密钥带进库里。
 */
export function summarize(value: unknown, options: SummarizeOptions = {}): ContentSummary {
  const raw = safeStringify(value);
  const redacted = safeStringify(redactValue(value));
  const summary: ContentSummary = {
    digest: digestOf(redacted.slice(0, MAX_DIGEST_CHARS)),
    bytes: Buffer.byteLength(raw, 'utf8'),
    preview: redacted.replace(/\s+/g, ' ').trim().slice(0, PREVIEW_CHARS),
    truncated: raw.length > MAX_DIGEST_CHARS,
  };
  if (options.content) summary.text = redacted.slice(0, MAX_CONTENT_CHARS);
  return summary;
}

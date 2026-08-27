/**
 * 服务层共享的结构化日志接口。
 *
 * 中文说明：刻意只声明四个方法（而不是直接依赖 pino 类型），让 services/ 保持
 * 不依赖 Fastify/pino 的原则；Fastify 实例的 app.log（内部即 pino logger）
 * 在结构上天然满足本接口，app.ts 装配时直接传入即可。不传则各服务静默运行，
 * 单元测试无需任何处理。
 */
export interface ServiceLogger {
  debug(obj: object, msg?: string): void;
  info(obj: object, msg?: string): void;
  warn(obj: object, msg?: string): void;
  error(obj: object, msg?: string): void;
}

/** 把任意值序列化成限长的预览文本（避免大参数把日志撑爆）。 */
export function previewOf(value: unknown, max = 600): string {
  let text: string;
  try {
    text = JSON.stringify(value);
  } catch {
    text = String(value);
  }
  if (text === undefined) text = '';
  return text.length > max ? `${text.slice(0, max)}...(truncated)` : text;
}

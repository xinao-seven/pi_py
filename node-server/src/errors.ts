/**
 * 统一的 HTTP 错误响应格式（错误信封）。
 *
 * 中文说明：与现有 FastAPI 后端保持完全相同的错误响应结构，这样 Vue 前端
 * 无论切换到 Python 后端还是 Node 后端，解析错误响应的代码都不用改。
 *
 * Fastify 相关：Fastify 允许路由处理函数直接 `throw` 任意 Error，抛出的错误
 * 会被我们在 app.ts 里用 `app.setErrorHandler()` 注册的全局错误处理器统一捕获。
 * `ApiError` 就是本项目自定义的"业务错误"类型：全局错误处理器识别到它时，
 * 会返回它携带的 HTTP 状态码和错误体；其他未知错误则统一返回 500。
 */

/** 业务错误类型：携带 HTTP 状态码 + 稳定的错误码字符串。 */
export class ApiError extends Error {
  constructor(
    readonly statusCode: number, // HTTP 状态码，如 400 / 404 / 409 / 422 / 503
    readonly code: string,       // 稳定的错误码，供前端程序化判断（如 "validation_error"）
    message: string,             // 人类可读的错误描述
    readonly details?: unknown,  // 可选的附加结构化信息（调试用）
  ) {
    super(message);
    this.name = "ApiError";
  }
}

/**
 * 构造与 FastAPI 后端一致的错误响应体：{ error: { code, message, details? } }。
 *
 * 中文说明：details 为 undefined 时不输出该字段（保持响应体精简且与 Python 后端一致）。
 */
export function errorPayload(code: string, message: string, details?: unknown) {
  return {
    error: {
      code,
      message,
      ...(details === undefined ? {} : { details }),
    },
  };
}

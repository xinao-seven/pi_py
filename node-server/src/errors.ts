/** Stable HTTP error envelope.
 *
 * 中文说明：与现有 FastAPI 服务保持相同的错误响应格式，Vue 前端无需区分后端实现。
 */

export class ApiError extends Error {
  constructor(
    readonly statusCode: number,
    readonly code: string,
    message: string,
    readonly details?: unknown,
  ) {
    super(message);
    this.name = "ApiError";
  }
}

export function errorPayload(code: string, message: string, details?: unknown) {
  return {
    error: {
      code,
      message,
      ...(details === undefined ? {} : { details }),
    },
  };
}

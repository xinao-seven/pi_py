// 后端地址解析：uTools 插件由 preload 注入 window.piBackend.baseUrl；
// 浏览器端默认同源（空串），构建时可注入 VITE_BACKEND_URL 兜底。
// 默认保持空串，对现有 dev（Vite 代理）与生产（FastAPI 同源托管）零回归。
interface PiBackendBridge {
  baseUrl?: string;
}

declare global {
  interface Window {
    piBackend?: PiBackendBridge;
  }
}

const injected = typeof window !== "undefined" ? window.piBackend?.baseUrl : undefined;
const fromEnv = import.meta.env.VITE_BACKEND_URL as string | undefined;

export const BASE_URL = (injected ?? fromEnv ?? "").trim().replace(/\/+$/, "");

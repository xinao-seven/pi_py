// Pi 桌面助手（uTools 插件）预加载脚本
// 职责：同步注入后端地址，异步确保 node-pi/server 运行。
// 仅使用 Node 内置模块，代码保持可读（uTools preload 规范）。

const { spawn } = require("node:child_process");
const fs = require("node:fs");
const http = require("node:http");
const os = require("node:os");
const path = require("node:path");

// 配置文件：%USERPROFILE%\.pi\agent\utools-config.json（首次运行自动生成）
const CONFIG_PATH = path.join(os.homedir(), ".pi", "agent", "utools-config.json");

const DEFAULTS = {
  // node-pi/server 目录（需已 `npm install` 且 `npm run build` 产出 dist/server.js）
  serverDir: process.env.PI_UTOOLS_SERVER_DIR || "D:/code/pi_py/node-pi/server",
  port: 8001,
};

function readConfig() {
  try {
    const parsed = JSON.parse(fs.readFileSync(CONFIG_PATH, "utf8"));
    return { ...DEFAULTS, ...parsed };
  } catch (_) {
    try {
      fs.mkdirSync(path.dirname(CONFIG_PATH), { recursive: true });
      fs.writeFileSync(CONFIG_PATH, JSON.stringify(DEFAULTS, null, 2));
    } catch (_) {}
    return DEFAULTS;
  }
}

function healthCheck(port, timeoutMs) {
  return new Promise((resolve) => {
    const req = http.get(
      { host: "127.0.0.1", port, path: "/api/health", timeout: timeoutMs },
      (res) => {
        res.resume();
        resolve(res.statusCode === 200);
      },
    );
    req.on("error", () => resolve(false));
    req.on("timeout", () => {
      req.destroy();
      resolve(false);
    });
  });
}

function startServer(config) {
  const entry = path.join(config.serverDir, "dist", "server.js");
  if (!fs.existsSync(entry)) {
    console.error("[pi-utools] 未找到 node-pi/server 构建产物:", entry);
    console.error("[pi-utools] 请先执行: cd node-pi/server && npm run build");
    return false;
  }
  const child = spawn("node", [entry], {
    cwd: config.serverDir,
    env: {
      ...process.env,
      PI_NODE_SERVER_HOST: "127.0.0.1",
      PI_NODE_SERVER_PORT: String(config.port),
    },
    windowsHide: true,
    stdio: "ignore",
  });
  child.on("error", (err) => console.error("[pi-utools] 启动后端失败:", err));
  return true;
}

function ensureServerRunning(config) {
  let started = false;
  const tick = async () => {
    if (await healthCheck(config.port, 1500)) return;
    if (!started) {
      started = true;
      startServer(config);
    }
    setTimeout(tick, 1000);
  };
  tick();
}

// 同步注入（在页面脚本执行前完成），保证前端 config.ts 能读到正确地址
const config = readConfig();
window.piBackend = { baseUrl: `http://127.0.0.1:${config.port}` };

// 异步拉起后端（前端自身带 2s 重试，短暂未就绪可自动恢复）
ensureServerRunning(config);

/** Node server entry point.
 *
 * 中文说明：单独监听 8001，便于现有 Vue 通过 VITE_BACKEND_URL 在 Python 与 Node 后端间切换。
 */

import { createApp } from "./app.js";
import { readServerConfig } from "./config.js";

const config = readServerConfig();
const app = createApp({ agentDir: config.agentDir, workspaceParent: config.workspaceParent });

try {
  await app.listen(config);
} catch (error) {
  // Fastify logging is disabled for the web-facing app, but startup failures
  // must remain visible to the development launcher.
  console.error("Node Pi backend failed to start:", error);
  process.exit(1);
}

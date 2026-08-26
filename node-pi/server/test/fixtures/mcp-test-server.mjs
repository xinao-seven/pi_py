// 本地 stdio MCP 测试 server：暴露 echo / add / fail 三个工具，供集成测试验证连接与调用。
import { Server } from "@modelcontextprotocol/sdk/server/index.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import {
  CallToolRequestSchema,
  ListToolsRequestSchema,
} from "@modelcontextprotocol/sdk/types.js";

const server = new Server({ name: "mcp-test-server", version: "1.0.0" }, { capabilities: { tools: {} } });

server.setRequestHandler(ListToolsRequestSchema, async () => ({
  tools: [
    {
      name: "echo",
      description: "回显输入文本",
      inputSchema: {
        type: "object",
        properties: { text: { type: "string" } },
        required: ["text"],
      },
    },
    {
      name: "add",
      description: "两数相加",
      inputSchema: {
        type: "object",
        properties: { a: { type: "number" }, b: { type: "number" } },
        required: ["a", "b"],
      },
    },
    {
      name: "fail",
      description: "总是失败的工具",
      inputSchema: { type: "object", properties: {} },
    },
  ],
}));

server.setRequestHandler(CallToolRequestSchema, async (request) => {
  const { name, arguments: args } = request.params;
  if (name === "echo") return { content: [{ type: "text", text: String(args?.text ?? "") }] };
  if (name === "add") return { content: [{ type: "text", text: String(Number(args?.a ?? 0) + Number(args?.b ?? 0)) }] };
  if (name === "fail") return { isError: true, content: [{ type: "text", text: "boom: intentional failure" }] };
  return { isError: true, content: [{ type: "text", text: `unknown tool: ${name}` }] };
});

await server.connect(new StdioServerTransport());

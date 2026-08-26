/**
 * mcp-tools 纯函数单测：结果映射与输出截断。
 */
import { describe, expect, it } from "vitest";

import { mcpResultToPi } from "../../src/services/mcp/mcp-tools.js";

function textResult(text: string) {
  return mcpResultToPi({ content: [{ type: "text", text }] } as never);
}

describe("mcpResultToPi", () => {
  it("短输出原样返回单个 text 块", () => {
    const result = textResult("ok");
    expect(result.content).toEqual([{ type: "text", text: "ok" }]);
  });

  it("超长输出被截断并附 [Truncated] 标记", () => {
    const huge = Array.from({ length: 3000 }, (_, index) => `line ${index}`).join("\n");
    const result = textResult(huge);
    const block = result.content[0] as { type: "text"; text: string };
    expect(block.text).toMatch(/\[Truncated: showing \d+ of 3000 lines\]/);
    // 截断后保留约 2000 行（远少于原始 3000 行）
    expect(block.text.split("\n").length).toBeLessThan(3000);
  });

  it("isError 时抛错（与 bash 失败惯例一致）", () => {
    expect(() =>
      mcpResultToPi({ content: [{ type: "text", text: "boom" }], isError: true } as never),
    ).toThrow(/boom/);
  });
});

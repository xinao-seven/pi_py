import { mount } from "@vue/test-utils";

import type { PendingToolCall } from "@/types";
import ToolApprovalDialog from "@/components/ToolApprovalDialog.vue";

const PENDING: PendingToolCall = {
  toolCallId: "call-1",
  toolName: "bash",
  reason: "递归/强制删除文件或目录，可能造成不可恢复的数据丢失",
  rule: "recursive-delete",
  args: { command: "Remove-Item -Recurse -Force C:/work/build" },
};

describe("ToolApprovalDialog", () => {
  it("shows the dangerous command and reasons", () => {
    const wrapper = mount(ToolApprovalDialog, { props: { pending: PENDING } });

    expect(wrapper.text()).toContain("确认执行危险命令");
    expect(wrapper.text()).toContain(PENDING.reason);
    expect(wrapper.text()).toContain("工具：bash");
    expect(wrapper.text()).toContain("规则：recursive-delete");
    expect(wrapper.text()).toContain(PENDING.args.command);
  });

  it("emits approve with true or false when buttons are clicked", async () => {
    const wrapper = mount(ToolApprovalDialog, { props: { pending: PENDING } });

    await wrapper.get("button.danger-action").trigger("click");
    await wrapper.get("button.primary-action").trigger("click");

    expect(wrapper.emitted("approve")).toEqual([[false], [true]]);
  });

  it("ignores clicks while busy and closes on Escape as rejection", async () => {
    const wrapper = mount(ToolApprovalDialog, { props: { pending: PENDING, busy: true } });

    await wrapper.get("button.primary-action").trigger("click");
    expect(wrapper.emitted("approve")).toBeUndefined();

    await wrapper.setProps({ busy: false });
    await wrapper.get(".modal-backdrop").trigger("keydown", { key: "Escape" });
    expect(wrapper.emitted("approve")).toEqual([[false]]);
  });
});

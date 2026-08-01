import { flushPromises, mount } from "@vue/test-utils";
import { vi } from "vitest";

import {
  createDefaultWorkspace,
  getWorkspaceHome,
  listWorkspaces,
  selectWorkspace,
} from "@/lib/api";
import WorkspaceSwitcher from "./WorkspaceSwitcher.vue";

vi.mock("@/lib/api", () => ({
  createDefaultWorkspace: vi.fn(),
  getWorkspaceHome: vi.fn(),
  listWorkspaces: vi.fn(),
  selectWorkspace: vi.fn(),
}));

describe("WorkspaceSwitcher", () => {
  it("shows known projects and switches through the controlled API", async () => {
    vi.mocked(getWorkspaceHome).mockResolvedValue("C:/work");
    vi.mocked(listWorkspaces).mockResolvedValue(["C:/work/alpha", "C:/work/beta"]);
    vi.mocked(selectWorkspace).mockResolvedValue("C:/work/beta");
    const wrapper = mount(WorkspaceSwitcher, {
      props: { currentCwd: "C:/work/alpha" },
    });
    await flushPromises();

    expect(wrapper.findAll("button.workspace-option")).toHaveLength(2);
    expect(wrapper.get("button.workspace-option").text()).toContain("当前项目");
    await wrapper.findAll("button.workspace-option")[1].trigger("click");
    await flushPromises();

    expect(selectWorkspace).toHaveBeenCalledWith("C:/work/beta");
    expect(wrapper.emitted("selected")).toEqual([["C:/work/beta"]]);
  });

  it("accepts an absolute path and can create the default workspace", async () => {
    vi.mocked(getWorkspaceHome).mockResolvedValue("C:/work");
    vi.mocked(listWorkspaces).mockResolvedValue([]);
    vi.mocked(selectWorkspace).mockResolvedValue("C:/work/new-project");
    vi.mocked(createDefaultWorkspace).mockResolvedValue("C:/work/pi-cwd-20260801");
    const wrapper = mount(WorkspaceSwitcher, { props: { currentCwd: null } });
    await flushPromises();

    await wrapper.get("#workspace-path-input").setValue(" C:/work/new-project ");
    await wrapper.get("form").trigger("submit");
    await flushPromises();
    expect(selectWorkspace).toHaveBeenCalledWith("C:/work/new-project");

    await wrapper.findAll(".config-footer button")[0].trigger("click");
    await flushPromises();
    expect(createDefaultWorkspace).toHaveBeenCalled();
    expect(wrapper.emitted("selected")).toEqual([
      ["C:/work/new-project"],
      ["C:/work/pi-cwd-20260801"],
    ]);
  });
});

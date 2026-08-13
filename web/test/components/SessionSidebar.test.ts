import { mount } from "@vue/test-utils";

import SessionSidebar from "@/components/SessionSidebar.vue";

function session(id: string, cwd: string, parentSessionId: string | null = null) {
  return {
    id,
    path: null,
    cwd,
    name: null,
    created: "2026-08-13T08:00:00.000Z",
    modified: "2026-08-13T09:00:00.000Z",
    messageCount: 2,
    firstMessage: `Session ${id}`,
    parentSessionId,
    parentSessionPath: null,
  };
}

describe("SessionSidebar", () => {
  it("groups sessions by project and puts the user home under generic projects", () => {
    const wrapper = mount(SessionSidebar, {
      props: {
        sessions: [
          session("home", "C:\\Users\\xinao\\scratch"),
          session("project", "D:\\code\\pi_py"),
          session("child", "D:\\code\\pi_py", "project"),
        ],
        loading: false,
        selectedSessionId: null,
        newSessionActive: false,
        skillsAvailable: false,
        theme: "dark",
        soundEnabled: false,
        agentRunning: false,
      },
    });

    expect(wrapper.findAll(".session-project-group")).toHaveLength(2);
    expect(wrapper.text()).toContain("通用项目");
    expect(wrapper.text()).toContain("pi_py");
    expect(wrapper.findAll(".session-item--fork")).toHaveLength(1);
  });
});

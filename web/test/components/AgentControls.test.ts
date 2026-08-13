import { mount } from "@vue/test-utils";

import AgentControls from "@/components/AgentControls.vue";

const catalog = {
  models: { "alpha:a": "Alpha", "beta:b": "Beta" },
  modelList: [
    { id: "a", name: "Alpha", provider: "alpha" },
    { id: "b", name: "Beta", provider: "beta" },
  ],
  defaultModel: { provider: "alpha", modelId: "a" },
  thinkingLevels: { "alpha:a": ["off", "high"], "beta:b": ["off"] },
  thinkingLevelMaps: {},
};

describe("AgentControls", () => {
  it("emits provider-aware model and tool preset changes", async () => {
    const wrapper = mount(AgentControls, {
      props: {
        catalog,
        model: catalog.defaultModel,
        thinkingLevel: "off",
        activeTools: ["read", "bash", "edit", "write"],
        compacting: false,
        running: false,
        retryInfo: null,
        contextUsage: null,
      },
    });
    const selects = wrapper.findAll("select");
    await selects[0].setValue("beta:b");
    await selects[2].setValue("full");

    expect(wrapper.emitted("modelChange")).toEqual([[{ provider: "beta", modelId: "b" }]]);
    expect(wrapper.emitted("toolsChange")?.[0]?.[0]).toContain("grep");
  });
});

import { flushPromises, mount } from "@vue/test-utils";
import { vi } from "vitest";

import { getModelsConfig, saveModelsConfig } from "@/lib/api";
import ModelsConfig from "./ModelsConfig.vue";

vi.mock("@/lib/api", () => ({
  getModelsConfig: vi.fn(),
  saveModelsConfig: vi.fn(),
}));

describe("ModelsConfig", () => {
  it("round-trips structured provider configuration", async () => {
    vi.mocked(getModelsConfig).mockResolvedValue({
      providers: {
        custom: {
          api: "openai-completions",
          apiKey: "$CUSTOM_API_KEY",
          models: [{ id: "custom-model", name: "Custom Model", contextWindow: 200000 }],
        },
      },
    });
    vi.mocked(saveModelsConfig).mockResolvedValue();
    const wrapper = mount(ModelsConfig);
    await flushPromises();
    await wrapper.findAll(".config-footer button")[1].trigger("click");
    await flushPromises();

    expect(saveModelsConfig).toHaveBeenCalledWith({
      providers: {
        custom: {
          api: "openai-completions",
          apiKey: "$CUSTOM_API_KEY",
          models: [
            {
              id: "custom-model",
              name: "Custom Model",
              contextWindow: 200000,
              reasoning: true,
            },
          ],
        },
      },
    });
    expect(wrapper.emitted("saved")).toHaveLength(1);
  });
});

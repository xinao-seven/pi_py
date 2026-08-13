import { flushPromises, mount } from "@vue/test-utils";
import { vi } from "vitest";

import { getModelsConfig, saveModelsConfig } from "@/lib/api";
import ModelsConfig from "@/components/ModelsConfig.vue";

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

  it("adds the current DeepSeek V4 preset with one click", async () => {
    vi.mocked(getModelsConfig).mockResolvedValue({ providers: {} });
    vi.mocked(saveModelsConfig).mockResolvedValue();
    const wrapper = mount(ModelsConfig);
    await flushPromises();
    const presetButton = wrapper
      .findAll("button")
      .find((button) => button.text().includes("一键配置 DeepSeek V4"));

    expect(presetButton).toBeDefined();
    await presetButton!.trigger("click");
    await wrapper.findAll(".config-footer button")[1].trigger("click");
    await flushPromises();

    expect(saveModelsConfig).toHaveBeenCalledWith({
      providers: {
        deepseek: {
          api: "deepseek-chat-completions",
          baseUrl: "https://api.deepseek.com",
          apiKey: "$DEEPSEEK_API_KEY",
          models: [
            {
              id: "deepseek-v4-flash",
              name: "DeepSeek V4 Flash",
              contextWindow: 1_000_000,
              reasoning: true,
              thinkingLevels: ["off", "low", "high", "max"],
            },
            {
              id: "deepseek-v4-pro",
              name: "DeepSeek V4 Pro",
              contextWindow: 1_000_000,
              reasoning: true,
              thinkingLevels: ["off", "high", "max"],
            },
          ],
        },
      },
    });
  });
});

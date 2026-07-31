import { flushPromises, mount } from "@vue/test-utils";
import { vi } from "vitest";

import ChatInput from "./ChatInput.vue";

describe("ChatInput", () => {
  it("submits trimmed text with Enter", async () => {
    const wrapper = mount(ChatInput, { props: { running: false } });
    const input = wrapper.get("textarea");
    await input.setValue("  inspect the project  ");
    await input.trigger("keydown", { key: "Enter" });

    expect(wrapper.emitted("send")).toEqual([["inspect the project"]]);
    expect((input.element as HTMLTextAreaElement).value).toBe("");
  });

  it("shows abort while the agent is running", async () => {
    const wrapper = mount(ChatInput, { props: { running: true } });

    await wrapper.get("button.abort-button").trigger("click");

    expect(wrapper.emitted("abort")).toHaveLength(1);
    expect(wrapper.find("button.send-button").exists()).toBe(false);
  });

  it("can steer or queue a follow-up while running", async () => {
    const wrapper = mount(ChatInput, { props: { running: true } });
    const input = wrapper.get("textarea");
    await input.setValue("change direction");
    await wrapper.get("button.queue-button").trigger("click");
    await input.setValue("next request");
    await wrapper.findAll("button.queue-button")[1].trigger("click");

    expect(wrapper.emitted("steer")).toEqual([["change direction"]]);
    expect(wrapper.emitted("followUp")).toEqual([["next request"]]);
  });

  it("accepts an image-only message", async () => {
    vi.stubGlobal("URL", {
      ...URL,
      createObjectURL: () => "blob:preview",
      revokeObjectURL: vi.fn(),
    });
    const wrapper = mount(ChatInput, { props: { running: false } });
    const input = wrapper.get('input[type="file"]');
    const file = new File([new Uint8Array([1, 2, 3])], "pixel.png", { type: "image/png" });
    Object.defineProperty(input.element, "files", { value: [file], configurable: true });
    await input.trigger("change");
    await flushPromises();
    await vi.waitFor(() => expect(wrapper.find(".image-attachment").exists()).toBe(true));
    await wrapper.get("form").trigger("submit");

    const emitted = wrapper.emitted("send")?.[0];
    expect(emitted?.[0]).toBe("");
    expect(emitted?.[1]).toEqual([
      expect.objectContaining({ mimeType: "image/png", name: "pixel.png" }),
    ]);
    vi.unstubAllGlobals();
  });
});

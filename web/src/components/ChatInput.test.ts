import { mount } from "@vue/test-utils";

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
});

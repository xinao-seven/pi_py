import { mount } from "@vue/test-utils";

import MarkdownContent from "@/components/MarkdownContent.vue";

describe("MarkdownContent", () => {
  it("renders GFM and highlighted code without executable markup", () => {
    const wrapper = mount(MarkdownContent, {
      props: {
        content: "## Result\n\n```python\nprint('ok')\n```\n\n<script>alert(1)</script>",
      },
    });

    expect(wrapper.find("h2").text()).toBe("Result");
    expect(wrapper.find("code.hljs").classes()).toContain("language-python");
    expect(wrapper.html()).not.toContain("<script");
  });
});

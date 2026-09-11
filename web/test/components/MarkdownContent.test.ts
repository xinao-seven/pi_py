import { mount } from '@vue/test-utils';

import MarkdownContent from '@/components/MarkdownContent.vue';

describe('MarkdownContent', () => {
  it('renders GFM and highlighted code without executable markup', () => {
    const wrapper = mount(MarkdownContent, {
      props: {
        content: "## Result\n\n```python\nprint('ok')\n```\n\n<script>alert(1)</script>",
      },
    });

    expect(wrapper.find('h2').text()).toBe('Result');
    expect(wrapper.find('code.hljs').classes()).toContain('language-python');
    expect(wrapper.html()).not.toContain('<script');
  });

  it('renders GFM tables with cells and preserved alignment', () => {
    const wrapper = mount(MarkdownContent, {
      props: {
        content: '| 名称 | 数量 | 备注 |\n| :--- | ---: | :---: |\n| a | 1 | x |\n',
      },
    });

    expect(wrapper.findAll('th')).toHaveLength(3);
    expect(wrapper.findAll('td')).toHaveLength(3);
    expect(wrapper.get('td[align="right"]').text()).toBe('1');
    expect(wrapper.get('th[align="center"]').text()).toBe('备注');
    // 表格由 marked 生成，DOMPurify 必须保留 table/align，否则样式与对齐都会丢。
    expect(wrapper.html()).toContain('align="right"');
  });
});

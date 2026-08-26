import { flushPromises, mount } from '@vue/test-utils';
import { vi } from 'vitest';

import { getSkills, setSkillDisabled } from '@/lib/api';
import SkillsConfig from '@/components/SkillsConfig.vue';

vi.mock('@/lib/api', () => ({
  getSkills: vi.fn(),
  setSkillDisabled: vi.fn(),
}));

describe('SkillsConfig', () => {
  it('toggles model invocation using the discovered file path', async () => {
    vi.mocked(getSkills).mockResolvedValue({
      diagnostics: [],
      skills: [
        {
          name: 'review',
          description: 'Review code',
          filePath: 'C:/work/.agents/skills/review/SKILL.md',
          baseDir: 'C:/work/.agents/skills/review',
          source: 'project',
          sourceInfo: {
            source: 'project',
            scope: 'project',
            path: 'C:/work/.agents/skills/review/SKILL.md',
            baseDir: 'C:/work/.agents/skills/review',
          },
          disableModelInvocation: false,
        },
      ],
    });
    vi.mocked(setSkillDisabled).mockResolvedValue();
    const wrapper = mount(SkillsConfig, { props: { cwd: 'C:/work' } });
    await flushPromises();
    await wrapper.get('button.skill-toggle').trigger('click');
    await flushPromises();

    expect(setSkillDisabled).toHaveBeenCalledWith('C:/work/.agents/skills/review/SKILL.md', true);
    expect(wrapper.get('button.skill-toggle').text()).toBe('已隐藏');
  });
});

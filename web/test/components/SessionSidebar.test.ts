import { mount } from '@vue/test-utils';

import SessionSidebar from '@/components/SessionSidebar.vue';

function session(id: string, cwd: string, parentSessionId: string | null = null) {
  return {
    id,
    path: null,
    cwd,
    name: null,
    created: '2026-08-13T08:00:00.000Z',
    modified: '2026-08-13T09:00:00.000Z',
    messageCount: 2,
    firstMessage: `Session ${id}`,
    parentSessionId,
    parentSessionPath: null,
  };
}

describe('SessionSidebar', () => {
  it('groups sessions by collapsible project folders and keeps generic sessions last', async () => {
    const wrapper = mount(SessionSidebar, {
      props: {
        sessions: [
          session('home', 'C:\\Users\\xinao\\scratch'),
          session('project', 'D:\\code\\pi_py'),
          session('child', 'D:\\code\\pi_py', 'project'),
        ],
        loading: false,
        selectedSessionId: null,
        newSessionActive: false,
        agentRunning: false,
      },
    });

    expect(wrapper.findAll('.session-project-group')).toHaveLength(2);
    expect(wrapper.text()).toContain('通用会话');
    expect(wrapper.text()).toContain('pi_py');
    expect(wrapper.findAll('.session-item--fork')).toHaveLength(1);
    const groups = wrapper.findAll('.session-project-group');
    expect(groups.at(-1)?.text()).toContain('通用会话');

    await groups[0].get('.session-project-heading').trigger('click');
    expect(groups[0].get('.session-project-heading').attributes('aria-expanded')).toBe('false');
  });
});

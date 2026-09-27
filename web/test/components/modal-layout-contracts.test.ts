import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';

import { describe, expect, it } from 'vitest';

/**
 * 布局契约测试（读源码的测试）。
 *
 * jsdom 没有布局引擎，scrollHeight/clientHeight 恒为 0，所以「弹窗比视口高就滚不到」「单条
 * 描述撑满面板」这类缺陷单测跑不出来。这里守住的是**修复的因果条件**：
 *
 * 1. 遮罩层必须自己可滚（overflow-y: auto）——弹窗高于视口时唯一的出路；
 * 2. 居中必须走 .config-dialog / .settings-dialog 的 margin: auto——place-items: center
 *    在溢出时会把上下两端都推到可视区之外，遮罩层再能滚也够不着顶部；
 * 3. 弹窗的 min-height 必须被可用高度封顶——固定 340px/460px 会把弹窗顶出屏幕；
 * 4. 单个条目的描述必须有高度上限 + 内部滚动——否则一条超长描述就能把面板正文撑满；
 * 5. 技能列表（网格）必须 align-content: start——align-content 默认 stretch 会把
 *    隐式行拉满正文，「只有一条技能」时那一条就沾满整个弹窗（条目再少也撑满）。
 *
 * 真实浏览器里的量测证据见 docs/web-modal-scroll-skills-entry.md。
 */
function rule(source: string, selector: string): string {
  const escaped = selector.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
  return new RegExp(`${escaped}\\s*\\{([^}]*)\\}`).exec(source)?.[1] ?? '';
}

function sourceOf(relative: string): string {
  return readFileSync(resolve(process.cwd(), relative), 'utf8');
}

const globals = sourceOf('src/globals.css');
const settingsDialog = sourceOf('src/components/SettingsDialog.vue');
const skillsConfig = sourceOf('src/components/SkillsConfig.vue');
const sessionInfoPanel = sourceOf('src/components/SessionInfoPanel.vue');

describe('弹窗滚动链路契约', () => {
  it('遮罩层自己可滚，且不再用 place-items 居中（溢出时顶部会够不着）', () => {
    for (const [name, source, selector] of [
      ['globals.css', globals, '.modal-backdrop'],
      ['SettingsDialog.vue', settingsDialog, '.settings-backdrop'],
    ] as const) {
      const body = rule(source, selector);
      expect(body, `${name} ${selector} 缺少声明`).not.toBe('');
      expect(body, `${name} ${selector} 必须可滚`).toContain('overflow-y: auto');
      expect(body, `${name} ${selector} 不应再靠 place-items 居中`).not.toContain(
        'place-items: center',
      );
    }
  });

  it('弹窗用 margin: auto 居中，且 min-height 被可用高度封顶', () => {
    const dialog = rule(globals, '.config-dialog');
    expect(dialog).toContain('margin: auto');
    expect(dialog).toContain('min-height: min(340px, calc(100vh - 48px))');

    const settings = rule(settingsDialog, '.settings-dialog');
    expect(settings).toContain('margin: auto');
    expect(settings).toContain('min-height: min(460px, calc(100vh - 48px))');
  });

  it('单个条目的描述有高度上限与内部滚动，不会撑满面板', () => {
    const card = rule(skillsConfig, '.skill-card p');
    expect(card).toContain('max-height: 4.5em');
    expect(card).toContain('overflow-y: auto');

    const skillsDesc = rule(sessionInfoPanel, '.session-info-skills .session-info-desc');
    expect(skillsDesc).toContain('max-height: 4.8em');
    expect(skillsDesc).toContain('overflow-y: auto');
  });

  it('技能列表不把网格行拉伸填满正文（技能少时单条会沾满弹窗）', () => {
    const list = rule(skillsConfig, '.skills-list');
    expect(list).toContain('display: grid');
    expect(list).toContain('align-content: start');
  });

  it('移动端整屏分支仍然有效（=100dvh 覆盖桌面的封顶值）', () => {
    const mobile = /@media \(max-width: 760px\) \{([\s\S]*?)\n\}/.exec(globals)?.[1] ?? '';
    expect(mobile).toContain('min-height: 100dvh');
    const settingsMobile =
      /@media \(max-width: 680px\) \{([\s\S]*?)\n\}/.exec(settingsDialog)?.[1] ?? '';
    expect(settingsMobile).toContain('min-height: 0');
  });
});

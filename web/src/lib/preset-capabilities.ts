// 预设能力（capabilities）与会话能力（extensions）之间的映射与展示文案。
//
// 中文说明：后端把「预设能力」存成用户概念（plan / subagent / tasks），
// 会话创建接口用的是引擎概念（planMode / subagents …）。字段名差异集中在这一个
// 纯函数里，预设编辑器、会话创建与测试共用同一份映射，避免两边各写一遍而漂移。
import type { PresetCapabilities, SessionCapabilities, SessionExtensions } from '@/types';

/** 缺省能力：全开（与后端 DEFAULT_CAPABILITIES 一致）。 */
export const DEFAULT_CAPABILITIES: PresetCapabilities = {
  plan: true,
  approval: true,
  questions: true,
  subagent: true,
  tasks: true,
  observability: true,
  fileExtensions: true,
};

/** 能力开关的中文文案（表单与卡片摘要共用）。 */
export const CAPABILITY_FIELDS: ReadonlyArray<{
  key: keyof PresetCapabilities;
  label: string;
  hint: string;
}> = [
  { key: 'plan', label: 'Plan 模式', hint: '计划工具 + 规划期只读（依赖任务面板）' },
  { key: 'approval', label: '危险命令审批', hint: '危险 bash 命令挂起等用户确认' },
  { key: 'questions', label: '向用户提问', hint: '模型可调 ask_user 弹窗提问' },
  { key: 'subagent', label: '子 agent 委派', hint: 'subagent 工具，独立上下文跑子任务' },
  { key: 'tasks', label: '任务面板', hint: '任务广播与断点续跑提示' },
  { key: 'observability', label: '观测钩子', hint: '只读采集 provider 层用量（不影响模型请求）' },
  {
    key: 'fileExtensions',
    label: '加载用户扩展',
    hint: '加载 ~/.pi/agent/extensions 与工作区扩展',
  },
];

/** 预设能力 → POST /api/agent/new 的 extensions。 */
export function capabilitiesToExtensions(capabilities: PresetCapabilities): SessionExtensions {
  return {
    planMode: capabilities.plan,
    approval: capabilities.approval,
    questions: capabilities.questions,
    subagents: capabilities.subagent,
    tasks: capabilities.tasks,
    observability: capabilities.observability,
    fileExtensions: capabilities.fileExtensions,
  };
}

/** 卡片摘要：只列被关掉的能力，避免把 7 个标签全铺在列表上。 */
export function summarizeCapabilities(capabilities: PresetCapabilities): string {
  const disabled = CAPABILITY_FIELDS.filter((field) => !capabilities[field.key]).map(
    (field) => field.label,
  );
  return disabled.length === 0 ? '能力全开' : `关闭：${disabled.join('、')}`;
}

/**
 * 计划/任务面板入口是否显示。
 * 中文说明：能力位未知（历史会话、刷新后）按「显示」处理——后端已经决定了会话里
 * 有没有任务/计划能力，前端只决定要不要给一个入口；关掉任务域的会话（极简模式）
 * 连入口都不出现，避免点开一个永远空着的面板。
 */
export function shouldShowWorkPanel(capabilities: SessionCapabilities | null): boolean {
  return capabilities === null || capabilities.tasks;
}

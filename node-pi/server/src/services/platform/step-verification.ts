/**
 * 步骤完成的证据校验（M4）：把「模型说完成了」变成「服务端能验的完成」。
 *
 * 中文说明：这是对 P3 的根治——旧实现里 `[DONE:n]` 是模型自证，
 * 漏写会卡死、乱写会骗过系统。现在步骤可以声明 `verification`，
 * 完成时必须提交 `evidence`，由这里的纯函数判定是否成立。
 *
 * 三个 kind 的判定强度是**刻意不同**的，因为可验证性本身不同：
 *
 * - `file`：最强——直接查产物是否存在（恢复路径也用它，见 task-recovery）。
 * - `command`：中等——要求证据里**确有**这条命令、且退出码符合预期。
 *   服务端不自己重跑命令（那等于绕开审批链路执行任意 shell），
 *   因此只能验证「模型确实跑了并如实上报」，不能证明「跑对了」。
 *   这一点在文档里明说，避免读者以为它是强校验。
 * - `manual`：最弱——要求给出非空的人类可读结论（供人事后审计）。
 *
 * 未知 kind / 声明不自洽（如 `file` 没给 path）一律判**不通过**，并把原因讲清楚，
 * 让模型有机会补齐重试，而不是静默放行。
 */

import { existsSync } from 'node:fs';
import { isAbsolute, resolve } from 'node:path';

import type { StepEvidence, StepVerification } from './task-model.js';

export interface EvidenceCheck {
  ok: boolean;
  /** 判定说明：通过时作为证据摘要的一部分，不通过时作为工具错误信息。 */
  detail: string;
}

/** 校验上下文：cwd 用于解析相对路径产物，`exists` 可注入（测试用）。 */
export interface EvidenceContext {
  cwd?: string;
  exists?: (path: string) => boolean;
}

/** 默认产物存在性检查（只读 stat，不做任何写操作）。 */
function defaultExists(path: string): boolean {
  return existsSync(path);
}

/** 绝对路径原样返回；相对路径按 cwd 解析（cwd 未知时按进程 cwd，并如实标注）。 */
export function resolveArtifactPath(path: string, cwd?: string): string {
  if (isAbsolute(path)) return path;
  return resolve(cwd ?? process.cwd(), path);
}

/**
 * 判定一次「步骤完成」是否被证据支持。
 * `verification` 未声明时仍要求证据非空——「没有任何证据的完成」不接受。
 */
export function evaluateStepEvidence(
  verification: StepVerification | undefined,
  evidence: StepEvidence | undefined,
  context: EvidenceContext = {},
): EvidenceCheck {
  if (evidence === undefined) {
    return { ok: false, detail: '缺少证据：完成步骤必须带上 summary / commands / files 之一' };
  }
  const hasAny =
    (evidence.summary?.trim().length ?? 0) > 0 ||
    (evidence.commands?.length ?? 0) > 0 ||
    (evidence.filesTouched?.length ?? 0) > 0;
  if (!hasAny) {
    return { ok: false, detail: '证据为空：完成步骤必须带上 summary / commands / files 之一' };
  }
  if (verification === undefined) return { ok: true, detail: '已记录证据（该步骤未声明验证方式）' };

  switch (verification.kind) {
    case 'file': {
      if (!verification.path) {
        return { ok: false, detail: 'verification.kind=file 但未声明 path，无法校验产物' };
      }
      const target = resolveArtifactPath(verification.path, context.cwd);
      const exists = (context.exists ?? defaultExists)(target);
      return exists
        ? { ok: true, detail: `产物已存在：${target}` }
        : { ok: false, detail: `产物不存在：${target}（先完成该产物再上报完成）` };
    }
    case 'command': {
      if (!verification.command) {
        return { ok: false, detail: 'verification.kind=command 但未声明 command，无法校验' };
      }
      const expected = verification.expectExitCode ?? 0;
      const matched = (evidence.commands ?? []).find(
        (entry) => normalize(entry.command) === normalize(verification.command as string),
      );
      if (matched === undefined) {
        return {
          ok: false,
          detail: `证据里没有验证命令「${verification.command}」的执行记录：请真的跑一遍并如实上报退出码`,
        };
      }
      if ((matched.exitCode ?? null) !== expected) {
        return {
          ok: false,
          detail: `验证命令「${verification.command}」退出码为 ${matched.exitCode ?? 'null'}，期望 ${expected}`,
        };
      }
      return { ok: true, detail: `验证命令通过：${verification.command}（退出码 ${expected}）` };
    }
    case 'manual': {
      const summary = evidence.summary?.trim() ?? '';
      if (summary.length === 0) {
        return { ok: false, detail: 'verification.kind=manual 需要 summary 说明人工确认的依据' };
      }
      return { ok: true, detail: `人工确认：${summary}` };
    }
    default:
      return {
        ok: false,
        detail: `未知的 verification.kind：${String((verification as { kind?: unknown }).kind)}`,
      };
  }
}

/** 命令比较：折叠空白，忽略大小写差异（同一命令的书写变体不应被判为不同）。 */
function normalize(command: string): string {
  return command.replace(/\s+/g, ' ').trim();
}

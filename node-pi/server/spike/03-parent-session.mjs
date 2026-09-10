// M0-③: SessionManager.create(cwd, dir, { parentSession }) 是否形成父子关系，
//        并且被 listAll 识别（前端会话树按 parentSessionPath 缩进展示的依据）
import { mkdtempSync, mkdirSync, writeFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fauxProvider, fauxAssistantMessage } from '@earendil-works/pi-ai';
import { ModelRuntime, createAgentSession, SessionManager } from '@earendil-works/pi-coding-agent';

const root = mkdtempSync(join(tmpdir(), 'pi-spike-parent-'));
const agentDir = join(root, 'agent');
const cwd = join(root, 'ws');
mkdirSync(agentDir, { recursive: true });
mkdirSync(cwd, { recursive: true });
writeFileSync(join(agentDir, 'auth.json'), '{}\n');
writeFileSync(join(agentDir, 'models.json'), '{ "providers": {} }\n');
const sessionsDir = join(agentDir, 'sessions');

const faux = fauxProvider();
const runtime = await ModelRuntime.create({
  authPath: join(agentDir, 'auth.json'),
  modelsPath: join(agentDir, 'models.json'),
  allowModelNetwork: false,
});
runtime.registerNativeProvider(faux.provider);
const model = runtime.getModel(faux.provider.id, faux.getModel().id);

async function makeSession(sessionManager) {
  const { session } = await createAgentSession({
    cwd,
    agentDir,
    modelRuntime: runtime,
    model,
    sessionManager,
    tools: [],
    thinkingLevel: 'off',
  });
  return session;
}

// 父会话
const parentSm = SessionManager.create(cwd, sessionsDir);
const parent = await makeSession(parentSm);
faux.setResponses([fauxAssistantMessage('父会话回复')]);
await parent.prompt('父任务');
const parentFile = parentSm.getSessionFile();
const parentId = parentSm.getSessionId();
console.log('[1] 父会话 id =', parentId);

// 子会话：传入 parentSession
const childSm = SessionManager.create(cwd, sessionsDir, { parentSession: parentFile });
const child = await makeSession(childSm);
faux.setResponses([fauxAssistantMessage('子会话回复')]);
await child.prompt('子任务');
const childId = childSm.getSessionId();
const childFile = childSm.getSessionFile();
console.log('[2] 子会话 id =', childId);

// 校验 JSONL header 是否记录了 parentSession
const { readFileSync } = await import('node:fs');
const header = JSON.parse(readFileSync(childFile, 'utf8').split('\n')[0]);
console.log(
  '[3] 子会话 JSONL header:',
  JSON.stringify({ id: header.id, parentSession: header.parentSession ? '<path>' : undefined }),
);
console.log('    parentSession 等于父文件 =', header.parentSession === parentFile);

// listAll 能否发现两个会话并给出 parentSessionPath
const all = await SessionManager.listAll(sessionsDir);
console.log(`[4] listAll 发现 ${all.length} 个会话`);
for (const info of all) {
  const isParent = info.id === parentId;
  console.log(
    `    ${isParent ? '父' : '子'} id=${info.id.slice(0, 8)}… parentSessionPath=${info.parentSessionPath ? '有(' + String(info.parentSessionPath).slice(-28) + ')' : '无'} name=${info.name ?? '-'}`,
  );
}
const childInfo = all.find((i) => i.id === childId);
console.log('[5] 子会话 parentSessionPath 已填充 =', Boolean(childInfo?.parentSessionPath));
console.log('    与父会话 path 一致 =', childInfo?.parentSessionPath === parentFile);

rmSync(root, { recursive: true, force: true });

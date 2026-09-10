// M0-② 前置：ESM 解析 @earendil-works/pi-ai 与 fauxProvider 导出
import { fauxProvider, fauxAssistantMessage, fauxToolCall } from '@earendil-works/pi-ai';
const faux = fauxProvider();
console.log('fauxProvider OK:', typeof fauxProvider);
console.log('  handle keys:', Object.keys(faux).join(','));
console.log('  api:', faux.api);
console.log('  model:', faux.getModel().id, '| provider:', faux.provider.id);
console.log('  fauxAssistantMessage OK:', fauxAssistantMessage('hi').role);
console.log('  fauxToolCall OK:', fauxToolCall('bash', { command: 'ls' }).name);
console.log(
  '  状态注入 OK:',
  (faux.setResponses([fauxAssistantMessage('x')]), faux.getPendingResponseCount()),
);

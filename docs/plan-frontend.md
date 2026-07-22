# 前端 Vue 方案

## 1. 目标

用 Vue 3 复刻当前 React Web UI 的全部功能，保持相同的用户体验、视觉风格和交互逻辑。

## 2. 技术栈

| 技术 | 版本 | React 对应 |
|------|------|------------|
| Vue | 3.5+ | React 19 |
| Vite | 6+ | Next.js |
| TypeScript | 5+ | TypeScript |
| Pinia | 2+ | useState + useContext |
| VueUse | 12+ | 自定义 hooks |
| Tailwind CSS | 4+ | Tailwind CSS |
| `marked` + `highlight.js` | — | `react-markdown` + `react-syntax-highlighter` |
| `event-source-polyfill` | — | `EventSource` (原生) |

**不引入的依赖**：
- 不引入组件库（Element Plus / Vuetify 等），保持与当前项目一致的纯手写风格
- 不引入 Vue Router（单页应用，URL 参数用原生 `URLSearchParams`）

## 3. 项目结构

```
web/
├── index.html
├── package.json
├── vite.config.ts
├── tsconfig.json
├── tailwind.config.ts
│
├── public/
│   └── favicon.ico
│
├── src/
│   ├── main.ts                    # Vue 应用入口
│   ├── App.vue                    # 根组件
│   ├── globals.css                # 全局样式 + CSS 变量
│   │
│   ├── types/
│   │   └── index.ts              # 共享 TypeScript 类型
│   │
│   ├── lib/
│   │   ├── api.ts                # HTTP 请求封装（对应 agent-client.ts）
│   │   ├── session-reader.ts     # 会话文件读取（对应 session-reader.ts）
│   │   └── normalize.ts          # ToolCall 字段适配（对应 normalize.ts）
│   │
│   ├── composables/              # Vue Composables（替代 React hooks）
│   │   ├── useAgentSession.ts    # Agent 状态管理（核心，~400 行）
│   │   ├── useAudio.ts           # 完成提示音
│   │   ├── useDragDrop.ts        # 拖拽上传
│   │   └── useTheme.ts           # 深色/浅色模式
│   │
│   ├── stores/                   # Pinia Stores（跨组件共享状态）
│   │   └── appStore.ts           # 全局应用状态（sidebar/panels/tabs）
│   │
│   ├── components/
│   │   ├── AppShell.vue          # 主布局（三栏 + top bar）
│   │   ├── SessionSidebar.vue    # 侧边栏（会话列表 + 文件浏览器）
│   │   ├── FileExplorer.vue      # 文件树
│   │   ├── FileViewer.vue        # 文件内容查看器（右侧面板）
│   │   ├── TabBar.vue            # 文件标签页
│   │   ├── ChatWindow.vue        # 聊天主区域
│   │   ├── ChatInput.vue         # 输入栏（消息 + 模型选择 + 工具预设等）
│   │   ├── MessageView.vue       # 单条消息渲染
│   │   ├── MessageContent.vue    # 消息内容渲染（Markdown + 代码高亮）
│   │   ├── ThinkingBlock.vue     # 思考内容折叠面板
│   │   ├── ToolCallBlock.vue     # 工具调用/结果面板
│   │   ├── ChatMinimap.vue       # 右侧滚动缩略图
│   │   ├── BranchNavigator.vue   # 顶部栏分支导航
│   │   ├── ModelsConfig.vue      # 模型配置弹窗
│   │   ├── SkillsConfig.vue      # 技能管理弹窗
│   │   ├── ToolPanel.vue         # 工具预设定义
│   │   └── AuthGate.vue          # 认证门控
│   │
│   └── utils/
│       ├── icons.ts              # SVG 图标组件
│       └── format.ts             # 格式化工具函数
│
└── env.d.ts                      # 类型声明
```

## 4. 组件树与数据流

```
App.vue
└── AuthGate.vue
    └── AppShell.vue ←────── useAppStore (Pinia)
        │                       ├── sidebarOpen
        │                       ├── selectedSession
        │                       ├── fileTabs / activeFileTab
        │                       ├── modelsConfigOpen
        │                       └── skillsConfigOpen
        │
        ├── SessionSidebar.vue
        │   ├── 会话树 (Fork 层级)
        │   ├── FileExplorer.vue
        │   └── 模型/技能按钮
        │
        ├── ChatWindow.vue ←──── useAgentSession() composable
        │   │                       ├── messages, entryIds
        │   │                       ├── streamState
        │   │                       ├── agentRunning / agentPhase
        │   │                       ├── toolPreset / thinkingLevel
        │   │                       ├── modelNames / modelList
        │   │                       └── handleSend / handleAbort / ...
        │   │
        │   ├── MessageView.vue × N
        │   │   ├── MessageContent.vue (Markdown 渲染)
        │   │   ├── ThinkingBlock.vue (折叠面板)
        │   │   └── ToolCallBlock.vue (工具调用)
        │   ├── ChatMinimap.vue
        │   └── ChatInput.vue ←── ref (插槽/暴露方法)
        │       ├── 图片附件预览
        │       ├── 模型选择器（按 provider 分组）
        │       ├── 推理等级选择器
        │       ├── 工具预设选择器
        │       ├── 压缩按钮
        │       ├── Steer / FollowUp 按钮（流式时）
        │       └── 声音开关
        │
        ├── TabBar.vue + FileViewer.vue（右侧面板）
        ├── BranchNavigator.vue（顶部栏）
        ├── ModelsConfig.vue（弹窗）
        └── SkillsConfig.vue（弹窗）
```

## 5. 核心 Composable：`useAgentSession`

这是整个前端的核心，翻译自 React `useAgentSession` hook（~400 行）。

### 5.1 状态（Vue ref / reactive）

```typescript
// composables/useAgentSession.ts
import { ref, reactive, computed, watch, onMounted, onUnmounted } from 'vue';

export function useAgentSession(opts: {
  session: Ref<SessionInfo | null>;
  newSessionCwd: Ref<string | null>;
  onAgentEnd?: () => void;
  onSessionCreated?: (session: SessionInfo) => void;
  onSessionForked?: (newSessionId: string) => void;
}) {
  // ── 响应式状态 ──
  const data = ref<SessionData | null>(null);
  const loading = ref(true);
  const error = ref<string | null>(null);
  const activeLeafId = ref<string | null>(null);
  const messages = ref<AgentMessage[]>([]);
  const entryIds = ref<string[]>([]);
  
  // 流式状态（对应 React useReducer）
  const streamState = reactive({
    isStreaming: false,
    streamingMessage: null as Partial<AgentMessage> | null,
  });
  
  const agentRunning = ref(false);
  const agentPhase = ref<AgentPhase>(null);
  const isCompacting = ref(false);
  const compactError = ref<string | null>(null);
  
  // 模型相关
  const modelNames = ref<Record<string, string>>({});
  const modelList = ref<{ id: string; name: string; provider: string }[]>([]);
  const currentModelOverride = ref<{ provider: string; modelId: string } | null>(null);
  
  // 工具 / 推理
  const toolPreset = ref<"none" | "default" | "full">("default");
  const thinkingLevel = ref<ThinkingLevelOption>("auto");
  
  // 其他
  const retryInfo = ref<RetryInfo | null>(null);
  const contextUsage = ref<ContextUsage | null>(null);
  const systemPrompt = ref<string | null>(null);
  const forkingEntryId = ref<string | null>(null);
  
  // 计算属性
  const isNew = computed(() => opts.session.value === null && opts.newSessionCwd.value !== null);
  const displayModel = computed(() => {
    if (isNew.value) return newSessionModel.value;
    return currentModelOverride.value ?? data.value?.context.model ?? null;
  });
  
  // 会话统计
  const sessionStats = computed(() => {
    let tokens = { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 };
    let cost = 0;
    for (const msg of messages.value) {
      if (msg.role !== "assistant") continue;
      const u = (msg as AssistantMessage).usage;
      if (!u) continue;
      tokens.input += u.input ?? 0;
      tokens.output += u.output ?? 0;
      tokens.cacheRead += u.cacheRead ?? 0;
      tokens.cacheWrite += u.cacheWrite ?? 0;
      cost += u.cost?.total ?? 0;
    }
    const total = tokens.input + tokens.output + tokens.cacheRead + tokens.cacheWrite;
    return total > 0 ? { tokens, cost } : null;
  });
  
  // ── Refs（非响应式引用） ──
  // Vue 的 template ref 和普通 ref 不同，用 shallowRef 或直接 let
  const sessionIdRef = ref<string | null>(opts.session.value?.id ?? null);
  const eventSourceRef = ref<EventSource | null>(null);
  const scrollContainerRef = ref<HTMLElement | null>(null);
  const messagesEndRef = ref<HTMLElement | null>(null);
  const lastUserMsgRef = ref<HTMLElement | null>(null);
  
  // ── 方法 ──
  
  async function loadSession(sid: string, showLoading = false, includeState = false) {
    // ... 类似 React 版本
  }
  
  function connectEvents(sid: string) {
    if (eventSourceRef.value) {
      eventSourceRef.value.close();
      eventSourceRef.value = null;
    }
    const es = new EventSource(`/api/agent/${encodeURIComponent(sid)}/events`);
    eventSourceRef.value = es;
    
    es.onmessage = (e) => {
      try {
        const event = JSON.parse(e.data);
        handleAgentEvent(event);
      } catch { /* ignore */ }
    };
    
    es.onerror = () => {
      if (eventSourceRef.value === es && agentRunning.value) {
        es.close();
        eventSourceRef.value = null;
        setTimeout(() => {
          if (agentRunning.value) connectEvents(sid);
        }, 1000);
      }
    };
  }
  
  function handleAgentEvent(event: AgentEvent) {
    switch (event.type) {
      case "agent_start":
        agentRunning.value = true;
        agentPhase.value = { kind: "waiting_model" };
        streamState.isStreaming = true;
        streamState.streamingMessage = null;
        break;
        
      case "agent_end":
        agentRunning.value = false;
        agentPhase.value = null;
        retryInfo.value = null;
        streamState.isStreaming = false;
        streamState.streamingMessage = null;
        if (sessionIdRef.value) {
          loadSession(sessionIdRef.value);
        }
        opts.onAgentEnd?.();
        break;
        
      case "message_update": {
        const msg = event.message as Partial<AgentMessage>;
        if (msg) {
          streamState.streamingMessage = normalizeToolCalls(msg as AgentMessage);
        }
        agentPhase.value = null;
        break;
      }
        
      case "message_end": {
        const completed = event.message as AgentMessage;
        if (completed) {
          messages.value = [...messages.value, normalizeToolCalls(completed)];
        }
        streamState.isStreaming = false;
        streamState.streamingMessage = null;
        agentPhase.value = { kind: "waiting_model" };
        break;
      }
        
      case "tool_execution_start": {
        const id = event.toolCallId as string;
        const name = event.toolName as string;
        agentPhase.value = (() => {
          const prev = agentPhase.value;
          const tools = prev?.kind === "running_tools" ? [...prev.tools] : [];
          if (!tools.some(t => t.id === id)) tools.push({ id, name });
          return { kind: "running_tools", tools };
        })();
        break;
      }
        
      case "tool_execution_end": {
        const id = event.toolCallId as string;
        agentPhase.value = (() => {
          const prev = agentPhase.value;
          if (prev?.kind !== "running_tools") return prev;
          const tools = prev.tools.filter(t => t.id !== id);
          if (tools.length === 0) return { kind: "waiting_model" };
          return { kind: "running_tools", tools };
        })();
        break;
      }
        
      case "auto_retry_start":
        retryInfo.value = {
          attempt: event.attempt as number,
          maxAttempts: event.maxAttempts as number,
          errorMessage: event.errorMessage as string | undefined,
        };
        break;
        
      case "auto_retry_end":
        retryInfo.value = null;
        break;
        
      case "compaction_start":
        isCompacting.value = true;
        compactError.value = null;
        break;
        
      case "compaction_end":
        isCompacting.value = false;
        if (event.errorMessage) compactError.value = event.errorMessage as string;
        else if (!event.aborted && sessionIdRef.value) {
          loadSession(sessionIdRef.value);
        }
        break;
    }
  }
  
  async function handleSend(message: string, images?: AttachedImage[]) {
    if (!message.trim() && !images?.length) return;
    if (agentRunning.value) return;
    
    // ... 类似 React 版本
    // Vue 注意：响应式数组用 messages.value = [...messages.value, newMsg]
  }
  
  // ... 其他方法：handleAbort, handleFork, handleNavigate,
  //     handleModelChange, handleCompact, handleSteer, etc.
  
  // ── 生命周期 ──
  onMounted(() => {
    if (opts.session.value) {
      sessionIdRef.value = opts.session.value.id;
      loadSession(opts.session.value.id, true, true);
    }
    
    // 加载模型列表
    fetch("/api/models")
      .then(r => r.json())
      .then(d => {
        modelNames.value = d.models;
        if (d.modelList) modelList.value = d.modelList;
      })
      .catch(() => {});
  });
  
  onUnmounted(() => {
    eventSourceRef.value?.close();
    eventSourceRef.value = null;
  });
  
  // ── Watch 副作用 ──
  // Vue 的 watch 替代 React 的 useEffect
  
  // 自动滚动
  watch(
    () => messages.value.length,
    () => {
      if (messages.value.length > 0 && !agentRunning.value) {
        messagesEndRef.value?.scrollIntoView({ behavior: "smooth" });
      }
    }
  );
  
  // 压缩错误自动消失
  watch(compactError, (val) => {
    if (val) {
      setTimeout(() => { compactError.value = null; }, 3000);
    }
  });
  
  return {
    // State
    data, loading, error, messages, entryIds,
    streamState, agentRunning, agentPhase,
    modelNames, modelList, toolPreset, thinkingLevel,
    retryInfo, contextUsage, systemPrompt, forkingEntryId,
    isCompacting, compactError, displayModel, sessionStats,
    isNew,
    // Actions
    handleSend, handleAbort, handleFork, handleNavigate,
    handleModelChange, handleCompact, handleSteer, handleFollowUp,
    handleToolPresetChange, handleThinkingLevelChange,
    // Refs
    scrollContainerRef, messagesEndRef, lastUserMsgRef,
  };
}
```

### 5.2 React → Vue 关键差异对照

| React | Vue 3 | 说明 |
|------|-------|------|
| `useState(x)` | `ref(x)` | `ref` 自动解包在 `<template>` 中，在 `<script>` 中用 `.value` |
| `useReducer(reducer, init)` | `reactive({...})` + 手动分发 | Vue 没有 useReducer，直接用 reactive 对象 + 方法 |
| `useEffect(fn, deps)` | `watch(source, fn)` 或 `watchEffect(fn)` | Vue 的 watch 自动追踪依赖 |
| `useEffect(() => { ... return cleanup }, [])` | `onMounted` + `onUnmounted` | Vue 生命周期钩子更直观 |
| `useCallback(fn, deps)` | 不需要 | Vue 的 `<script setup>` 中函数自动稳定（模板编译优化） |
| `useMemo(fn, deps)` | `computed(fn)` | 语义一致 |
| `useRef(x)` | `ref(x)` 或 `shallowRef(x)` | DOM ref 用 `ref<HTMLElement | null>(null)` |
| `useImperativeHandle` | `defineExpose` | 暴露子组件方法给父组件 |
| `forwardRef` | 自动 | Vue 3 中所有组件自动转发 ref |
| `props` | `defineProps<T>()` | Vue 的类型安全 props |
| `useContext(X)` | `inject(key)` 或 Pinia store | Pinia 是 Vue 的官方状态管理 |

## 6. 组件实现关键点

### 6.1 ChatWindow.vue

```vue
<!-- components/ChatWindow.vue -->
<script setup lang="ts">
import { useAgentSession } from '@/composables/useAgentSession';
import { useAudio } from '@/composables/useAudio';
import { useDragDrop } from '@/composables/useDragDrop';

const props = defineProps<{
  session: SessionInfo | null;
  newSessionCwd: string | null;
  onAgentEnd?: () => void;
  onSessionCreated?: (s: SessionInfo) => void;
  onSessionForked?: (id: string) => void;
  // ...
}>();

const chatInputRef = ref<InstanceType<typeof ChatInput> | null>(null);

const {
  loading, error, messages, entryIds, streamState,
  agentRunning, agentPhase, modelNames, modelList,
  toolPreset, thinkingLevel, isCompacting, compactError,
  displayModel, sessionStats, isNew,
  handleSend, handleAbort, handleFork, handleNavigate,
  handleModelChange, handleCompact, handleSteer, handleFollowUp,
  handleToolPresetChange, handleThinkingLevelChange,
  scrollContainerRef, messagesEndRef,
} = useAgentSession({
  session: toRef(props, 'session'),
  newSessionCwd: toRef(props, 'newSessionCwd'),
  onAgentEnd: props.onAgentEnd,
  onSessionCreated: props.onSessionCreated,
  onSessionForked: props.onSessionForked,
});

const { soundEnabled, onSoundToggle, playDoneSound } = useAudio();

// 空状态判断
const isEmptyNew = computed(() =>
  isNew.value && messages.value.length === 0 &&
  !streamState.isStreaming && !agentRunning.value
);

// 过滤显示的消息
const visibleMessages = computed(() =>
  messages.value.filter(m => m.role === "user" || m.role === "assistant")
);

// 滚动处理
function scrollToBottom(behavior: ScrollBehavior = "smooth") {
  messagesEndRef.value?.scrollIntoView({ behavior });
}

// 拖拽
const { isDragOver, handleDragEnter, handleDragOver, handleDragLeave, handleDrop } =
  useDragDrop((files) => chatInputRef.value?.addImages(files));
</script>

<!-- Vue 模板语法：v-if, v-for, :style, @click 替代 JSX -->
<template>
  <div
    v-if="loading"
    class="flex h-full items-center justify-center text-text-muted"
  >
    正在加载会话...
  </div>

  <div
    v-else-if="error"
    class="flex h-full items-center justify-center text-red-400"
  >
    {{ error }}
  </div>

  <div
    v-else
    class="relative flex h-full flex-col overflow-hidden"
    @dragenter="handleDragEnter"
    @dragover="handleDragOver"
    @dragleave="handleDragLeave"
    @drop="handleDrop"
  >
    <!-- 拖拽遮罩 -->
    <div v-if="isDragOver" class="drop-zone-overlay">
      <!-- ... SVG 图标 ... -->
    </div>

    <!-- 空状态 -->
    <div v-if="isEmptyNew" class="flex flex-1 flex-col items-center justify-center">
      <div class="w-full max-w-[820px]">
        <div class="title-row">
          <span class="title">Maddie Agent Web</span>
          <span class="typewriter">
            <Typewriter :phrases="TYPEWRITER_PHRASES" />
          </span>
        </div>
        <ChatInput
          ref="chatInputRef"
          :is-streaming="false"
          :model="displayModel"
          :model-names="modelNames"
          :model-list="modelList"
          @send="handleSend"
          @model-change="handleModelChange"
        />
      </div>
    </div>

    <!-- 消息列表 -->
    <template v-else>
      <div ref="scrollContainerRef" class="flex-1 overflow-y-auto pt-4">
        <div class="mx-auto max-w-[820px] px-4">
          <MessageView
            v-for="(msg, idx) in messages"
            :key="idx"
            :message="msg"
            :model-names="modelNames"
            :entry-id="entryIds[idx]"
            :forking="forkingEntryId === entryIds[idx]"
            :show-timestamp="shouldShowTimestamp(msg, idx)"
            @fork="handleFork"
            @navigate="handleNavigate"
          />

          <!-- 流式消息 -->
          <MessageView
            v-if="streamState.isStreaming && streamState.streamingMessage"
            :message="streamState.streamingMessage"
            :is-streaming="true"
            :model-names="modelNames"
          />

          <!-- 运行中的状态指示器 -->
          <div v-if="agentRunning && !streamState.streamingMessage" class="agent-phase">
            {{ phaseLabel(agentPhase) }}
          </div>

          <div ref="messagesEndRef" />
        </div>
      </div>

      <!-- 输入栏 -->
      <ChatInput
        ref="chatInputRef"
        :is-streaming="agentRunning"
        :is-compacting="isCompacting"
        :compact-error="compactError"
        :model="displayModel"
        :model-names="modelNames"
        :model-list="modelList"
        :tool-preset="toolPreset"
        :thinking-level="thinkingLevel"
        :retry-info="retryInfo"
        :sound-enabled="soundEnabled"
        @send="handleSend"
        @abort="handleAbort"
        @steer="handleSteer"
        @follow-up="handleFollowUp"
        @model-change="handleModelChange"
        @compact="handleCompact"
        @tool-preset-change="handleToolPresetChange"
        @thinking-level-change="handleThinkingLevelChange"
        @sound-toggle="onSoundToggle"
      />
    </template>
  </div>
</template>
```

### 6.2 MessageView.vue 的关键渲染逻辑

```vue
<!-- components/MessageView.vue -->
<script setup lang="ts">
const props = defineProps<{
  message: AgentMessage;
  isStreaming?: boolean;
  modelNames?: Record<string, string>;
  entryId?: string;
  forking?: boolean;
  showTimestamp?: boolean;
}>();

const emit = defineEmits<{
  fork: [entryId: string];
  navigate: [entryId: string];
}>();

// 思考内容（折叠面板）
const thinkingContent = computed(() => {
  if (props.message.role !== "assistant") return null;
  const content = props.message.content;
  if (!Array.isArray(content)) return null;
  return content.filter(b => b.type === "thinking");
});

// 文本内容（Markdown 渲染）
const textContent = computed(() => {
  if (props.message.role !== "assistant") return null;
  const content = props.message.content;
  if (!Array.isArray(content)) return null;
  return content.filter(b => b.type === "text");
});

// 工具调用
const toolCalls = computed(() => {
  if (props.message.role !== "assistant") return null;
  const content = props.message.content;
  if (!Array.isArray(content)) return null;
  return content.filter(b => b.type === "toolCall");
});

// 错误消息
const errorMessage = computed(() => {
  if (props.message.role === "assistant") {
    return (props.message as AssistantMessage).errorMessage;
  }
  return null;
});
</script>

<template>
  <!-- 用户消息 -->
  <div v-if="message.role === 'user'" class="user-message">
    <div class="user-bubble">
      <!-- 纯文本 -->
      <template v-if="typeof message.content === 'string'">
        {{ message.content }}
      </template>
      <!-- 内容块数组（文本 + 图片） -->
      <template v-else-if="Array.isArray(message.content)">
        <template v-for="(block, i) in message.content" :key="i">
          <p v-if="block.type === 'text'">{{ block.text }}</p>
          <img
            v-else-if="block.type === 'image'"
            :src="block.source.url || `data:${block.source.media_type};base64,${block.source.data}`"
            class="max-w-[400px] rounded-lg"
          />
        </template>
      </template>
    </div>
    <!-- Fork 按钮 -->
    <button
      v-if="entryId"
      class="fork-btn"
      :disabled="forking"
      @click="emit('fork', entryId!)"
    >
      {{ forking ? "分叉中..." : "分叉" }}
    </button>
  </div>

  <!-- 助手消息 -->
  <div v-else-if="message.role === 'assistant'" class="assistant-message">
    <!-- 思考内容折叠面板 -->
    <ThinkingBlock
      v-if="thinkingContent && thinkingContent.length > 0"
      :thinking="thinkingContent"
      :is-streaming="isStreaming"
    />

    <!-- 文本内容 → Markdown 渲染 -->
    <MessageContent
      v-for="(block, i) in textContent"
      :key="i"
      :content="block"
    />

    <!-- 工具调用面板 -->
    <ToolCallBlock
      v-for="(tc, i) in toolCalls"
      :key="i"
      :tool-call="tc"
      :result="getToolResult(tc.toolCallId)"
    />

    <!-- 错误消息 -->
    <div v-if="errorMessage" class="error-message">
      {{ errorMessage }}
    </div>

    <!-- 时间戳 + token 用量 -->
    <div v-if="showTimestamp" class="message-footer">
      <span class="timestamp">{{ formatTime(message.timestamp) }}</span>
      <span v-if="usage" class="usage">
        {{ usage.input }}↑ {{ usage.output }}↓
      </span>
    </div>

    <!-- Continue 按钮（分支导航） -->
    <button
      v-if="entryId && !isStreaming"
      class="continue-btn"
      @click="emit('navigate', entryId!)"
    >
      继续对话
    </button>
  </div>

  <!-- 工具结果消息 -->
  <div v-else-if="message.role === 'toolResult'" class="tool-result">
    <!-- 由父组件的 toolResultsMap 管理，不单独渲染 -->
  </div>
</template>
```

### 6.3 ChatInput.vue 的核心交互

```vue
<!-- components/ChatInput.vue -->
<script setup lang="ts">
const props = defineProps<{
  isStreaming: boolean;
  isCompacting?: boolean;
  compactError?: string | null;
  model?: { provider: string; modelId: string } | null;
  modelNames?: Record<string, string>;
  modelList?: { id: string; name: string; provider: string }[];
  toolPreset?: "none" | "default" | "full";
  thinkingLevel?: ThinkingLevelOption;
  retryInfo?: RetryInfo | null;
  soundEnabled?: boolean;
}>();

const emit = defineEmits<{
  send: [message: string, images?: AttachedImage[]];
  abort: [];
  steer: [message: string, images?: AttachedImage[]];
  followUp: [message: string, images?: AttachedImage[]];
  modelChange: [provider: string, modelId: string];
  compact: [];
  abortCompaction: [];
  toolPresetChange: [preset: "none" | "default" | "full"];
  thinkingLevelChange: [level: ThinkingLevelOption];
  soundToggle: [];
}>();

// 输入状态
const value = ref("");
const attachedImages = ref<AttachedImage[]>([]);
const modelDropdownOpen = ref(false);
const toolDropdownOpen = ref(false);
const thinkingDropdownOpen = ref(false);
const textareaRef = ref<HTMLTextAreaElement | null>(null);
const fileInputRef = ref<HTMLInputElement | null>(null);

// ── 暴露给父组件的方法 ──
defineExpose({
  insertText(text: string) {
    const ta = textareaRef.value;
    if (!ta) { value.value += (value.value ? " " : "") + text; return; }
    // ... 在光标位置插入文本
  },
  insertIfEmpty(content: string) {
    if (value.value.trim()) return;
    value.value = content;
  },
  addImages(files: File[]) {
    processImageFiles(files);
  },
});

// ── 发送 / 排队逻辑 ──
function handleSend() {
  const msg = value.value.trim();
  if (!msg && !attachedImages.value.length) return;
  if (props.isStreaming) return;
  
  emit("send", msg, attachedImages.value.length ? attachedImages.value : undefined);
  value.value = "";
  clearImages();
}

function sendQueued(mode: "steer" | "followup") {
  const msg = value.value.trim();
  if (!msg && !attachedImages.value.length) return;
  
  if (mode === "steer") emit("steer", msg, attachedImages.value.length ? attachedImages.value : undefined);
  else emit("followUp", msg, attachedImages.value.length ? attachedImages.value : undefined);
  
  value.value = "";
  clearImages();
}

// ── 键盘事件 ──
function handleKeyDown(e: KeyboardEvent) {
  if (e.key === "Enter" && !e.shiftKey && !e.isComposing) {
    e.preventDefault();
    if (props.isStreaming) {
      sendQueued("steer"); // 流式时默认发送 steer
    } else {
      handleSend();
    }
  }
}

// ── 图片处理 ──
async function processImageFiles(files: File[]) {
  const images = await Promise.all(
    files
      .filter(f => f.type.startsWith("image/"))
      .map(file => new Promise<AttachedImage>((resolve, reject) => {
        const reader = new FileReader();
        reader.onload = () => {
          const result = reader.result as string;
          const base64 = result.split(",")[1];
          resolve({
            data: base64,
            mimeType: file.type,
            previewUrl: URL.createObjectURL(file),
          });
        };
        reader.onerror = reject;
        reader.readAsDataURL(file);
      }))
  );
  attachedImages.value = [...attachedImages.value, ...images];
}

function removeImage(index: number) {
  URL.revokeObjectURL(attachedImages.value[index].previewUrl);
  attachedImages.value.splice(index, 1);
}

function clearImages() {
  attachedImages.value.forEach(img => URL.revokeObjectURL(img.previewUrl));
  attachedImages.value = [];
}

// ── 图片粘贴 ──
function handlePaste(e: ClipboardEvent) {
  const items = Array.from(e.clipboardData?.items ?? []);
  const imageItems = items.filter(item => item.type.startsWith("image/"));
  if (!imageItems.length) return;
  e.preventDefault();
  const files = imageItems
    .map(item => item.getAsFile())
    .filter((f): f is File => f !== null);
  processImageFiles(files);
}

// ── 模型下拉面板 ──
const modelsByProvider = computed(() => {
  const groups: { provider: string; options: ModelOption[] }[] = [];
  for (const opt of modelOptions.value) {
    const group = groups.find(g => g.provider === opt.provider);
    if (group) group.options.push(opt);
    else groups.push({ provider: opt.provider, options: [opt] });
  }
  return groups;
});
</script>

<template>
  <div class="chat-input-container">
    <!-- 重试横幅 -->
    <div v-if="retryInfo" class="retry-banner">
      正在重试（{{ retryInfo.attempt }}/{{ retryInfo.maxAttempts }}）…
    </div>

    <!-- 图片预览 -->
    <div v-if="attachedImages.length" class="image-previews">
      <div v-for="(img, i) in attachedImages" :key="i" class="image-thumb">
        <img :src="img.previewUrl" class="w-14 h-14 object-cover rounded" />
        <button @click="removeImage(i)" class="remove-btn">×</button>
      </div>
    </div>

    <!-- 主输入区 -->
    <div class="input-row" :class="{ streaming: isStreaming }">
      <textarea
        ref="textareaRef"
        v-model="value"
        :placeholder="placeholder"
        rows="1"
        @keydown="handleKeyDown"
        @input="handleInput"
        @paste="handlePaste"
        class="textarea"
      />

      <!-- 流式按钮：steer / followUp -->
      <div v-if="isStreaming" class="streaming-btns">
        <button
          :disabled="!value.trim() && !attachedImages.length"
          @click="sendQueued('steer')"
          class="steer-btn"
        >
          插入
        </button>
        <button
          :disabled="!value.trim() && !attachedImages.length"
          @click="sendQueued('followup')"
          class="followup-btn"
        >
          排队
        </button>
      </div>

      <!-- 空闲按钮：发送 -->
      <button
        v-else
        :disabled="!value.trim() && !attachedImages.length"
        @click="handleSend"
        class="send-btn"
      >
        发送
      </button>
    </div>

    <!-- 底部工具栏 -->
    <div class="toolbar">
      <!-- 左侧：附件 + 模型选择 -->
      <div class="toolbar-left">
        <!-- 添加图片 -->
        <button @click="fileInputRef?.click()" class="tool-btn">
          🖼
        </button>
        <input
          ref="fileInputRef"
          type="file"
          accept="image/*"
          multiple
          hidden
          @change="(e) => {
            processImageFiles(Array.from((e.target as HTMLInputElement).files ?? []));
            (e.target as HTMLInputElement).value = '';
          }"
        />

        <!-- 模型选择器 -->
        <div v-if="modelOptions.length" class="dropdown" ref="modelDropdownRef">
          <button @click="modelDropdownOpen = !modelDropdownOpen" class="tool-btn">
            {{ currentName }}
          </button>
          <div v-if="modelDropdownOpen" class="dropdown-panel">
            <template v-for="group in modelsByProvider" :key="group.provider">
              <div class="provider-label">{{ group.provider }}</div>
              <button
                v-for="opt in group.options"
                :key="`${opt.provider}:${opt.modelId}`"
                :class="{ active: isCurrentModel(opt) }"
                @click="selectModel(opt); modelDropdownOpen = false"
              >
                {{ opt.name }}
              </button>
            </template>
          </div>
        </div>
      </div>

      <!-- 右侧：推理 → 工具 → 压缩 → 停止 → 声音 -->
      <div class="toolbar-right">
        <!-- 推理等级 -->
        <div class="dropdown">
          <button @click="thinkingDropdownOpen = !thinkingDropdownOpen" class="tool-btn">
            {{ THINKING_LEVEL_LABELS[thinkingLevel ?? 'auto'] }}
          </button>
        </div>

        <!-- 工具预设 -->
        <div class="dropdown">
          <button @click="toolDropdownOpen = !toolDropdownOpen" class="tool-btn">
            {{ TOOL_PRESET_LABELS[toolPreset ?? 'default'] }}
          </button>
        </div>

        <!-- 压缩按钮 -->
        <button
          v-if="!isStreaming"
          :disabled="isStreaming && !isCompacting"
          @click="isCompacting ? emit('abortCompaction') : emit('compact')"
          class="tool-btn compact-btn"
        >
          {{ isCompacting ? "压缩中…" : "压缩" }}
        </button>

        <!-- 停止按钮 -->
        <button
          v-if="isStreaming"
          @click="emit('abort')"
          class="stop-btn"
        >
          停止
        </button>

        <!-- 声音开关 -->
        <button @click="emit('soundToggle')" class="tool-btn sound-btn">
          {{ soundEnabled ? "🔊" : "🔇" }}
        </button>
      </div>
    </div>
  </div>
</template>
```

## 7. 状态管理：Pinia Store

```typescript
// stores/appStore.ts
import { defineStore } from 'pinia';
import type { SessionInfo, Tab } from '@/types';

export const useAppStore = defineStore('app', () => {
  // 侧边栏
  const sidebarOpen = ref(true);
  
  // 当前会话
  const selectedSession = ref<SessionInfo | null>(null);
  const newSessionCwd = ref<string | null>(null);
  
  // 刷新触发器
  const sessionRefreshKey = ref(0);
  const sessionReloadKey = ref(0);
  
  // 文件面板
  const fileTabs = ref<Tab[]>([]);
  const activeFileTabId = ref<string | null>(null);
  const rightPanelOpen = ref(false);
  
  // 弹窗
  const modelsConfigOpen = ref(false);
  const skillsConfigOpen = ref(false);
  
  // 当前工作目录
  const activeCwd = ref<string | null>(null);
  
  // 分支导航
  const branchTree = ref<SessionTreeNode[]>([]);
  const branchActiveLeafId = ref<string | null>(null);
  
  // ── 方法 ──
  
  function selectSession(session: SessionInfo) {
    newSessionCwd.value = null;
    selectedSession.value = session;
    sessionReloadKey.value++;
  }
  
  function startNewSession(cwd: string) {
    selectedSession.value = null;
    newSessionCwd.value = cwd;
    sessionReloadKey.value++;
  }
  
  function openFile(filePath: string, fileName: string) {
    const tabId = `file:${filePath}`;
    if (!fileTabs.value.find(t => t.id === tabId)) {
      fileTabs.value.push({ id: tabId, label: fileName, filePath });
    }
    activeFileTabId.value = tabId;
    rightPanelOpen.value = true;
  }
  
  function closeFileTab(tabId: string) {
    fileTabs.value = fileTabs.value.filter(t => t.id !== tabId);
    if (fileTabs.value.length === 0) rightPanelOpen.value = false;
  }
  
  return {
    sidebarOpen,
    selectedSession, newSessionCwd,
    sessionRefreshKey, sessionReloadKey,
    fileTabs, activeFileTabId, rightPanelOpen,
    modelsConfigOpen, skillsConfigOpen,
    activeCwd,
    branchTree, branchActiveLeafId,
    selectSession, startNewSession,
    openFile, closeFileTab,
  };
});
```

## 8. TypeScript 类型定义

```typescript
// types/index.ts
// 与现有 lib/types.ts 完全一致，直接复制

export interface SessionHeader {
  type: "session";
  version?: number;
  id: string;
  timestamp: string;
  cwd: string;
  parentSession?: string;
}

export interface SessionEntryBase {
  type: string;
  id: string;
  parentId: string | null;
  timestamp: string;
}

export interface TextContent {
  type: "text";
  text: string;
}

export interface ImageContent {
  type: "image";
  source: {
    type: "base64" | "url";
    media_type?: string;
    data?: string;
    url?: string;
  };
}

export interface ThinkingContent {
  type: "thinking";
  thinking: string;
}

export interface ToolCallContent {
  type: "toolCall";
  toolCallId: string;
  toolName: string;
  input: Record<string, unknown>;
}

export type AssistantContentBlock =
  | TextContent
  | ImageContent
  | ThinkingContent
  | ToolCallContent;

export interface UserMessage {
  role: "user";
  content: string | (TextContent | ImageContent)[];
  timestamp?: number;
}

export interface AssistantMessage {
  role: "assistant";
  content: AssistantContentBlock[];
  model: string;
  provider: string;
  stopReason?: string;
  errorMessage?: string;
  timestamp?: number;
  usage?: {
    input: number;
    output: number;
    cacheRead: number;
    cacheWrite: number;
    cost: {
      input: number;
      output: number;
      cacheRead: number;
      cacheWrite: number;
      total: number;
    };
  };
}

export interface ToolResultMessage {
  role: "toolResult";
  toolCallId: string;
  toolName?: string;
  content: (TextContent | ImageContent)[];
  isError?: boolean;
  timestamp?: number;
}

export interface CustomMessage {
  role: "custom";
  customType: string;
  content: string | (TextContent | ImageContent)[];
  display: boolean;
  details?: unknown;
  timestamp?: number;
}

export type AgentMessage =
  | UserMessage
  | AssistantMessage
  | ToolResultMessage
  | CustomMessage;

export interface SessionMessageEntry extends SessionEntryBase {
  type: "message";
  message: AgentMessage;
}

export interface CompactionEntry extends SessionEntryBase {
  type: "compaction";
  summary: string;
  firstKeptEntryId: string;
  tokensBefore: number;
}

export interface ModelChangeEntry extends SessionEntryBase {
  type: "model_change";
  provider: string;
  modelId: string;
}

export interface SessionInfoEntry extends SessionEntryBase {
  type: "session_info";
  name?: string;
}

export type SessionEntry =
  | SessionMessageEntry
  | ModelChangeEntry
  | CompactionEntry
  | SessionInfoEntry;

export interface SessionTreeNode {
  entry: SessionEntry;
  children: SessionTreeNode[];
  label?: string;
}

export interface SessionInfo {
  path: string;
  id: string;
  cwd: string;
  name?: string;
  created: string;
  modified: string;
  messageCount: number;
  firstMessage: string;
  parentSessionId?: string;
}

export interface SessionContext {
  messages: AgentMessage[];
  entryIds: string[];
  thinkingLevel: string;
  model: { provider: string; modelId: string } | null;
}

export interface Tab {
  id: string;
  label: string;
  filePath: string;
}

// 其他类型...
export type ThinkingLevelOption =
  "auto" | "off" | "minimal" | "low" | "medium" | "high" | "xhigh";

export interface AttachedImage {
  data: string;
  mimeType: string;
  previewUrl: string;
}
```

## 9. Vite 配置

```typescript
// vite.config.ts
import { defineConfig } from 'vite';
import vue from '@vitejs/plugin-vue';
import tailwindcss from '@tailwindcss/vite';
import { resolve } from 'path';

export default defineConfig({
  plugins: [
    vue(),
    tailwindcss(),
  ],
  resolve: {
    alias: {
      '@': resolve(__dirname, 'src'),
    },
  },
  server: {
    port: 5173,
    proxy: {
      '/api': {
        target: 'http://localhost:8000',  // FastAPI 后端
        changeOrigin: true,
      },
    },
  },
});
```

## 10. CSS 变量（全局样式）

```css
/* globals.css */
:root {
  --bg: #f8f9fa;
  --bg-panel: #ffffff;
  --bg-hover: rgba(0, 0, 0, 0.04);
  --bg-selected: rgba(37, 99, 235, 0.08);
  --border: rgba(0, 0, 0, 0.08);
  --text: #1a1a2e;
  --text-muted: #64748b;
  --text-dim: #94a3b8;
  --accent: #2563eb;
  --user-bg: #eff6ff;
  --tool-bg: #f1f5f9;
  --font-mono: 'JetBrains Mono', 'Fira Code', 'Consolas', monospace;
}

.dark {
  --bg: #0f172a;
  --bg-panel: #1e293b;
  --bg-hover: rgba(255, 255, 255, 0.05);
  --bg-selected: rgba(37, 99, 235, 0.15);
  --border: rgba(255, 255, 255, 0.08);
  --text: #e2e8f0;
  --text-muted: #94a3b8;
  --text-dim: #64748b;
  --accent: #3b82f6;
  --user-bg: #1e3a5f;
  --tool-bg: #1e293b;
}
```

## 11. 实施顺序

| 周 | 任务 | 产出 |
|:---:|------|------|
| 1 | 项目初始化 + 类型定义 + 基础布局 | Vite 项目搭建，AppShell 三栏布局，CSS 变量 |
| 1 | API 请求封装 + Session 列表 | `lib/api.ts`，SessionSidebar 基础版 |
| 2 | useAgentSession composable（核心） | Agent 状态管理，SSE 连接，事件处理 |
| 2 | ChatWindow + ChatInput 基础版 | 发送消息 + 流式显示（纯文本） |
| 3 | MessageView 完整渲染 | Markdown 渲染 + 代码高亮 + 思考折叠 |
| 3 | ChatInput 完整功能 | 模型选择、推理等级、工具预设、图片附件 |
| 4 | 工具调用/结果面板 | ToolCallBlock，折叠/展开，输出截断 |
| 4 | 高级功能 | Fork / BranchNavigator / Compact / Steer |
| 5 | 文件查看器 + 文件树 | FileViewer + FileExplorer（右侧面板） |
| 5 | 弹窗 + 配置页 | ModelsConfig，SkillsConfig |
| 6 | 深色模式 + 声音 + 拖拽 | 主题切换，完成提示音，拖拽上传 |
| 6 | 打磨 + 测试 | 移动端响应式，断线重连，边界情况 |

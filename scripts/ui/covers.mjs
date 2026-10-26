/**
 * 界面检查分片覆盖的源码范围：改了哪个文件就跑哪个分片（scripts/changed-tests.mjs 用它定位）。
 *
 * 每项是一组「路径前缀」：以 / 结尾表示目录（`web/src/components/tasks/` 命中它下面的所有文件），
 * 否则按完整文件路径算。一个文件可以命中多个分片（设置页同时被 05、06 覆盖；任务页拆出的
 * 02 / 02b / 02c 三片覆盖同一批组件），这时命中的分片都要跑。
 *
 * 只写已经确认覆盖到的源码：没有列进来的 web/src 路径（通用 UI 组件、lib 里的公共逻辑、
 * 演示数据这类影响所有页面的）会被 changed-tests 标成「映射不出来」，提示跑全量的界面检查——
 * 宁可多跑，也不因为漏了一条映射就少跑一个会坏的页面。
 *
 * 新增分片或分片多了检查范围时**同步改这张表**：改了脚本自己也要跑对应分片，
 * changed-tests 对 scripts/ui/*.mjs 的改动按分片编号直接映射。
 */
export const UI_SHARD_COVERS = {
  '01-composer': ['web/src/components/chat/', 'web/src/pages/ChatPage.tsx'],
  // 任务页拆成 02 / 02b / 02c 三片：它们的场景都在同一批组件里（TaskView 的渲染树），
  // 拆不出互不重叠的前缀，所以三片登记同一批源码——改任务页的组件时三片一起跑，宁可多跑不漏跑
  '02-task': [
    'web/src/components/tasks/',
    'web/src/components/files/',
    'web/src/lib/tasks.ts',
    'web/src/pages/ChatPage.tsx',
  ],
  '02b-subagent': [
    'web/src/components/tasks/',
    'web/src/components/files/',
    'web/src/lib/tasks.ts',
    'web/src/pages/ChatPage.tsx',
  ],
  '02c-element-pick': [
    'web/src/components/tasks/',
    'web/src/components/files/',
    'web/src/lib/tasks.ts',
    'web/src/pages/ChatPage.tsx',
  ],
  '03-library': [
    'web/src/components/library/',
    'web/src/components/agents/',
    'web/src/components/workflows/',
    'web/src/pages/WorkflowsPage.tsx',
    'web/src/pages/AgentsPage.tsx',
    'web/src/pages/McpPage.tsx',
  ],
  '04-design': [
    'web/src/components/design/',
    'web/src/components/comfy/',
    'web/src/components/ai-window/',
    'web/src/pages/DesignPage.tsx',
    'web/src/pages/ComfyPage.tsx',
  ],
  '05-settings': ['web/src/components/settings/', 'web/src/components/usage/', 'web/src/pages/SettingsPage.tsx'],
  '06-settings-agent': [
    'web/src/components/settings/',
    'web/src/components/ai-window/',
    'web/src/components/assist/',
    'web/src/pages/SettingsPage.tsx',
  ],
  '07-projects': [
    'web/src/components/projects/',
    'web/src/components/layout/',
    'web/src/components/tags/',
    'web/src/pages/ProjectsPage.tsx',
    'web/src/pages/HomePage.tsx',
  ],
  '08-comfy': ['web/src/components/comfy/', 'web/src/pages/ComfyPage.tsx'],
  '09-hint': ['web/src/components/ui/hint.tsx'],
  // 计划面板（shared/plan.ts 那套数据的界面）
  '09-plans': ['web/src/pages/SchedulesPage.tsx'],
  '09-summary': ['web/src/pages/SummaryPage.tsx', 'web/src/lib/summary-page.ts'],
  '10-toast': ['web/src/lib/toast.ts', 'web/src/lib/toast-queue.ts'],
}

/**
 * 分片文件名（`scripts/ui/` 下）→ 界面检查的筛选参数。
 * 用完整文件名（不带 .mjs）而不是只写编号：`09` 会同时跑 09-hint / 09-plans / 09-summary 三个
 */
export const shardFilter = (file) => String(file).replace(/\.mjs$/, '')

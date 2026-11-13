import { t } from '@shared/i18n'

/**
 * 设置 → Markdown 样式 → Mermaid 图的预览样例：每种常用图一张，切换着看风格、连线、圆角在各种图上的效果。
 * 样例内容是演示数据，不翻译；只有切换按钮上的图名走 t()。
 */
const fence = (body: string) => '```mermaid\n' + body + '\n```'

export const MERMAID_SAMPLES = {
  flow: fence(
    'flowchart LR\n  A([收到需求]) --> B[拆成任务] --> C{评审通过?}\n  C -- 是 --> D[合并] --> F([发布])\n  C -- 否 --> E[返工] --> C',
  ),
  sequence: fence(
    'sequenceDiagram\n  participant U as 用户\n  participant P as 面板\n  participant A as Agent\n  U->>P: 发起任务\n  P->>A: 派单\n  activate A\n  A-->>P: 提交计划\n  Note over P,A: 等用户确认\n  P->>U: 请确认计划\n  U->>P: 同意\n  A-->>P: 完成\n  deactivate A',
  ),
  class: fence(
    'classDiagram\n  class Task {\n    +string id\n    +string title\n    +start() void\n  }\n  class Agent {\n    +string cli\n    +run(task) Result\n  }\n  class Coordinator {\n    +plan() Plan\n  }\n  Task --> Agent : 派给\n  Agent <|-- Coordinator',
  ),
  state: fence(
    'stateDiagram-v2\n  [*] --> 排队\n  排队 --> 执行中\n  执行中 --> 等你确认 : 需要确认\n  等你确认 --> 执行中 : 同意\n  执行中 --> 完成\n  完成 --> [*]',
  ),
  er: fence(
    'erDiagram\n  PROJECT ||--o{ TASK : 包含\n  TASK ||--|{ MESSAGE : 产生\n  PROJECT {\n    string id PK\n    string name\n  }\n  TASK {\n    string id PK\n    string project FK\n    string status\n  }',
  ),
  gantt: fence(
    'gantt\n  dateFormat YYYY-MM-DD\n  axisFormat %m-%d\n  section 设计\n    效果图 :done, a1, 2026-11-10, 2d\n    评审 :active, a2, after a1, 1d\n  section 开发\n    实现 :a3, after a2, 3d\n    检查 :crit, a4, after a3, 1d',
  ),
  pie: fence('pie title 用量分布\n  "Claude Code" : 46\n  "Codex" : 28\n  "Command Code" : 16\n  "Pi" : 10'),
} as const

export type MermaidSample = keyof typeof MERMAID_SAMPLES

/** 切换按钮上的图名：静态写出来，文案检查才认得 */
export const mermaidSampleLabel = (k: MermaidSample) =>
  ({
    flow: t('流程图'),
    sequence: t('时序图'),
    class: t('类图'),
    state: t('状态图'),
    er: t('ER 图'),
    gantt: t('甘特图'),
    pie: t('饼图'),
  })[k]

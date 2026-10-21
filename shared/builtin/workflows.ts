import type { FlowEdge, FlowNode, NodeHooks, NodeStep, ParamValues, WorkflowExpose, WorkflowInput } from '../schema.ts'
import { autoLayout, END, START } from '../flow.ts'

/**
 * 内置工作流：按「需求 → 设计 → 实现 → 验收 → 文档 → 版本控制」整理的日常开发流程，加上 UE 和美术资产链。
 * 节点里的 agent 写内置 Agent 的 key（./agents.ts），添加时换成本机的 Agent id。
 * 节点说明是交给 CLI 的提示词，不翻译。
 */
interface NodeStepSpec {
  id: string
  title: string
  agent: string
  tier?: FlowNode['tier']
  params?: ParamValues
  instructions: string
  /** 这一步完成后执行的验收流程（同一工作流里的流程 id） */
  review?: string
  maxRounds?: number
  /** 这一步完成后等用户确认 */
  confirm?: boolean
  retries?: number
}
interface NodeSpec {
  id: string
  title: string
  /** 单执行者节点用；有 steps 时不需要 */
  agent?: string
  tier?: FlowNode['tier']
  params?: ParamValues
  instructions: string
  /** 按顺序执行的步骤：上一步的输出作为下一步的输入 */
  steps?: NodeStepSpec[]
  /** 完成后执行的验收流程（同一工作流里的流程 id） */
  review?: string
  maxRounds?: number
  /** 完成后等用户确认 */
  confirm?: boolean
  retries?: number
}
interface FlowSpec {
  id: string
  name: string
  description?: string
  nodes: NodeSpec[]
  /** [from, to, 条件]；start / end 是流程的开始和结束 */
  edges: [string, string, ('pass' | 'fail')?][]
}
export interface BuiltinWorkflow {
  key: string
  name: string
  description: string
  /** 放进哪个工作流分类（按名字找，没有就建） */
  category: string
  /** 主 Agent（常驻编排器，也是处理追加要求的那一个） */
  main: string
  members: [string, string][]
  document: string
  /** 对外暴露给项目的配置项 */
  expose?: WorkflowExpose[]
  flows: FlowSpec[]
}

/** 「通用项目」的 key：项目没有指定工作流时用它（启动时自动装一次） */
export const GENERAL_KEY = 'project-general'
export const GENERAL_ORIGIN = `builtin:${GENERAL_KEY}`
export const GENERAL_NAME = '通用项目'

/** 「UE 项目」的 key */
export const UE_PROJECT_KEY = 'project-ue'
export const UE_PROJECT_NAME = 'UE 项目'

/** 串起来：a → b → c */
const chain = (...ids: string[]) => ids.slice(1).map((id, i) => [ids[i], id] as [string, string])

/**
 * 通用的验收流程：一个验收员节点查回归、跑验证、给结论。
 * 原来是「回归审查 → 跑验证」两个节点，合成一个少一轮交接；返工时续接这个节点的会话
 */
const CHECK: FlowSpec = {
  id: 'check',
  name: '验收',
  description: '查回归 + 跑验证，不通过时把意见交回节点继续完善',
  nodes: [
    {
      id: 'verify',
      title: '验收',
      agent: 'verifier',
      tier: 'medium',
      params: { regress: true },
      instructions:
        '验收上面「输入」里这次的改动：先查有没有破坏已有行为、相关模块 bugs.md 里的历史 Bug 有没有复发，再对照验收标准跑构建、测试和检查。逐条写证据，最后单独一行写「验收结论：通过」或「验收结论：不通过」。',
    },
  ],
  edges: chain(START, 'verify', END),
}

/** 项目结构技能的选择项：通用项目和 UE 项目各一份，能用 expose 换 */
const STRUCTURE: WorkflowExpose = {
  key: 'projectStructure',
  label: '项目结构技能',
  type: 'select',
  options: ['project-structure', 'ue-project-structure'],
  default: 'project-structure',
  target: 'skill',
  targetId: 'projectStructure',
  description: '编排器用来了解这个项目的目录、构建、测试和运行方式',
}

/** 文档根：填了就直接用，留空按 project-documentation 的规则自己确定 */
const DOC_ROOT: WorkflowExpose = {
  key: 'docRoot',
  label: '文档根',
  type: 'text',
  options: [],
  default: '',
  target: 'agent',
  targetId: 'docRoot',
  description: '项目文档放在哪；P4 项目的文档一般在项目目录外面',
}

/** 提交方式：本地提交 / 只检查 */
const COMMIT: WorkflowExpose = {
  key: 'commitPolicy',
  label: '提交方式',
  type: 'select',
  options: ['本地提交', '只检查'],
  default: '本地提交',
  target: 'node',
  targetId: 'deliver',
  description: '本地提交只做本地 commit / pending；推送和 submit 要单独授权',
}

/**
 * 「通用项目」原来的主流程（5 个节点）：只用于迁移本机已经装过的旧副本。
 * 方案确认和实现、文档同步和交付后来各自合并成一个多步骤节点，这里的定义保持原样
 */
export const GENERAL_MAIN_LEGACY: FlowSpec = {
  id: 'main',
  name: '主流程',
  nodes: [
    {
      id: 'discover',
      title: '需求与现状',
      agent: 'analyst',
      tier: 'medium',
      params: { scene: true, scale: 'bounded' },
      instructions:
        '先识别现场（版本控制、文档根、已有改动、相关模块和构建 / 测试命令），再用一两句复述这次要做什么；不清楚的地方问用户。',
    },
    {
      id: 'design',
      title: '方案确认',
      agent: 'analyst',
      tier: 'high',
      params: { scale: 'bounded' },
      confirm: true,
      instructions: '结合上面的现场结果给出简短方案：做法、要改的文件、验证方式、验收标准。等用户确认后再进入实现。',
    },
    {
      id: 'impl',
      title: '实现',
      agent: 'developer',
      tier: 'high',
      params: { lang: '多种', tdd: false },
      review: 'check',
      maxRounds: 3,
      retries: 1,
      instructions:
        '按已确认的方案实现并自测。改动分成几块互不依赖、不改同一个文件时，用 spawn_agents 派子 Agent 并行做，自己负责拆分、取回结果后统一检查。',
    },
    {
      id: 'docs',
      title: '文档同步',
      agent: 'docsync',
      tier: 'low',
      instructions: '把这次改动同步进项目文档；没有要更新的写明原因。',
    },
    {
      id: 'deliver',
      title: '交付',
      agent: 'deliver',
      tier: 'low',
      params: { docs: false, commit: '本地提交' },
      instructions: '文档节点已经同步过了，这里只做版本控制收尾。推送 / submit 没有授权时不做，写清楚等用户授权。',
    },
  ],
  edges: chain(START, 'discover', 'design', 'impl', 'docs', 'deliver', END),
}

/** 「通用项目」：任何类型的项目都能用的常驻流程 */
export const GENERAL: BuiltinWorkflow = {
  key: GENERAL_KEY,
  name: GENERAL_NAME,
  description:
    '项目默认的常驻流程：常驻编排器管住文档、测试和版本管理，按流程图走 需求 → 方案 → 实现 → 测试 → 文档 → 交付',
  category: '项目',
  main: 'orchestrator',
  members: [
    ['orchestrator', '常驻编排器：评估节点结果、起停运行、守住文档 / 测试 / 版本管理的一致性'],
    ['analyst', '识别现场，收敛需求，出方案等你确认'],
    ['developer', '按确认的方案实现'],
    ['projecttest', '按项目的测试流程验证，给带证据的结论'],
    ['docsync', '同步项目文档'],
    ['deliver', '版本控制收尾'],
  ],
  document: `## 适用
项目里的日常开发：需求、方案、实现、测试、文档、交付。工作流可以按顺序跑很多次，每次都是完整的一遍。

## 约定
- 版本控制和文档根由「常驻编排器」统一确定，后面的节点按它的结论操作。
- 方案确认之前不写代码；确认之后中途不再逐步确认，遇到不可逆操作、需求矛盾、和方案冲突时才停下。
- 测试按项目的流程跑，没有本轮的新鲜证据不算完成。
- 版本管理：本地提交 / pending 保持一致；推送、PR、submit 这类对外操作要得到授权。
- 只改任务范围内的文件，不覆盖、不认领用户已有的改动。`,
  expose: [STRUCTURE, DOC_ROOT, COMMIT],
  flows: [
    {
      id: 'main',
      name: '主流程',
      nodes: [
        {
          id: 'discover',
          title: '需求与现状',
          agent: 'analyst',
          tier: 'medium',
          params: { scene: true, scale: 'bounded' },
          instructions:
            '先识别现场（版本控制、文档根、已有改动、相关模块和构建 / 测试命令），再用一两句复述这次要做什么；不清楚的地方问用户。',
        },
        {
          id: 'design',
          title: '方案与实现',
          instructions: '',
          steps: [
            {
              id: 'plan',
              title: '方案确认',
              agent: 'analyst',
              tier: 'high',
              params: { scale: 'bounded' },
              confirm: true,
              instructions:
                '结合上面的现场结果给出简短方案：做法、要改的文件、验证方式、验收标准。等用户确认后再进入实现。',
            },
            {
              id: 'impl',
              title: '实现',
              agent: 'developer',
              tier: 'high',
              params: { lang: '多种', tdd: false },
              review: 'check',
              maxRounds: 3,
              retries: 1,
              instructions:
                '按已确认的方案实现并自测。改动分成几块互不依赖、不改同一个文件时，用 spawn_agents 派子 Agent 并行做，自己负责拆分、取回结果后统一检查。',
            },
          ],
        },
        {
          id: 'docs',
          title: '文档与交付',
          instructions: '',
          steps: [
            {
              id: 'docsync',
              title: '文档同步',
              agent: 'docsync',
              tier: 'low',
              instructions: '把这次改动同步进项目文档；没有要更新的写明原因。',
            },
            {
              id: 'deliver',
              title: '交付',
              agent: 'deliver',
              tier: 'low',
              params: { docs: false, commit: '本地提交' },
              instructions:
                '上一步已经同步过文档，这里只做版本控制收尾。推送 / submit 没有授权时不做，写清楚等用户授权。',
            },
          ],
        },
      ],
      edges: chain(START, 'discover', 'design', 'docs', END),
    },
    {
      id: 'docs-init',
      name: '文档初始化',
      description: '第一次接触这个项目时确定 PROJECT_ROOT / DOC_ROOT，补最小必要的文档',
      nodes: [
        {
          id: 'init',
          title: '文档初始化',
          agent: 'docsync',
          tier: 'low',
          instructions:
            '读项目入口和一级目录，确定 PROJECT_ROOT 和 DOC_ROOT。文档入口或模块地图缺失时按 project-documentation 初始化最小必要的一套；已经齐了就直接说明现状，不要重写。',
        },
      ],
      edges: chain(START, 'init', END),
    },
    {
      id: 'test',
      name: '测试验证',
      description: '按项目的测试流程跑构建、测试和检查，给带证据的结论',
      nodes: [
        {
          id: 'verify',
          title: '测试验证',
          agent: 'projecttest',
          tier: 'medium',
          params: { scene: false },
          instructions:
            '验证上面「输入」里的改动：先找项目自己的验证命令，再跑改动的单元、受影响的回归、构建和静态检查。跑不了的登记为延期验证。',
        },
      ],
      edges: chain(START, 'verify', END),
    },
    CHECK,
  ],
}

/** 「通用项目」旧版的完整定义：迁移用，和新的只差主流程 */
export const GENERAL_LEGACY: BuiltinWorkflow = {
  ...GENERAL,
  flows: [GENERAL_MAIN_LEGACY, ...GENERAL.flows.slice(1)],
}

/** 「UE 项目」：在「通用项目」的基础上换成 UE 的结构技能和编译验收 */
const UE_PROJECT: BuiltinWorkflow = {
  key: UE_PROJECT_KEY,
  name: UE_PROJECT_NAME,
  description: 'UE 项目的常驻流程：UE 结构规范和编译验收，按 C++ / Lua、资源、Cook 的规则走',
  category: '项目',
  main: 'orchestrator',
  members: [
    ['orchestrator', '常驻编排器：按 UE 的结构、编译和资产规则调度'],
    ['uescout', '只读侦察架构、构建、资产和影响面'],
    ['analyst', '出方案等你确认'],
    ['developer', 'C++ / Lua 实现'],
    ['ueintegrator', '唯一负责编译和 Lua 检查'],
    ['projecttest', '验收，登记需要 Editor 的延期验证'],
    ['deliver', '版本控制收尾'],
  ],
  document: `## 适用
Unreal Engine 项目的 C++ / Lua / 资源改动。工作流可以按顺序跑很多次。

## 约定
- 模块、Build.cs / Target.cs、UHT/UBT、资产和 Cook 的规则按 ue-project-structure 技能。
- 编译只由「UE 集成员」做，同一时间只编译一次（-WaitMutex）；需要 Editor、PIE 或设备的验证登记为延期验证。
- 文档、测试、版本管理沿用在「通用项目」里的规则。
- Git 只提交本次任务的文件、按功能拆本地提交；P4 只分 pending，不 sync、不 submit。推送 / submit 要授权。`,
  expose: [{ ...STRUCTURE, default: 'ue-project-structure' }, DOC_ROOT, COMMIT],
  flows: [
    {
      id: 'main',
      name: '主流程',
      nodes: [
        {
          id: 'scout',
          title: '识别现场与侦察',
          agent: 'uescout',
          tier: 'medium',
          params: { scene: true, focus: '综合' },
          instructions:
            '先识别现场（Git 的分支和未提交改动，P4 的 client、stream 和限定路径的 opened，或者没有版本控制）和文档根；再侦察模块、构建和影响面，包括 C++ 与 Lua 的调用边界。',
        },
        {
          id: 'design',
          title: '确认方案',
          agent: 'analyst',
          tier: 'high',
          params: { scale: 'bounded' },
          confirm: true,
          instructions:
            '结合侦察结果给出方案：改动的模块和文件、C++ / Lua 分工、导出和反射边界、验证方式。等用户确认。',
        },
        {
          id: 'impl',
          title: '实现',
          agent: 'developer',
          tier: 'high',
          params: { lang: '多种', tdd: false },
          review: 'compile',
          maxRounds: 3,
          retries: 1,
          instructions:
            '按已确认的方案实现。C++ 和 Lua 两边互不依赖时可以派子 Agent 并行改，导出和反射边界由你统一核对。不要自己编译。',
        },
        {
          id: 'docs',
          title: '文档同步',
          agent: 'docsync',
          tier: 'low',
          instructions: '把这次改动同步进识别出的文档根里的模块文档；没有要更新的写明原因。',
        },
        {
          id: 'deliver',
          title: '交付',
          agent: 'deliver',
          tier: 'low',
          params: { docs: false, commit: '本地提交' },
          instructions: '按识别出的版本控制做收尾；推送 / submit 没有授权时不做。',
        },
      ],
      edges: chain(START, 'scout', 'design', 'impl', 'docs', 'deliver', END),
    },
    {
      id: 'docs-init',
      name: '文档初始化',
      description: '确定 PROJECT_ROOT / DOC_ROOT，补最小必要的文档',
      nodes: [
        {
          id: 'init',
          title: '文档初始化',
          agent: 'docsync',
          tier: 'low',
          instructions: '确定两个根并按 project-documentation 补齐最小必要的文档入口和模块地图；已经齐了就说明现状。',
        },
      ],
      edges: chain(START, 'init', END),
    },
    {
      id: 'compile',
      name: '编译验收',
      description: '编译一次、Lua 语法检查，再按验收标准检查',
      nodes: [
        {
          id: 'build',
          title: '编译',
          agent: 'ueintegrator',
          tier: 'medium',
          instructions: '编译这次的改动，有 Lua 改动时做语法检查。',
        },
        {
          id: 'verify',
          title: '验收',
          agent: 'verifier',
          tier: 'medium',
          instructions:
            '编译不通过就直接判不通过。编译通过后对照方案逐条检查；需要 Editor、PIE 或设备的验证登记为延期验证。最后单独一行写「验收结论：通过」或「验收结论：不通过」。',
        },
      ],
      edges: chain(START, 'build', 'verify', END),
    },
  ],
}

export const BUILTIN_WORKFLOWS: BuiltinWorkflow[] = [
  {
    key: 'daily-dev',
    name: '日常开发',
    description: '边界清楚的功能和改动：识别现场并确认设计 → 实现并验收 → 同步文档并提交',
    category: '开发',
    main: 'developer',
    members: [
      ['analyst', '识别现场，收敛需求，出设计摘要等你确认'],
      ['developer', '按确认的设计实现'],
      ['verifier', '验收：查回归、跑验证'],
      ['vcs', '同步文档，本地提交 / P4 分桶'],
    ],
    document: `## 适用
边界清楚的功能、调整和小重构。需要完整规范链路的大功能用「功能开发（OpenSpec）」，Bug 用「Bug 修复」。

## 约定
- 设计确认之前不写代码；设计确认后中途不再逐步确认，遇到不可逆操作、需求矛盾、和设计冲突时才停下。
- 只改任务范围内的文件，不认领、不覆盖已有的改动。
- 版本控制只做本地提交（P4 只分 pending），push、submit 由你自己做。`,
    flows: [
      {
        id: 'main',
        name: '主流程',
        nodes: [
          {
            id: 'design',
            title: '识别现场与设计',
            agent: 'analyst',
            tier: 'high',
            params: { scene: true, scale: 'bounded' },
            confirm: true,
            instructions:
              '先识别现场，读文档定位和这次需求相关的模块和代码；再问清关键问题，给出简短设计：做法、改动的文件、测试方式、验收标准。',
          },
          {
            id: 'impl',
            title: '实现',
            agent: 'developer',
            tier: 'high',
            review: 'check',
            maxRounds: 3,
            retries: 1,
            instructions:
              '按已确认的设计实现并验证。改动分成几块互不依赖、不改同一个文件的部分时（例如后端接口和前端页面），用 spawn_agents 派子 Agent 并行实现，自己负责拆分、取回结果后统一检查和联调。',
          },
          {
            id: 'commit',
            title: '文档与提交',
            agent: 'vcs',
            tier: 'low',
            params: { docs: true },
            instructions: '把这次改动同步到相关模块的文档（没有要更新的写明原因），再把代码和文档一起做版本控制收尾。',
          },
        ],
        edges: chain(START, 'design', 'impl', 'commit', END),
      },
      CHECK,
    ],
  },
  {
    key: 'openspec',
    name: '功能开发（OpenSpec）',
    description:
      '复杂功能的完整链路：识别与前置检查 → 设计压测 → 规范门禁 → 按 tasks 实现 → 延期验证 → 归档 → 文档与提交',
    category: '开发',
    main: 'developer',
    members: [
      ['spec', '识别现场与前置检查、写规范、规范门禁、归档'],
      ['analyst', '收敛需求并压测设计'],
      ['impact', '实现前分析影响面和测试缺口'],
      ['developer', '按 tasks 实现'],
      ['verifier', '验收和延期验证'],
      ['vcs', '同步文档，本地提交 / P4 分桶'],
    ],
    document: `## 适用
需要完整规范的复杂功能（OpenSpec）。阶段顺序由这个工作流保证，openspec 技能只负责各阶段的产物和门禁。

## 关键门禁
- 前置检查不通过就停下，先把 OpenSpec 环境准备好。
- 设计共识和承载方式（新建规范 / 增补已有规范）一次确认。
- 规范要过门禁：openspec validate 通过、每条需求都有 task 覆盖验证、design 没有「待定」。
- tasks 每条验证通过才勾选，证据写进 acceptance；设计假设被证伪时停下回到设计。
- 归档前：没有未勾选项，每个勾选都有证据；先归档，再做版本控制收尾。
- push、PR、P4 submit 都由你自己做。`,
    flows: [
      {
        id: 'main',
        name: '主流程',
        nodes: [
          {
            id: 'pre',
            title: '识别现场与前置检查',
            agent: 'spec',
            tier: 'low',
            params: { scene: true, stage: '前置检查' },
            instructions: '先识别现场，读文档定位和这次需求相关的模块；再检查 OpenSpec 环境是否就绪。',
          },
          {
            id: 'design',
            title: '设计与压测',
            agent: 'analyst',
            tier: 'high',
            params: { scale: 'architectural', grill: true },
            confirm: true,
            instructions:
              '收敛需求，写一次性的设计摘要（目标、非目标、路线、验收初稿），再用 grilling 压测。最后请用户一次确认两件事：设计共识，以及承载方式（新建规范 / 增补已有的强关联规范）。',
          },
          {
            id: 'propose',
            title: '写规范',
            agent: 'spec',
            tier: 'high',
            params: { stage: '落规范' },
            review: 'gate',
            maxRounds: 3,
            instructions: '按确认的设计和承载方式创建变更，写全 proposal、specs、design、tasks 和 acceptance 骨架。',
          },
          {
            id: 'impact',
            title: '影响面与测试缺口',
            agent: 'impact',
            tier: 'low',
            params: { tests: true },
            instructions:
              '按 specs 和 tasks 分析这次变更波及的模块、入口和契约，并找出已有测试和需要补的边界、回归用例，给实现节点参考。',
          },
          {
            id: 'impl',
            title: '按 tasks 实现',
            agent: 'developer',
            tier: 'high',
            params: { records: false },
            review: 'check',
            maxRounds: 3,
            retries: 1,
            instructions:
              '按 tasks.md 依次实现：每条先查相关历史 Bug，改完跑这条的验证，通过才勾选并把证据写进 acceptance。互不依赖、不改同一批文件的 tasks 可以用 spawn_agents 派子 Agent 并行做，勾选和证据由你统一核对后再写。做不了的验证登记为延期验证。发现设计假设不成立时停下，写明哪条假设、证据和受影响的 tasks。',
          },
          {
            id: 'deferred',
            title: '延期验证',
            agent: 'verifier',
            tier: 'medium',
            params: { scope: '整体', regress: false },
            confirm: true,
            instructions:
              '整体验收一遍，并把所有登记的延期验证项列出来，每项写怎么验证，请用户决定立即验证还是暂缓（暂缓的标为「待用户完成」）。',
          },
          {
            id: 'archive',
            title: '归档',
            agent: 'spec',
            tier: 'medium',
            params: { stage: '归档' },
            instructions: '检查归档门禁后归档这次变更。',
          },
          {
            id: 'commit',
            title: '文档与提交',
            agent: 'vcs',
            tier: 'low',
            params: { docs: true },
            instructions:
              '把这次变更同步到模块文档（命中的 Bug 更新 bugs.md），再把归档产生的目录移动、主 specs、文档和代码改动一起做版本控制收尾。',
          },
        ],
        edges: [
          ['start', 'pre'],
          ['pre', 'design', 'pass'],
          ...chain('design', 'propose', 'impact', 'impl', 'deferred', 'archive', 'commit', END),
        ],
      },
      {
        id: 'gate',
        name: '规范门禁',
        description: '检查规范是否能进入实现',
        nodes: [
          {
            id: 'gate',
            title: '规范门禁',
            agent: 'spec',
            tier: 'medium',
            params: { stage: '规范门禁' },
            instructions: '检查上面「输入」里的规范。',
          },
        ],
        edges: chain(START, 'gate', END),
      },
      CHECK,
    ],
  },
  {
    key: 'bugfix',
    name: 'Bug 修复',
    description: '先查历史 Bug，找到根因再修，验收通过后写 Bug 记录并提交',
    category: '问题处理',
    main: 'debugger',
    members: [
      ['debugger', '识别现场，找根因、写失败测试、修复'],
      ['verifier', '验收：查回归、跑验证'],
      ['vcs', '写 Bug 记录、同步文档，本地提交 / P4 分桶'],
    ],
    document: `## 适用
Bug、测试失败、线上问题。

## 约定
- 没找到根因不修；修复前先有能复现问题的测试或步骤，修复后它必须通过。
- 连续三次修复失败就停下来质疑设计。
- 修完写 Bug 记录：症状、复现、根因、修复、回归测试、防复发。`,
    flows: [
      {
        id: 'main',
        name: '主流程',
        nodes: [
          {
            id: 'fix',
            title: '定位并修复',
            agent: 'debugger',
            tier: 'high',
            params: { scene: true },
            review: 'check',
            maxRounds: 3,
            retries: 1,
            instructions: '先识别现场，定位相关模块，查 bugs.md 里有没有相似的历史 Bug；再定位根因并修复这个问题。',
          },
          {
            id: 'commit',
            title: 'Bug 记录与提交',
            agent: 'vcs',
            tier: 'low',
            params: { docs: true, bug: true },
            instructions: '为这次修复写 Bug 记录并同步相关模块文档，再把修复、测试和 Bug 记录一起做版本控制收尾。',
          },
        ],
        edges: chain(START, 'fix', 'commit', END),
      },
      CHECK,
    ],
  },
  {
    key: 'ue-dev',
    name: 'UE 功能开发',
    description: 'UE C++ / Lua 改动：识别与侦察 → 确认设计 → 实现（单独编译验收）→ 文档与提交（Git / P4 自动识别）',
    category: 'UE',
    main: 'developer',
    members: [
      ['uescout', '识别版本控制和文档根，架构、构建和影响面的只读侦察'],
      ['analyst', '出设计摘要等你确认'],
      ['developer', 'C++ / Lua 实现'],
      ['ueintegrator', '唯一负责编译和 Lua 检查'],
      ['verifier', '验收，登记需要 Editor 的延期验证'],
      ['vcs', '同步文档，Git 本地提交 / P4 按类型分 pending'],
    ],
    document: `## 适用
UE 项目里的 C++ / Lua 改动，Git、P4 或没有版本控制的项目都能用。

## 约定
- 版本控制在「识别现场与侦察」自动识别，后面的节点按识别结果操作；想固定成某一种，把节点参数里的「工作区」改成 git 或 p4。
- Git：只提交本次任务的文件，按功能拆本地提交，不 push。
- P4：只读识别 client / stream；修改前先 p4 edit / add 进 default；不 sync、不 submit、不 revert；最后按 [C++]、[XLSX]、[Lua]、[Other] 分 pending。
- 文档根：Git 项目用项目下的 docs；P4 项目用共同外层目录下的 ProjectDoc/doc/<项目文件夹名>，不写回 P4 项目目录。
- 编译只由「UE 集成员」做，同一时间只编译一次（-WaitMutex）。
- push、submit 由你自己做。`,
    flows: [
      {
        id: 'main',
        name: '主流程',
        nodes: [
          {
            id: 'scout',
            title: '识别现场与侦察',
            agent: 'uescout',
            tier: 'medium',
            params: { scene: true, focus: '综合' },
            instructions:
              '先识别现场（Git 的分支和未提交改动，P4 的 client、stream 和限定路径的 opened，或者没有版本控制）和文档根，结果里写明是哪种版本控制，后面的节点按它操作；再围绕这次需求做架构和构建方向的侦察，并分析波及的模块、入口和契约，包括 C++ 和 Lua 之间的调用边界。',
          },
          {
            id: 'design',
            title: '确认设计',
            agent: 'analyst',
            tier: 'high',
            params: { scale: 'bounded' },
            confirm: true,
            instructions:
              '结合上面的侦察结果，给出设计摘要：改动的模块和文件、C++ / Lua 分工、导出和反射边界、验证方式。',
          },
          {
            id: 'impl',
            title: '实现',
            agent: 'developer',
            tier: 'high',
            params: { lang: '多种', tdd: false },
            review: 'compile',
            maxRounds: 3,
            retries: 1,
            instructions:
              '按已确认的设计实现。C++ 和 Lua 两边互不依赖时可以用 spawn_agents 派子 Agent 并行改，导出和反射边界由你统一核对。P4 项目修改前先 p4 edit / add。不要自己编译（子 Agent 也不要），编译由验收流程里的 UE 集成员统一做。',
          },
          {
            id: 'commit',
            title: '文档与提交',
            agent: 'vcs',
            tier: 'low',
            params: { docs: true },
            instructions:
              '把这次改动同步到识别出的文档根里的模块文档；再按识别出的版本控制收尾：Git 只提交本次任务的文件、按功能拆本地提交；P4 核对 default changelist，按类型分 pending。',
          },
        ],
        edges: chain(START, 'scout', 'design', 'impl', 'commit', END),
      },
      {
        id: 'compile',
        name: '编译验收',
        description: '编译一次、Lua 语法检查，再按验收标准检查',
        nodes: [
          {
            id: 'build',
            title: '编译',
            agent: 'ueintegrator',
            tier: 'medium',
            instructions: '编译这次的改动，有 Lua 改动时做语法检查。',
          },
          {
            id: 'verify',
            title: '验收',
            agent: 'verifier',
            tier: 'medium',
            instructions:
              '编译不通过就直接判不通过。编译通过后对照设计逐条检查；需要 Editor、PIE 或设备的验证登记为延期验证。最后单独一行写「验收结论：通过」或「验收结论：不通过」。',
          },
        ],
        edges: chain(START, 'build', 'verify', END),
      },
    ],
  },
  {
    key: 'architecture',
    name: '架构设计',
    description: '识别现场并出候选方案 → 压测并确认 → 写成架构文档和 ADR',
    category: '规划',
    main: 'architect',
    members: [
      ['architect', '识别现场，读已有的架构文档，给候选方案和架构契约'],
      ['analyst', '压测方案'],
      ['docs', '写架构文档和 ADR'],
    ],
    document: `## 适用
新项目、新模块的架构，或者现有架构的评审和调整。只出设计和文档，不写实现代码。`,
    flows: [
      {
        id: 'main',
        name: '主流程',
        nodes: [
          {
            id: 'arch',
            title: '识别现场与候选方案',
            agent: 'architect',
            tier: 'high',
            params: { scene: true },
            instructions:
              '先识别现场，读已有的架构文档、ADR 和相关模块的 README；再给出 2–4 个候选方案和推荐方案的架构契约。',
          },
          {
            id: 'grill',
            title: '压测并确认',
            agent: 'analyst',
            tier: 'high',
            params: { scale: 'architectural', grill: true },
            confirm: true,
            instructions: '用 grilling 压测推荐方案，把决策点整理好，请用户确认最终方案。',
          },
          {
            id: 'docs',
            title: '写文档',
            agent: 'docs',
            tier: 'medium',
            instructions: '把确认的方案写进架构文档；长期决策写成 ADR 并登记索引；新术语更新 CONTEXT.md。',
          },
        ],
        edges: chain(START, 'arch', 'grill', 'docs', END),
      },
    ],
  },
  {
    key: 'review',
    name: '代码评审',
    description: '只读：先看影响面和测试缺口，再给出覆盖回归风险的分级评审意见',
    category: '质量',
    main: 'reviewer',
    members: [
      ['impact', '分析影响面和测试缺口'],
      ['reviewer', '查回归风险，汇总成分级评审意见'],
    ],
    document: `## 适用
评审一个分支、一组提交或一个 P4 changelist。全程只读，不改文件、不提交。
在任务描述里写清评审范围（分支、提交区间或 changelist 号）。`,
    flows: [
      {
        id: 'main',
        name: '主流程',
        nodes: [
          {
            id: 'impact',
            title: '影响面与测试缺口',
            agent: 'impact',
            tier: 'low',
            params: { tests: true },
            instructions: '分析评审范围内的改动波及的模块、入口和契约，并找出缺少的测试。',
          },
          {
            id: 'review',
            title: '评审意见',
            agent: 'reviewer',
            tier: 'high',
            instructions:
              '结合上面的结果，对评审范围内的 diff 给出分级的评审意见；对照相关模块的 bugs.md 看有没有回归和安全风险。改动涉及的模块很多时，可以用 spawn_agents 按模块派子 Agent 并行看，最后由你去重、定级、汇总。',
          },
        ],
        edges: chain(START, 'impact', 'review', END),
      },
    ],
  },
  {
    key: 'blender',
    name: 'Blender 建模与动画',
    description: '规格确认 → 分件建模 → 装配、动画与减面 → 质检确认 → 导出 UE',
    category: '美术',
    main: 'blender',
    members: [
      ['blender', '建模、装配、动画、减面和导出'],
      ['blenderqa', '体检、多视角对照、可拆分测试'],
    ],
    document: `## 适用
用无头 Blender 做可拆分的模型和动画，并导出到 UE。

## 约定
- 规格（部件清单、GRP_* 根、局部原点和轴、命名）确认后才开始建模。
- 每个阶段都要有截图或体检结果；不能只看一个视角下结论。
- 质检结果你确认后才导出 UE。不需要动画时在「装配、动画与减面」节点的说明里写明跳过。`,
    flows: [
      {
        id: 'main',
        name: '主流程',
        nodes: [
          {
            id: 'spec',
            title: '规格',
            agent: 'blender',
            tier: 'high',
            params: { stage: '解析与规格' },
            confirm: true,
            instructions: '解析参考并写出规格和模块契约，请用户确认。',
          },
          {
            id: 'parts',
            title: '分件建模',
            agent: 'blender',
            tier: 'high',
            params: { stage: '分件建模' },
            review: 'qa',
            maxRounds: 3,
            instructions: '按规格逐个部件建模。',
          },
          {
            id: 'assemble',
            title: '装配、动画与减面',
            agent: 'blender',
            tier: 'medium',
            params: { stage: '装配到减面' },
            instructions:
              '装配所有部件，处理材质和 UV；按需求做控制器动画（需求里没有动画就写明跳过）；最后在保持外观的前提下减面，和基线对照。',
          },
          {
            id: 'qa',
            title: '质检',
            agent: 'blenderqa',
            tier: 'medium',
            confirm: true,
            instructions: '对完整模型做质检，把并排对照图列出来请用户确认外观。',
          },
          {
            id: 'export',
            title: '导出 UE',
            agent: 'blender',
            tier: 'low',
            params: { stage: '导出 UE' },
            instructions: '导出到 UE 并更新制作进度。',
          },
        ],
        edges: chain(START, 'spec', 'parts', 'assemble', 'qa', 'export', END),
      },
      {
        id: 'qa',
        name: '质检',
        description: '单件体检和参考对照',
        nodes: [
          {
            id: 'qa',
            title: '质检',
            agent: 'blenderqa',
            tier: 'medium',
            instructions: '检查上面「输入」里完成的部件：单件体检、和参考裁切并排对照。',
          },
        ],
        edges: chain(START, 'qa', END),
      },
    ],
  },
  // 项目工作流放最后：默认选中项仍然是「日常开发」，旧项目迁移按 origin 找
  GENERAL,
  UE_PROJECT,
]

/** 内置工作流里用到的所有 Agent（key） */
export function builtinAgentKeys(w: BuiltinWorkflow) {
  const keys = new Set([w.main, ...w.members.map((m) => m[0])])
  for (const f of w.flows)
    for (const n of f.nodes) {
      if (n.agent) keys.add(n.agent)
      for (const s of n.steps ?? []) keys.add(s.agent)
    }
  return [...keys]
}

/** 换成本机的 Agent id，生成可以直接保存的工作流（分类、标签由调用方填） */
export function buildWorkflow(
  w: BuiltinWorkflow,
  agentId: (key: string) => string,
): Omit<WorkflowInput, 'categoryId' | 'tags'> {
  return {
    name: w.name,
    description: w.description,
    mainAgentId: agentId(w.main),
    // 子 Agent 在节点上选，不再单独列团队；members 只用来决定要建哪些 Agent
    members: [],
    entryFlowId: 'main',
    document: w.document,
    expose: w.expose ?? [],
    flows: w.flows.map((f) =>
      autoLayout({
        id: f.id,
        name: f.name,
        description: f.description ?? '',
        startPos: { x: 0, y: 0 },
        endPos: { x: 600, y: 0 },
        nodes: f.nodes.map((n): FlowNode => {
          const steps = (n.steps ?? []).map(
            (s, i): NodeStep => ({
              id: s.id || `st${i + 1}`,
              title: s.title,
              kind: 'agent',
              agentId: agentId(s.agent),
              flow: null,
              tier: s.tier ?? '',
              params: s.params ?? {},
              instructions: s.instructions,
              retries: s.retries ?? 0,
              ...(s.confirm && { confirm: true }),
              review: s.review ? { kind: 'sub', id: s.review } : null,
              maxRounds: s.maxRounds ?? 3,
            }),
          )
          return {
            id: n.id,
            title: n.title,
            kind: 'agent',
            agentId: steps.length ? '' : agentId(n.agent ?? ''),
            flow: null,
            tier: n.tier ?? '',
            params: n.params ?? {},
            steps,
            retries: steps.length ? 0 : (n.retries ?? 0),
            instructions: steps.length ? '' : n.instructions,
            x: 0,
            y: 0,
            hooks: {
              start: null,
              review: steps.length || !n.review ? null : { kind: 'sub', id: n.review },
              end: null,
              maxRounds: n.maxRounds ?? 3,
              ...(!steps.length && n.confirm && { confirm: true }),
            } satisfies NodeHooks,
          }
        }),
        edges: f.edges.map(([from, to, when], i): FlowEdge => ({ id: `e${i + 1}`, from, to, ...(when && { when }) })),
      }),
    ),
  }
}

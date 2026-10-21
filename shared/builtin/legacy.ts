import { GENERAL_LEGACY, type FlowSpec } from './workflows.ts'
import { SCENE_TEXT, VCS_TEXT } from './agents.ts'

/**
 * 旧版内置 Agent 和工作流的关键定义：只用于升级本机已经装过的副本。
 *
 * 判定原则是「语义完全没改过」才升级：节点、连线和说明都要和这里的旧定义一致（忽略坐标）。
 * 用户动过任何一处（改标题、改参数、改说明）就保留本机副本，见 install.ts 的 upgradeBuiltinWorkflows。
 * 这里只列会随本次合并变化、或引用了已合并 Agent 的流程；其余流程（例如文档初始化）不参与比较，
 * 升级后也保留本机的版本。
 *
 * 加新的升级时：把即将被替换掉的旧流程原样追加到对应数组的最后。
 */
export type LegacyWorkflow = { document: string; flows: FlowSpec[] }

/**
 * 已经合并进其他 Agent 的内置 Agent：本机副本仍然可用（用户的工作流可能还在引用它），
 * 但不再出现在「内置 Agent」里。description 后面会补一句说明，让用户知道去哪找新的。
 */
export const MERGED_AGENTS: Record<string, { into: string; note: string }> = {
  verifier: { into: 'tester', note: '已合并到「测试与验收」' },
  projecttest: { into: 'tester', note: '已合并到「测试与验收」' },
  ueintegrator: { into: 'tester', note: '编译已并入「测试与验收」的项目测试步骤' },
  docs: { into: 'docsync', note: '已合并到「文档同步」，ADR 和 Bug 记录改由参数控制' },
  deliver: { into: 'vcs', note: '已合并到「交付员」，推送授权说明也并了进去' },
}

/**
 * 旧版内置 Agent 的语义指纹：本机副本和这里完全一致说明用户没改过，可以升级成新定义。
 * 升级后名字变了，就不再匹配，重复启动不会重复改。
 */
export const LEGACY_AGENT_FIELDS: Record<string, { name: string; description: string; instructions: string }> = {
  tester: {
    name: '测试运行',
    description: '按给定范围跑测试、构建或检查，失败时交回精简日志和初步定位',
    instructions: `你负责跑验证，不修改代码。

1. 按要求的范围跑：先找项目自己的命令（package.json 的 scripts、Makefile、README、CI 配置），不要自己编命令。
2. 跑之前确认不会写入工作区或改远端；会改文件的命令（格式化写回、快照更新）不跑，除非要求里明确写了。
3. 失败时只摘关键日志：失败的用例名、断言或报错原文、相关文件和行号；看一眼相关代码给出初步原因，但不动手修。

结果写：跑了哪些命令、各自通过还是失败、耗时；失败的逐条列出。最后一行写「验证结论：通过」或「验证结论：不通过」。`,
  },
  // 下面三个这次加了参数（ADR / Bug 触发条件、推送授权、性能排查），没改过的副本跟着升级
  docsync: {
    name: '文档同步',
    description: '把一次改动同步进项目文档：入口、模块 README、bugs.md、ADR、术语表',
    instructions: `你负责把这次改动同步进项目文档，只写有证据的事实。

1. 先确定 PROJECT_ROOT 和 DOC_ROOT，读已有的入口和模块地图。
2. 按 project-documentation 的「按变化选择文档」决定要更新哪些：模块 README（同步状态）、MODULE-MAP、架构文档、ADR、CONTEXT.md；只改和这次改动相关的段落。
3. 没有要更新的就在结果里写明原因，不要为了凑数改文档。

输出：改了哪些文档、各改了什么、还有什么没确认。`,
  },
  vcs: {
    name: '交付员',
    description: '同步文档后做版本控制收尾：Git 按功能拆本地提交，P4 核对 default 并按类型分 pending',
    instructions: `你负责任务的收尾：{{#if docs}}先同步文档，再{{/if}}做版本控制收尾。

${VCS_TEXT}
{{#if docs}}
同步文档（只写有证据的事实）：按 project-documentation 的「按变化选择文档」决定要更新哪些：模块 README（同步状态）、MODULE-MAP、架构文档、ADR、CONTEXT.md；只改和这次改动相关的段落，不重写整篇。没有要更新的就写明原因。
{{/if}}{{#if bug}}
写 Bug 记录：在模块 bugs.md 加一条索引，并写 bugs/<id>.md：症状、复现、根因、修复、回归测试、防复发措施。
{{/if}}
版本控制收尾（文档改动和代码一起）：

{{#if commit=只检查}}只检查不提交：列出本次任务的改动（限定范围的 diff / opened），指出范围外的改动、临时文件、遗漏的文件。{{else}}
- Git：只提交本次任务的文件，按功能拆成本地提交，提交前跑一遍验证；提交说明写清改了什么。不 push。
- P4：核对 default changelist 里只有本次任务的文件，按 [C++]、[XLSX]、[Lua]、[Other] 分到各自的 pending，描述写「[类型] 中文短句」，用 UTF-8 临时文件写入后 p4 describe 回读确认没有乱码。不 submit。
{{/if}}
不认领、不提交用户原有的改动。输出：{{#if docs}}改了哪些文档，{{/if}}提交 / pending 清单和验证结果。`,
  },
  debugger: {
    name: '调试员',
    description: '先查历史 Bug，再按四阶段找到根因，先写失败测试再修',
    instructions: `你负责定位并修复 Bug。没找到根因不修。

${VCS_TEXT}
${SCENE_TEXT}

1. 先查相关模块的 bugs.md 和历史 Bug 记录，看是不是复发。
2. 按 systematic-debugging 四个阶段：根因调查 → 模式分析 → 假设验证 → 实现修复。
3. 修复前先写能复现问题的失败测试（或可重复执行的复现步骤），修复后它必须通过。
4. 只做单点修复，不顺手重构。连续三次修复失败就停下来质疑设计，写明理由。
{{#if lang=cpp|多种}}C++ 改动遵守 cpp-code-style。{{/if}}{{#if lang=lua|多种}}Lua 改动遵守 lua-code-style。{{/if}}

输出：症状、复现方式、根因（带证据）、修复内容、回归测试和验证结果。`,
  },
}

const GENERAL_PREV: LegacyWorkflow = {
  document: `## 适用
项目里的日常开发：需求、方案、实现、测试、文档、交付。工作流可以按顺序跑很多次，每次都是完整的一遍。

## 约定
- 版本控制和文档根由「常驻编排器」统一确定，后面的节点按它的结论操作。
- 方案确认之前不写代码；确认之后中途不再逐步确认，遇到不可逆操作、需求矛盾、和方案冲突时才停下。
- 测试按项目的流程跑，没有本轮的新鲜证据不算完成。
- 版本管理：本地提交 / pending 保持一致；推送、PR、submit 这类对外操作要得到授权。
- 只改任务范围内的文件，不覆盖、不认领用户已有的改动。`,
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
      edges: [
        ['start', 'discover'],
        ['discover', 'design'],
        ['design', 'docs'],
        ['docs', 'end'],
      ],
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
      edges: [
        ['start', 'verify'],
        ['verify', 'end'],
      ],
    },
    {
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
      edges: [
        ['start', 'verify'],
        ['verify', 'end'],
      ],
    },
  ],
}

const UE_PREV: LegacyWorkflow = {
  document: `## 适用
Unreal Engine 项目的 C++ / Lua / 资源改动。工作流可以按顺序跑很多次。

## 约定
- 模块、Build.cs / Target.cs、UHT/UBT、资产和 Cook 的规则按 ue-project-structure 技能。
- 编译只由「UE 集成员」做，同一时间只编译一次（-WaitMutex）；需要 Editor、PIE 或设备的验证登记为延期验证。
- 文档、测试、版本管理沿用在「通用项目」里的规则。
- Git 只提交本次任务的文件、按功能拆本地提交；P4 只分 pending，不 sync、不 submit。推送 / submit 要授权。`,
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
      edges: [
        ['start', 'scout'],
        ['scout', 'design'],
        ['design', 'impl'],
        ['impl', 'docs'],
        ['docs', 'deliver'],
        ['deliver', 'end'],
      ],
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
      edges: [
        ['start', 'build'],
        ['build', 'verify'],
        ['verify', 'end'],
      ],
    },
  ],
}

/** 每个内置工作流的旧定义，最新的一版在最后（升级时从后往前匹配） */
export const LEGACY_WORKFLOWS: Record<string, LegacyWorkflow[]> = {
  // 更早的 5 节点主流程（分步之前的版本）：GENERAL_LEGACY 的说明和流程就是它
  'project-general': [{ document: GENERAL_LEGACY.document, flows: GENERAL_LEGACY.flows }, GENERAL_PREV],
  'project-ue': [UE_PREV],
}

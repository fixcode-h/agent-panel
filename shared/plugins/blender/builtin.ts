import { base, p, VERDICT_TOOL_TEXT, type BuiltinAgent } from '../../builtin/agents.ts'
import { chain, type BuiltinWorkflow } from '../../builtin/workflows.ts'
import { END, START } from '../../flow.ts'

/**
 * Blender 插件带的内置角色和工作流（原来在核心的 shared/builtin/agents.ts、workflows.ts，ADR 0059 迁进插件）。
 * key 沿用原来的 blender：老用户本机的副本按来源 builtin:blender 认，打开插件后照常升级，关着时按规则清掉。
 * 角色设定和节点说明是交给 CLI 的提示词，不翻译。
 */

export const BLENDER_AGENTS: BuiltinAgent[] = [
  base('blender', '美术', {
    name: 'Blender 建模',
    description:
      'Blender 建模：GUI 会话里实时建模和看视口、228 个建模算子、无头作业；分件、装配、动画、减面和导出 UE；「质检」阶段只做体检和对照，不改模型',
    icon: 'wand',
    model: '@high',
    skills: ['blender-modeling', 'blender-model-animation-workflow', 'blender'],
    params: [
      p({
        key: 'stage',
        label: '阶段',
        options: ['解析与规格', '分件建模', '装配到减面', '装配与材质', '动画', '减面', '质检', '导出 UE'],
        default: '分件建模',
      }),
    ],
    instructions: `你按 blender-model-animation-workflow 的阶段工作：建模流程、参考图量测、装配和验收按 blender-modeling，无头脚本、体检和 UE 导出按 blender 技能，以参考图的实际内容为准。

## Blender 工具
面板挂了 Blender 工具（blender_session / blender_op / blender_py / blender_see / blender_run / blender_inspect）时：
- 先 blender_session(action="doctor")，kind=ok 才算就绪；没有 GUI 会话时说明情况，请用户打开 Blender 并在「DSH Blender Bridge」面板点连接，不要绕过。
- GUI 优先：改场景用 blender_py，看结果用 blender_see；超过约 1 秒的重活、批量渲染用 blender_run（kind=headless / render）。
- 写操作前用 blender_session 的 txn 打快照，改坏了回滚；pause、resume 只有用户能做。
- 没有挂 Blender 工具时，用 blender 技能目录下的无头脚本完成同样的步骤。

当前阶段：{{stage}}。
{{#if stage=解析与规格}}用 reference_frames.py 解析参考，确定交付用途、尺寸锚点（米）、可见和需要补全的部分，写出部件清单、GRP_* 根 Empty、局部原点和轴、命名规则。{{/if}}
{{#if stage=分件建模}}每个部件走「单件脚本 → 单件预览 / 体检 → 精修」，和参考裁切并排对照。{{/if}}
{{#if stage=装配与材质|装配到减面}}按模块契约装配，处理材质和 UV，确认每个 GRP_* 能整体平移和恢复。{{/if}}
{{#if stage=动画|装配到减面}}用控制器驱动动画，Action 命名 A_*，30fps。{{/if}}
{{#if stage=减面|装配到减面}}保留基线，在相同条件下对照，质量退化就恢复。{{/if}}
{{#if stage=质检}}
这一阶段只做质检，不修改模型：
1. 运行 inspect_scene.py 体检，FAIL 项必须列出。
2. 相交诊断并分类（预期的贴合 / 需要修的穿插）。
3. capture_views 出至少 6 个视角，并和参考图并排对照；有动画时加 --frames 多帧检查。
4. 重新打开 .blend，平移再恢复每个 GRP_*，证明可以拆分。
逐条给出结果和截图路径。有 FAIL 或明显偏离参考时按不通过交，否则按通过交。${VERDICT_TOOL_TEXT}
{{/if}}
{{#if stage=导出 UE}}用 export_ue.py 导出 FBX：模型到 Asset/Mesh/，动画到 Asset/Anim/，并更新 <型号>/制作进度.md。{{/if}}

每步都要有截图或体检结果作为证据，不能只凭单个视角下结论。`,
  }),
]

export const BLENDER_WORKFLOWS: BuiltinWorkflow[] = [
  {
    key: 'blender',
    name: 'Blender 建模与动画',
    description: '规格确认 → 分件建模 → 装配、动画与减面 → 质检确认 → 导出 UE',
    category: '美术',
    when: '用 Blender 建模、做动画、导出 UE',
    kind: 'change',
    main: 'blender',
    members: [['blender', '建模、装配、动画、减面、质检（体检、多视角对照、可拆分测试）和导出']],
    document: `## 适用
用 Blender 做可拆分的模型和动画，并导出到 UE：有 GUI 会话时用 Blender 工具实时建模，没有时用无头脚本。

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
            agent: 'blender',
            tier: 'medium',
            params: { stage: '质检' },
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
            agent: 'blender',
            tier: 'medium',
            params: { stage: '质检' },
            instructions: '检查上面「输入」里完成的部件：单件体检、和参考裁切并排对照。',
          },
        ],
        edges: chain(START, 'qa', END),
      },
    ],
  },
]

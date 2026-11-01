import type { BuiltinAgent } from './agents.ts'

/**
 * Chat 类内置角色（ADR 0038）：只在 Chat 页（没有项目的顶层对话）用。
 * 「聊天约束」是通用约束的精简版：去掉子对话、父对话、收尾、推送、工作流、共用工作区和项目搜索范围这些
 * Chat 里不存在的规则（整份引入每个会话多几千字，模型还会去找 message_parent 这类不存在的工具）。
 * 「助手」是必备角色：Chat 页没选角色的对话（含旧对话）都按它跑，见 shared/conv-mode.ts 的 chatRoleFor。
 * 计划用 CLI 自带的待办 / 计划（TodoWrite、Codex 的 plan 这类），面板计划只在 Agent 模式。
 * 放在单独的文件里：agents.ts 到了行数上限。角色设定是交给 CLI 的提示词内容，不翻译
 */
const chat = (
  key: string,
  category: string,
  includes: string[],
  agent: Pick<BuiltinAgent['agent'], 'name' | 'description' | 'icon' | 'instructions'> & Partial<BuiltinAgent['agent']>,
): BuiltinAgent => ({
  key,
  category,
  includes,
  mounts: [],
  agent: {
    cli: '',
    model: '',
    effort: '',
    params: [],
    skills: [],
    starters: [],
    permission: '',
    extraArgs: [],
    enabled: true,
    // Chat 角色不当通用角色、不分派、不跑工作流、不挂能力（保存时服务端也会归零，见 normalizeScope）
    common: false,
    canDelegate: false,
    canPlan: false,
    runIn: 'any',
    kind: 'advanced',
    scope: 'chat',
    when: '',
    modes: ['inline', 'subtask'],
    independent: false,
    inlineEdit: 'off',
    capsSet: true,
    ...agent,
  },
})

export const CHAT_RULES_KEY = 'chat-rules'
export const CHAT_KEY = 'chat'

export const CHAT_AGENTS: BuiltinAgent[] = [
  chat(CHAT_RULES_KEY, '基础', [], {
    name: '聊天约束',
    description:
      'Chat 角色引入的常驻规则：语言、提问、命令执行、回合推进、等待和安全边界（不含子对话、收尾、推送、工作流）',
    icon: 'shield',
    model: '@medium',
    instructions: `## 语言
回复正文和你自己的思考过程用提示词里「回复语言 / Reply language」一节指定的语言；代码、标识符、命令、日志和报错原文保持原样，不翻译。

## 提问
需要用户决定时，用当前 CLI 的提问方式：推荐的选项放第一位并在末尾标「（推荐）」；每题 2–4 个选项，每个选项一句话说明后果；一次只问一个影响决策的问题。
事实自己查，不拿去问用户。

## 命令执行
- 新增或修改的文本文件用 UTF-8 无 BOM。
- 不弹出新的命令行窗口（不用 start / Start-Process / wt）。
- 命令失败先看真实报错和退出码，不要靠重试或加 \`-Force\`、\`--no-verify\` 绕过。
- 在 Windows 上不要套用 Linux 的命令习惯（PowerShell 里没有 \`tail\` / \`head\`）；\`find\` / \`grep\` 限定目录和深度，带上 \`.git\`、\`node_modules\`、\`dist\` 这类排除，不要扫整个磁盘或家目录。

## 回合怎么推进
- 说了要做什么就在同一回合做完：不要只回一句「我先看一下」就结束回合，紧接着调用工具去做，或者直接给出结论。
- 连续做两次以上工具操作前先用一句话说明目标，做完一组先报告阶段结果再接着做；不要让一整轮只剩工具调用。
- 只在做完了、需要用户拿主意、或者确实卡住时结束回合，并说清楚是哪一种。
- 工具或命令报错时先交已有结果：报错原文、出错的位置、已经做完的部分，再说哪一步没做成；不要静默停下。

## 怎么等
- 长命令用 run_background 放到后台，结果会自动推回：等的时候做不依赖它的事，或者直接结束这一轮；不要反复调用 check_background，也不要用 sleep 干等。
- 同一个错误出现两次就回到根因，三次就停下来说明卡在哪、有哪几种处理办法。

## 安全边界
- 删除、覆盖用户文件，改系统设置，装卸软件，推送、发布、改远端这类不可逆或对外的操作，先说清楚要做什么、影响什么，等用户明确同意再做。
- 用户明确授权的操作照授权的做，不要自行换成更保守的做法；确实做不了时写清原因。`,
  }),
  // '必备' 就是 agents.ts 的 CORE_CATEGORY：这里不 import 它，agents.ts 加载时要展开 CHAT_AGENTS，互相引用会读到未初始化的值
  chat(CHAT_KEY, '必备', [CHAT_RULES_KEY], {
    name: '助手',
    description:
      'Chat 页的对话默认使用：直接回答问题，多步的事先列计划再做，长命令放后台；不开子对话、不派子任务、不跑工作流',
    icon: 'sparkles',
    params: [
      {
        key: 'style',
        label: '回复详略',
        type: 'select',
        options: ['简洁', '详细'],
        default: '简洁',
        ask: false,
        description: '简洁：先给结论，必要时补依据；详细：把推理、依据和可选做法都写清楚',
      },
      {
        key: 'plan',
        label: '多步的事先列计划',
        type: 'bool',
        options: [],
        default: true,
        ask: false,
        description: '要好几步才能做完的事，先用 CLI 自带的待办 / 计划列出来再做',
      },
    ],
    instructions: `你是用户在 Agent 面板 Chat 页直接对话的助手：像一个能动手的聊天助手那样，帮用户回答问题、查资料、读写文件、跑命令。这里不属于任何项目，你的工作目录是这个对话自己的空目录；用户给了别的路径就去那里看。

## 怎么回答
- 先直接回答，再补必要的依据；问答和闲聊不写长篇大论，不套模板。{{#if style=详细}}用户要的是详细说明：把推理、依据和可选做法都写清楚。{{/if}}
- 不确定的事先查（读文件、跑只读命令、看报错原文），查不到就说不知道，并给出怎么确认；不编造。
- 要改文件、跑会写盘的命令时，改之前说一句要改什么；改完说清改了什么、怎么验证的。

{{#if plan}}## 多步的事先列计划
- 要好几步才能做完的事（排查一个问题、改几处文件、搭一个小工具），先用你自己（CLI 自带）的待办 / 计划工具列出计划再动手（例如 TodoWrite、update_plan）；一问一答、一两步就完的不用列。面板会把它显示在对话上方。
- 按计划一步一步做：开始一步先标进行中，做完立刻标完成、接着做下一步。
- 用户中途改了要求，先判断计划要不要改：要改就先改计划再做。
{{/if}}
## 你能做和不能做的
- 能做：回答、读写文件、跑命令；长命令用 run_background 放后台跑。
- 不能做：开子对话、派子任务、按工作流执行。要拆给多个 Agent 并行、或者要按项目的流程（评审、测试验收、版本控制）做的事，告诉用户到项目里开对话去做，并把已经查到的情况整理成一段可以直接贴过去的说明。`,
  }),
]

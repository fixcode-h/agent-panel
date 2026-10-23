import { t } from './i18n.ts'

/**
 * 面板的命令：内置命令和「所有 Agent」共用的命令，不管选哪个 CLI 都能在「/」菜单里用。
 * 发出去之前由面板展开成普通要求（CLI 自己有同名命令的除外，见 CLI 定义的 nativeCommands），
 * 所以对每个 Agent 都一样生效。
 */

/** 「所有 Agent」共用的命令在技能库里的 CLI id（不会和真的 CLI 重名） */
export const ALL_AGENTS = '@all'

export interface BuiltinCommand {
  name: string
  description: string
  /** 参数提示 */
  hint?: string
  /** 面板直接执行（压缩、审查），不展开成要求 */
  action?: 'compact' | 'review'
  /** 展开后的要求；$ARGUMENTS 换成命令后面的参数 */
  prompt?: string
}

const ONE_TURN = '在这一轮里做完，不要只给计划就结束。'

/** 展开后的要求是发给 Agent 的提示词，不翻译；说明是界面文案 */
export const builtinCommands = (): BuiltinCommand[] => [
  {
    name: 'compact',
    description: t('压缩上下文：把之前的对话压成摘要，腾出上下文'),
    action: 'compact',
  },
  {
    name: 'review',
    description: t('审查还没提交的改动；后面跟分支名就审查相对这个分支的改动'),
    hint: t('[分支]'),
    action: 'review',
  },
  {
    name: 'init',
    description: t('分析项目，写一份给 Agent 看的项目说明（CLAUDE.md / AGENTS.md）'),
    prompt:
      '请分析这个项目，在项目根目录写一份 AGENTS.md（已经有了就改进它），写给以后在这个项目里工作的编码 Agent 看：' +
      '项目是做什么的、目录结构、常用的构建 / 测试 / 检查命令、代码风格和约定、容易出错需要注意的地方。内容简洁准确，不要编造项目里没有的东西。',
  },
  {
    name: 'commit',
    description: t('看一遍改动，按项目的提交约定写提交说明并提交（不推送）'),
    hint: t('[补充说明]'),
    prompt:
      '请提交当前的改动：先看 git status 和 git diff，确认没有混进临时文件、调试输出或密钥；' +
      '再看最近几条 git log 和项目说明（AGENTS.md / CLAUDE.md / CONTRIBUTING）里的提交约定，照着写提交说明，标题概括这次改动，正文按条列出改了什么。' +
      '改动里有互不相关的几件事时分成几个提交。只提交，不要推送。' +
      ONE_TURN,
  },
  {
    name: 'test',
    description: t('给改动补测试并跑通；后面可以写要测的范围'),
    hint: t('[范围]'),
    prompt:
      '请给$ARGUMENTS补上测试：先找到项目现有的测试框架、目录和写法，照着写；覆盖正常情况、边界和出错的情况。' +
      '写完运行相关的测试直到通过；测试失败时先判断是测试写错还是代码有 Bug，是 Bug 就说明原因并修掉。最后汇报加了哪些用例、运行结果。' +
      ONE_TURN,
  },
  {
    name: 'fix',
    description: t('定位并修复一个报错或问题'),
    hint: t('<报错或现象>'),
    prompt:
      '请修复下面这个问题：先复现或找到出错的位置，查清根本原因再改，不要只把报错压下去；' +
      '改完运行相关的测试或命令确认已经好了，能补回归测试的就补上。最后说明原因、改了哪里、怎么验证的。' +
      ONE_TURN +
      '\n\n## 问题\n$ARGUMENTS',
  },
  {
    name: 'plan',
    description: t('只出方案不改代码：读相关代码，给出实现步骤、要改的文件和风险'),
    hint: t('<需求>'),
    prompt:
      '请为下面的需求出一份实现方案，这一轮只读代码、不修改任何文件：' +
      '先读相关的代码和文档，说明现在是怎么实现的；再给出要改哪些文件、每一步怎么改、要补哪些测试；最后列出风险、拿不准要用户决定的地方。' +
      '\n\n## 需求\n$ARGUMENTS',
  },
  {
    name: 'explain',
    description: t('讲解一段代码、一个模块或一个流程是怎么工作的'),
    hint: t('<文件、函数或问题>'),
    prompt:
      '请讲解下面的内容是怎么工作的：先读相关代码，再按「它是做什么的 → 主要流程 → 关键的数据结构和调用关系 → 容易出错的地方」讲清楚，' +
      '引用代码时写上文件和行号。只讲解，不要修改文件。\n\n## 要讲解的\n$ARGUMENTS',
  },
  {
    name: 'simplify',
    description: t('清理最近改动里重复、多余的代码，不改变行为'),
    hint: t('[范围]'),
    prompt:
      '请清理$ARGUMENTS里的代码：去掉重复和用不到的代码、能复用项目里已有函数的就复用、过深的嵌套和过长的函数拆简单，命名和写法和周围的代码保持一致。' +
      '不改变行为，不顺手加新功能。改完运行类型检查、代码检查和相关测试确认没有改坏，最后列出改了哪些地方。' +
      ONE_TURN,
  },
  {
    name: 'docs',
    description: t('按最近的改动更新 README、AGENTS.md 等文档'),
    hint: t('[范围]'),
    prompt:
      '请按$ARGUMENTS更新项目文档：先看改了什么（git diff、最近的提交），再找出受影响的文档（README、AGENTS.md / CLAUDE.md、docs/ 下的说明、注释里的用法），' +
      '把过时的说法改对、缺的补上。只写项目里真实存在的东西，不要编造命令和接口。' +
      ONE_TURN,
  },
  {
    name: 'security-review',
    description: t('检查当前分支改动里的安全问题'),
    prompt:
      '请对当前分支相对主分支的改动（还有没提交的改动）做一次安全审查，只读不改：' +
      '重点看注入（命令、SQL、路径）、越权和缺少鉴权、密钥和敏感信息泄露、不安全的反序列化和文件操作、依赖里已知有漏洞的版本。' +
      '每个问题写明位置、怎么被利用、严重程度和修复建议；没有发现问题也要说明看了哪些地方。',
  },
]

/** 参数为空时 $ARGUMENTS 换成的默认说法：命令写成「给$ARGUMENTS补上测试」这样的句子 */
const DEFAULT_SCOPE: Record<string, string> = {
  test: '最近的改动（没提交的改动，没有就是最近一次提交）',
  simplify: '最近的改动（没提交的改动，没有就是最近一次提交）',
  docs: '最近的改动（没提交的改动，没有就是最近一次提交）',
}

/** 把内置命令展开成发给 Agent 的要求；不是展开型的内置命令返回空 */
export function builtinPrompt(name: string, args: string) {
  const c = builtinCommands().find((x) => x.name === name)
  if (!c?.prompt) return ''
  const value = args || DEFAULT_SCOPE[name] || ''
  if (c.prompt.includes('$ARGUMENTS')) {
    // 没写参数的「## 问题」这类小节整个去掉，不留空标题
    const body = value ? c.prompt.replaceAll('$ARGUMENTS', value) : c.prompt.replace(/\n\n## [^\n]+\n\$ARGUMENTS/, '')
    return body.replaceAll('$ARGUMENTS', '').trim()
  }
  return args ? `${c.prompt}\n\n补充要求：${args}` : c.prompt
}

/**
 * 命令文件（md）的正文按参数展开：Gemini CLI 的命令用 {{args}}；Claude Code 的用 $ARGUMENTS 和 $1、$2…（按空格分开的参数）。
 * 正文里没有占位符时，参数接在末尾
 */
export function fillCommand(body: string, args: string) {
  const parts = args.split(/\s+/).filter(Boolean)
  const used = /\$ARGUMENTS|\$\d|\{\{args\}\}/.test(body)
  const out = body
    .replaceAll('{{args}}', args)
    .replaceAll('$ARGUMENTS', args)
    .replace(/\$(\d)/g, (_, i: string) => parts[Number(i) - 1] ?? '')
  return used || !args ? out.trim() : `${out.trim()}\n\n${args}`
}

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
    description: t('快速修一个报错或问题：自己查、自己修，不用确认报告'),
    hint: t('<报错或现象>'),
    // 简易版（ADR 0046）：不交诊断报告；要按完整流程查清原因、先确认方案的用 /bug
    prompt:
      '请按简易版修复下面这个问题（自己查、自己修，不用交诊断报告）：先复现或找到出错的位置，写出调用栈（calltree 代码块：一行一跳「函数  path:line  — 做了什么」，缩进表示调用关系，出错点行首写 !）；' +
      '证据链齐了（现象 ← 报错或测试输出 ← 代码 path:line 的条件或赋值）再改，推不通就先写失败用例或加临时日志确认，不猜着改；' +
      '修根因，不要只把报错压下去（try/catch 掉、加判空绕过、加重试、外面再兜底一层都不算修）；同一模块里同样的写法搜一遍。' +
      '能写测试的先写会失败的用例，改前失败、改后通过，再跑相关的测试。最后说明原因、改了哪里、怎么验证的。' +
      ONE_TURN +
      '\n\n## 问题\n$ARGUMENTS',
  },
  {
    name: 'bug',
    description: t('按完整流程查一个 Bug：时间线、调用栈、引入的改动、比较几种修法，先交报告给你确认再改'),
    hint: t('<现象>'),
    // 对话里由面板按在哪发展开（server/exec/bug-prompt.ts）：父对话派 kind: "bug" 子对话，子对话就地交诊断报告。
    // 这里是别处（例如 UI 设计的对话）用到时的兜底
    prompt:
      '用户用 /bug 要求按完整的 Bug 查找流程处理下面这个问题：钉住现象并复现，定位到模块和调用栈，排出现象和变更两条时间线，' +
      '用证据链确定根因、查清是哪次改动引入的，比较两三种修法选最优；查到这里先把诊断报告写在回复里、结束这一轮，等用户同意再改。' +
      '\n\n## 用户报的 Bug\n$ARGUMENTS',
  },
  {
    name: 'learn',
    description: t('把一件事学成一条项目经验：在哪找、叫什么、用什么命令，下次直接用'),
    hint: t('<要学的，例如：表格相关的代码在哪>'),
    // 记经验靠 record_experience（server/orch-mcp.ts）；经验记什么、不记什么写在工具说明里（shared/experience.ts 的 EXPERIENCE_SCOPE）
    prompt:
      '用户用 /learn 要你把下面这件事学成一条项目经验（没写要学什么时，总结这次对话里找到的捷径）：' +
      '先用 project_experience 看有没有同类的经验；没有或不全，就在项目里只读地查清楚（看目录结构、搜关键词、读入口文件，不改任何文件）。' +
      '查清后用 record_experience 记一条，同一件事已经有了就带它的 id 更新：标题一句话，关键词同时写用户的说法和代码里的叫法，' +
      '位置写到目录或入口文件为止，说明一两句；不记行号、函数内部细节和一次性的事。没有 record_experience 工具时告诉用户经验功能在设置里关了。' +
      '最后用一两句告诉用户记了什么。' +
      ONE_TURN +
      '\n\n## 要学的\n$ARGUMENTS',
  },
  {
    name: 'createtool',
    description: t('把常用命令或脚本做成工具：读文档和代码总结出来，以后所有 Agent 都能直接调'),
    hint: t('<要做成工具的事，例如：导表>'),
    // 自建工具（ADR 0082）：试跑、保存靠面板工具 custom_tool（server/panel-tools/custom-tool.ts），保存时用户在弹窗里选项目还是全局
    prompt:
      '用户用 /createtool 要你把下面这件事做成一个可以反复调用的自建工具（没写要做什么时，把这次对话里跑过、以后还会用的命令做成工具）：' +
      '1. 先用 custom_tool action=list 看有没有同类的工具；再看你手上的插件工具（UE 编译、Lua 热重载这类）能不能做，能做就告诉用户直接用它，不再建。' +
      '2. 用 find 和读文件查清楚：入口脚本或命令、真正需要的参数、在哪个目录跑、成功和失败分别输出什么、会改哪些文件。只读，不改项目文件。' +
      '3. 写草稿：id 用小写英文和 -；中文名简短；summary 一句话；useWhen 写成具体场景（「改了 Design/Excel 下的表之后」），avoidWhen 写容易用错的情况；' +
      '参数写中文 label 和说明，能用 enum 的用 enum，路径用 path；命令里用 {{参数名}}，不要自己加引号；effect 和 writes 如实写，拿不准的往严了写；' +
      '能从输出认出报错行的写 output.errorPattern（命名分组 file、line、msg）；sources 写依据的文件。' +
      '4. 用 custom_tool action=test dryRun=true 看展开后的命令对不对；effect 是 read 的真跑一次（action=test 不带 dryRun），会改文件或影响外部的先问用户要不要真跑。' +
      '5. 用 custom_tool action=save 交给用户，用户在弹窗里选存到项目还是全局；用户要你再改就改了再 save。最后用一两句告诉用户做了什么工具、什么时候用。' +
      ONE_TURN +
      '\n\n## 要做成工具的\n$ARGUMENTS',
  },
  {
    name: 'build',
    description: t('编译并把报错修到通过：优先用项目的编译工具'),
    hint: t('[目标]'),
    prompt:
      '请把$ARGUMENTS编译通过：先找编译方式——自建工具（custom_tool action=list）、插件的编译工具、项目说明（AGENTS.md / README）里的命令，按这个顺序用现成的，不要自己猜命令；' +
      '编译失败就读报错，定位到代码改根因（不注释掉、不跳过、不放宽检查），改完再编，直到通过。编译久的交给后台命令。最后说明改了什么、编译结果。' +
      ONE_TURN,
  },
  {
    name: 'run',
    description: t('把项目跑起来看效果：起服务、编辑器或游戏，看日志确认改动生效'),
    hint: t('[要看的]'),
    prompt:
      '请把项目跑起来确认$ARGUMENTS真的生效：先找启动方式（自建工具、插件工具、项目说明里的命令），开发服务器、监听这类不会自己结束的用后台命令（service）起；' +
      'UE 项目用插件工具开编辑器或 PIE。跑起来后看日志、打开页面或截图核对改动的效果，有报错就查清原因。只确认、不顺手改别的；需要用户在本机操作的用 request_user_action。最后说明怎么跑的、看到了什么。' +
      ONE_TURN,
  },
  {
    name: 'merge',
    description: t('合并分支并按项目约定解冲突，合完跑检查'),
    hint: t('<分支>'),
    prompt:
      '请把 $ARGUMENTS 合并进当前分支：先看项目说明和经验里的合并约定（默认不用 rebase、不强推）；有冲突时逐个解：' +
      '代码冲突看两边的改动意图合在一起，资源文件（图片、uasset 这类二进制）冲突用对方的版本，拿不准的列出来问用户。合完跑类型检查、编译和相关测试，确认没有合坏。只合并、不推送。最后列出冲突文件和各自怎么解的。' +
      ONE_TURN,
  },
  {
    name: 'pr',
    description: t('推送并建合并请求：按项目设置决定推不推、合不合'),
    hint: t('[补充说明]'),
    prompt:
      '请按项目的推送设置收尾当前分支：先确认改动都已提交、检查都跑过；推送前先合并远端的同名分支（不用 rebase）；' +
      '项目说明里有合并请求的约定（目标分支、模板、标题写法）就照着建，没有就用 gh 建到默认分支，正文按条写改了什么。项目设置不允许推送时只告诉用户怎么推，不要自己推。' +
      '检查失败、有冲突、分支保护拦下时停下来说明，不绕过。' +
      ONE_TURN,
  },
  {
    name: 'refactor',
    description: t('按描述重构：先补测试兜底，改完行为不变'),
    hint: t('<要改的>'),
    prompt:
      '请按下面的要求重构，行为保持不变：先读相关代码和调用方，确认有测试覆盖要改的行为，没有就先补上；再分小步改，每步跑一次测试；' +
      '改名、挪文件时把所有引用一起改掉。不顺手加功能、不改对外接口（要改的先说明）。最后列出改了哪些地方、测试结果。' +
      ONE_TURN +
      '\n\n## 要重构的\n$ARGUMENTS',
  },
  {
    name: 'perf',
    description: t('性能排查：先测量找到热点，再改，再测对比'),
    hint: t('<现象>'),
    prompt:
      '请排查下面的性能问题：先复现并测量（耗时、帧率、内存，用项目现有的工具或加临时计时），找出最耗时的地方，用数据说明它是瓶颈；' +
      '再改，改完用同样的方法再测一次，给出前后对比。不凭感觉优化，没测出问题的地方不动；临时加的计时代码改完删掉。' +
      ONE_TURN +
      '\n\n## 现象\n$ARGUMENTS',
  },
  {
    name: 'deps',
    description: t('升级依赖并修好编译和测试'),
    hint: t('[要升的包]'),
    prompt:
      '请升级$ARGUMENTS：先看现在的版本和要升到的版本，读一遍更新说明里的不兼容改动；升级后跑编译、类型检查和测试，按不兼容改动改代码直到通过。' +
      '一次只升一组相关的包，锁文件一起更新。最后列出升了什么、改了哪些代码。' +
      ONE_TURN,
  },
  {
    name: 'changelog',
    description: t('按提交整理更新说明'),
    hint: t('[范围]'),
    prompt:
      '请整理$ARGUMENTS的更新说明：先看项目里 CHANGELOG 或发版说明的格式和约定，再看这段时间的提交和改动，按「新功能 / 改进 / 修复」分类写给用户看，' +
      '讲用户能感受到的变化，不写内部实现；用户感受不到的改动不写。写进项目约定的位置，不提交。' +
      ONE_TURN,
  },
  {
    name: 'doctor',
    description: t('检查本机环境：CLI、MCP、IDE 和编辑器连接、文档根、版本管理登录'),
    prompt:
      '请检查这个项目在本机的开发环境，只读不改：各个命令行工具的版本（项目用到的编译器、运行时、包管理器）、面板的 find 能不能找到代码（试一次 symbol 查找）、' +
      '项目配置的 MCP 服务连不连得上、版本管理是否登录（git 远端、p4 info）、项目说明里要求的工具有没有装。' +
      '最后列一张表：检查项、结果、不对的怎么修。',
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
  build: '这个项目',
  run: '最近的改动',
  deps: '有新版本的依赖（先列出来让用户挑，再升）',
  changelog: '上一次发版以来',
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
 * 命令文件（md）的正文按参数展开：{{args}} 是整套参数；$ARGUMENTS 和 $1、$2… 是 Claude Code 的写法（按空格分开的参数）。
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

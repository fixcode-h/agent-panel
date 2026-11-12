/**
 * 引擎交给 Agent 的提示词里各节点、子任务、对话共用的段落：用户需求、授权、收尾、计划维护、搜索排除、文件格式等。
 * 从 engine.ts 拆出来（文件行数上限，见 docs/lessons/file-caps.md）；每段写什么、为什么这么写的注释都跟着段落走
 */
import type { Task, Workflow } from './schema.ts'
import { clip } from './text.ts'
import { withAttachments } from './task.ts'
import { statePart } from './run-state.ts'
import { pushPolicyText } from './push-auth.ts'
import { docRootText, plainDocRootText, p4DocsSkip } from './doc-root.ts'
import { promptLangRules, promptLangWord } from './prompt-lang.ts'
import { summaryCardRules } from './summary-card.ts'
import { sharedWrapPart, uePart } from './wrapup-prompt.ts'
import { searchExcludeFindPrune, searchExcludeGlobs, searchExcludePrompt } from './search-exclude.ts'
import { TEST_TIME_SUMMARY_RULE, parentRunSteps, verifyParts } from './test-steps.ts'
import { subPolicy } from './sub-policy.ts'
import type { EngineHost } from './engine-host.ts'
import { activePlan, planNotice, planNowText, planText, WRAP_UP, type WrapUpAnswer } from './plan.ts'
import type { WrapUpKind } from './wrap-up.ts'

/** 提示词里的流程入口名：提示词正文是给 Agent 的中文指令（只有回复语言跟随设置，见 prompt-lang.ts） */
export const SLOT_PROMPT: Record<string, string> = {
  start: '开始',
  review: '验收',
  end: '结束',
  body: '执行',
  step: '步骤',
  sub: '子 Agent',
  call: '委派',
}

function userRequests(task: Task) {
  // 和实际交给 CLI 的一样：文字里的附件引用换成路径，没引用的列在后面
  const users = task.messages
    .filter((m) => m.role === 'user' && !m.step)
    .map((m) => withAttachments(m.prompt || m.text, m.attachments))
  return { original: users[0] ?? '', extra: users.slice(1) }
}

/** 对话里给子任务、工作流节点看的更早的用户消息：第一条（子对话里是父对话交代的任务）留得长一些，中间的只留最近几条的开头 */
const CHAT_FIRST_CHARS = 1500
const CHAT_EARLIER = 3
const CHAT_EARLIER_CHARS = 300

/**
 * 交给节点 / 子任务的「用户需求」：工作流任务就是一件事，全带上；对话会一直聊下去，全带上会越聊越长，
 * 所以只带全最新的一条，第一条截短留着（子对话的第一条是父对话交代的任务），中间的只留最近几条的开头当背景
 */
export function nodeRequests(task: Task): { original: string; extra: string[]; earlier: boolean } {
  const all = userRequests(task)
  if (task.mode !== 'chat') return { ...all, earlier: false }
  const users = [all.original, ...all.extra].filter(Boolean)
  const latest = users.at(-1) ?? ''
  const first = users.length > 1 ? [clip(users[0].trim(), CHAT_FIRST_CHARS)] : []
  const middle = users
    .slice(1, -1)
    .slice(-CHAT_EARLIER)
    .map((x) => clip(x.replace(/\s+/g, ' ').trim(), CHAT_EARLIER_CHARS))
  return { original: latest, extra: [...first, ...middle], earlier: true }
}

function requestParts(task: Task) {
  const { original, extra, earlier } = nodeRequests(task)
  return {
    head: `## 用户需求\n${original}`,
    extra: extra.length
      ? earlier
        ? `## 对话里更早的消息（节选，只作背景）\n${extra.map((t) => `- ${t}`).join('\n')}`
        : `## 用户的补充要求\n${extra.map((t) => `- ${t}`).join('\n')}`
      : '',
  }
}

export function searchPart(host: EngineHost) {
  const project = { searchExclude: host.searchExclude }
  const line = searchExcludePrompt(project)
  if (!line) return ''
  const extra = searchExcludeGlobs(project, { onlyProject: true })
  // Git 仓库里内置默认清单靠 .gitignore 就挡住了，rg 再列一遍只会误伤真叫 build / out 的源码目录；
  // 最常见的漏网是 Agent 自己加 --no-ignore / -uu，所以明说不要加
  const rg = host.searchInGit
    ? `这是 Git 仓库：rg、\`git grep\` 和 CLI 自带的搜索工具默认已经跳过 .gitignore 里的文件和隐藏目录，不要加 \`--no-ignore\`、\`-u\` / \`-uu\`、\`--hidden\` 把它们扫回来；rg 只需${extra ? `再排除 .gitignore 没覆盖的：\`rg ${extra} <关键字> <目录>\`` : `限定目录：\`rg <关键字> <目录>\``}。`
    : `这里没有 .gitignore 可依赖，rg 要带上整份排除：\`rg ${searchExcludeGlobs(project)} <关键字> <目录>\`。`
  return [
    `## 搜索排除（这个项目）\n${line}。找 Bug 在这一层定位时也用同样的排除。`,
    `- 起点先限定到模块目录（CLI 自带的搜索工具也把路径参数设成模块目录），没命中再逐级扩大。`,
    `- 搜文件内容用 rg：面板给它配好了上面的排除目录，还跳过了 .uasset、图片、模型、压缩包这类二进制文件，命中按行输出（超时被打断时已搜到的照样留下）。\`grep -r\`、\`Select-String\` 不认这份配置，不要拿它们扫大目录。`,
    `- ${rg}`,
    `- 按名字找文件（含 rg 跳过的 .uasset 这类资源）用 \`find\`，它不读 .gitignore，必须限深度并剪掉这些目录：\`find <目录> -maxdepth 4 ${searchExcludeFindPrune(project)} -type f -name '<文件名>' -print\`；不要 \`find .\` 或 \`grep -r\` 扫整个仓库。`,
    `- 确实要扫整个大项目（几十秒以上）时，有面板的 run_background 就放后台跑，别在前台等到超时。`,
    `- 要看被排除目录里的内容（例如 Saved/Logs 下的日志）时，直接把那个目录当起点去读或搜，不要因此去掉整份排除。`,
  ].join('\n')
}

/**
 * 同一轮执行里的授权情况：项目设置的推送策略、这个对话里用户已经做过的选择、本机已经登录的外部工具。
 * 只写已经具备的能力，没装的、没授权的不要列出来，免得模型去试。
 */
export function policyPart(host: EngineHost) {
  const p = host.policy
  if (!p) return ''
  const tools = p.tools.length
    ? `已经授权可用的工具：${p.tools.join('、')}（直接用，不要重新登录）。`
    : '本机没有检测到可用的外部授权工具（例如 gh），需要时请用户先自己登录。'
  // 子对话不碰远端：不论项目设置怎么定，推不推都由父对话决定，问了也只是白问（曾经弹出「要不要推送」的问题）
  if (host.task.parentTaskId)
    return `## 授权情况\n推送：推送、创建 PR、P4 submit、合并到主干由父对话决定，不在你的处理范围内：不执行、不询问用户、也不写进提问、计划步骤或建议。你这一轮的「完成」就是${wrapDone(wrapKind(host), parentRunsIn(host))}${wrapKind(host) ? '：这是收尾，面板会自动列成计划的最后一步，不要自己再写一步' : ''}，不要写「等推送 / 等合入其他分支 / 同步远端」，更不因此停下来等。\n${tools}`
  // 「需要推送」要说清是什么时候：技能和角色设定默认都是「本地先行、不主动推送」，
  // 只写一句「可以推送」时模型照样只做本地提交，三个选项的效果就没有区别了
  const wt =
    host.task.worktree?.state === 'active' ? '（在独立分支里工作时按下面「执行目录」那段：独立分支本身不推）' : ''
  // 推送这一步已经由面板列进计划（push 收尾，见 plan.ts 的 wrapUpKind），所以这里不写「你可以推」，
  // 只写「按计划最后那一步做」：另写一遍时模型会自己再补一条「推送到远端」步骤，和面板的收尾撞在一起
  const kind = wrapKind(host)
  const planned = kind
    ? `，会列计划的任务：${WRAP_UP[kind].title}已经在计划的最后一步（面板已经列好，刷新也不会变），照着它做，不要自己再写一条`
    : ''
  const push = pushPolicyText(p, wt, planned)
  return `## 授权情况\n${push}\n这条是用户在项目设置里定的，比角色设定、技能里「不推送 / 本地先行 / 创建 PR 和合并主干要用户明确授权」的默认写法优先。\n${tools}`
}

/** 这一轮的收尾种类：'none'（明确不推送）当成没有收尾，提示词里不提它 */
export function wrapKind(host: EngineHost): WrapUpKind | undefined {
  const kind = host.wrapUp === 'none' ? undefined : host.wrapUp
  // 子对话永远不碰远端：就算调用方算错、沿用旧值给了 push，也不按推送并合并主干的收尾执行
  if (kind === 'push' && host.task.parentTaskId) return undefined
  return kind
}

/** 这个对话有没有「合回后由父对话跑」的测试步骤（见 ADR 0018）：说法里要把它算进完成条件 */
export const parentRunsIn = (host: EngineHost) =>
  host.verify?.parentRun === 'child' && parentRunSteps(host.verify.steps).length > 0

/** 计划的「做完」是什么：按收尾种类说，没有收尾的（共用父对话目录的 Git 子对话）改完就在父对话的分支上 */
export function wrapDone(kind: WrapUpAnswer | undefined, parentRuns = false) {
  if (kind === 'p4')
    return '改动已按文件类型分进各自的 pending changelist，并且父对话已经验收（submit_merge 后由父对话收下）'
  if (kind === 'deliver') return '父对话已经验收你的改动（submit_merge 后由父对话收下）'
  if (kind === 'merge')
    return parentRuns
      ? '改动已合回父对话所在的分支、父对话跑范围为「全量，合并后由父对话跑」的步骤通过（submit_merge 由面板合并）'
      : '改动已合回父对话所在的分支（submit_merge 由面板合并）'
  if (kind === 'push')
    return '改动已推送到远端并合并到主干（没有可用的 gh 时只推送并说明原因），结论里写清了推到了哪个远端分支和合并结果'
  return '改动已经在父对话所在的分支上'
}

/**
 * 计划的收尾怎么做：面板把它加成计划的最后一步，这里讲清楚做什么、谁来标完成。
 * P4 的分桶规则写在这里，不靠 project-vcs 技能：对话里的子对话不一定派「版本控制」角色，
 * 没有这段时改动全留在 default 或塞进同一个 changelist
 */
export function wrapUpPart(host: EngineHost) {
  const kind = wrapKind(host)
  if (!kind) return ''
  const head = `## 收尾：计划的最后一步
面板会在你的计划最后自动加上「${WRAP_UP[kind].title}」，不用自己写这一步，也别删、别挪到前面（下一条计划里它仍在最后）；前面的步骤做完、验证通过后再做它。`
  if (kind === 'merge')
    return `${head}
做法：调用 submit_merge（tests 写上跑过的编译和测试）。合进去后面板把这一步标完成，你不要自己标；有冲突会推回给你，处理好重新验证后再调用。${
      parentRunsIn(host)
        ? `
项目里有范围为「全量，合并后由父对话跑」的步骤：它们你不用跑，合进去后由父对话在它的目录里跑，结果会回传给你。所以合进去不等于收尾：父对话的测试通过才标完成；失败时面板把报错原文推回来，按它修好再调用 submit_merge（这些步骤会全部重跑）。收尾总结里要有一份「编译 / 测试耗时」，两类执行方都写上。`
        : ''
    }`
  // 推送归 Agent 自己做（面板拿不到 git push 的结果，不像合并那样能替它标完成）：讲清做什么、做完自己标
  if (kind === 'deliver')
    return `${head}
做法：调用 submit_merge（tests 写上跑过的编译和测试，handoff 写交接要点）。你和父对话共用目录（或者项目没有版本管理），改动已经在原目录里，不用合并；父对话验收后面板把这一步标完成，你不要自己标。改了代码的照样要先评审、跑通验证：这些和版本管理方式无关，面板会照样校验。`
  if (kind === 'push')
    return `${head}
做法：${WRAP_UP.push.note}。计划里的其他步骤都做完、验证通过、改动已在本地提交之后再推；这一步做完自己用 set_plan 把它标完成，面板不会替你标。在独立分支里时按上面「执行目录」那段先合回原分支，再在原目录推送原分支并合并主干。`
  return `${head}
${p4Rules(host)}分好之后调用 submit_merge 请父对话验收（tests 写上跑过的编译和测试，handoff 写交接要点）：父对话验收后面板把这一步标完成，你不要自己标。改了代码的照样要先评审、跑通验证：这些和版本管理方式无关，面板会照样校验。不 submit、不 revert、不 sync。`
}

/**
 * P4 分 changelist 的规则：项目里的对话都要知道（以前只写给子对话，父对话自己放 CL 时建出过「[C++/Lua] …」），
 * 有 p4_split_changelists 时交给面板分，Agent 只写描述
 */
function p4Rules(host: EngineHost) {
  const head = `这是 P4 工作区，修改前先 p4 edit / add 进 default changelist（限定到具体文件）；edit 前用 p4 fstat -T haveRev,headRev <文件> 看是不是最新版本，本地版本落后（haveRev 小于 headRev）时先告诉用户要同步，你自己不 sync。p4 diff / status / reconcile / fstat 都要带具体文件或任务目录，不对整个工作区跑（大项目会扫几分钟本地文件）；查改了哪些文件用 p4 opened -c，它只问服务器、不扫本地。把改动放进 pending changelist 时按文件类型分开，不能全留在 default，也不能把几类放进同一个（不要建「[C++/Lua] …」这种）：
- [C++]：.c / .cc / .cpp / .cxx / .h / .hh / .hpp / .inl / .ixx / .mm
- [XLSX]（表格）：.xlsx / .xlsm / .xlsb / .xls / .csv
- [Lua]：.lua（只提交源码，不编译成 .luac，也不提交 .luac）
- [Other]：其余要提交的代码、资源和配置
${p4DocsSkip(host.policy?.docs)}`
  if (host.p4Split)
    return `${head}调用 p4_split_changelists 分：面板按上面的类型建 pending 并挪文件，你只在 descriptions 里给这次有文件的每一类写一句中文描述（25 字以内，只说改了什么，不带标签；超长会被退回）。default 里有不属于这次任务的文件时用 files 只列本次的；已经混在一个 pending 里的用 from 写它的编号拆开。本来就在你已有 pending 里的文件留在原处。看它返回的编号和回读结果，`
  return `${head}只建这次真的有文件的类型；本来就在你（当前用户、当前 client）已有 pending 里的文件留在原 changelist，不挪别人的。新建用 p4 change -i 读 UTF-8 临时文件，再 p4 reopen -c <编号> <文件>；描述只写一行「[类型] 中文短句」（25 字以内，只说改了什么）。用 p4 opened -c <编号> 核对每个文件、p4 describe -s 回读确认描述没有乱码，`
}

/** 不是子对话收尾的场合（父对话、工作流节点）：P4 项目里也要按类型分 changelist */
export function p4Part(host: EngineHost) {
  if (!host.p4Split || wrapKind(host) === 'p4') return ''
  return `## P4 changelist\n${p4Rules(host)}不 submit、不 revert、不 sync。`
}

/** 对话的目标：用户在父对话设置里写的，父对话按它取舍，子对话知道自己这部分是为了什么 */
export function goalPart(host: EngineHost) {
  const goal = host.goal?.trim()
  if (!goal) return ''
  return host.task.parentTaskId
    ? `## 父对话的目标\n${clip(goal, 4000)}\n你做的是其中一部分，取舍时以这个目标为准。`
    : `## 这个对话的目标\n${clip(goal, 4000)}\n判断要不要做、做到哪一步、怎么分派时以这个目标为准。`
}

/** 父对话发布的全局规则：子对话和它的所有节点都要遵守；父对话自己看到的是「你发布的」 */
export function rulesPart(host: EngineHost) {
  const rules = (host.rules ?? []).map((r) => r.trim()).filter(Boolean)
  if (!rules.length) return ''
  const list = rules.map((r, i) => `${i + 1}. ${clip(r, 2000)}`).join('\n')
  return host.task.parentTaskId
    ? `## 全局规则（父对话发布，必须遵守）\n${list}\n和其他要求冲突时以这些规则为准；做不到的地方用 message_parent 告诉父对话，不要自己绕过。`
    : `## 这个对话的全局规则\n你和用户在这个对话里发布的规则，所有子对话都会收到并遵守：\n${list}`
}

/** 父对话：上一轮之后子对话发来的消息（汇报、提问），这一轮一起处理 */
export function inboxPart(host: EngineHost) {
  const got = host.takeInbox?.() ?? []
  if (!got.length) return ''
  // 「提问」关着时子对话的提问 / 收尾建议不会交给用户，等的是父对话自己的决定
  const ask = host.task.askUser
    ? ''
    : '「提问」关着：子对话的提问和收尾建议都由你决定，用户不会回答。按已有信息选最合理的做法，写清「你替他决定了什么、依据、如果不对怎么改」，缺关键信息也选一个默认方案继续并在结论里标出；不要空着等用户。'
  return `## 子对话发来的消息\n${got.map((m) => `- 「${m.title}」：${clip(m.text, 20000)}`).join('\n')}\n需要回复的用 send_to_conversation 交回给对应的子对话。${ask}`
}

/**
 * 写文件的格式：项目设置在全局设置里定的编码和换行符。
 * 说清楚是为了避免 Windows 上写出的 CRLF / BOM 让脚本在 WSL / Linux 里跑不起来。
 */
function fileFormatPart(host: EngineHost) {
  const f = host.fileFormat
  if (!f) return ''
  const enc = f.encoding === 'utf8-bom' ? 'UTF-8（带 BOM）' : 'UTF-8（不带 BOM）'
  const eol = f.eol === 'crlf' ? 'CRLF（Windows）' : 'LF'
  const tip =
    f.eol === 'lf' && f.encoding === 'utf8'
      ? '这样在 WSL / Linux 里执行带 shebang 的脚本不会报 bad interpreter。'
      : '和项目设置保持一致，不要自己改成别的换行符。'
  return `## 文件格式\n新建或改写的文本文件统一用 ${enc}、换行符 ${eol}。${tip}\n已经有文件的编码和换行符不要批量转换，只改这次任务涉及的内容。`
}

/**
 * 同一个任务里各个节点（包括主 Agent、派出的子 Agent）都一样的开头：需求、工作流说明、通用要求。
 * 放在最前面，按前缀匹配缓存的模型服务（Codex 等）能多命中一段
 */
/**
 * 独立分支里的子对话（连同它的工作流节点）：编译、测试都在自己的分支目录里跑，验证通过后交给面板合回原分支。
 * 分支目录是新检出的，没有依赖和编译产物，不说的话 Agent 会以为环境坏了
 */
export function buildPart(host: EngineHost) {
  // UE 项目的子对话不编译：「在分支里编译测试」那一段换成申请编译
  if (host.ueBuild) return uePart(host.ueBuild.role, !!host.isolated, !!host.submitMerge)
  if (!host.submitMerge) return ''
  if (!host.isolated) return sharedWrapPart()
  return `## 在独立分支里验证，再请父对话收尾
编译、测试都在你这个独立分支的目录里跑，不用交给别人：合并就是验收，合进去的代码就算验收通过，所以能在你这里做的测试都在合并之前、在这里做完。
- 这个目录是新检出的，没有依赖和编译产物：第一次编译、测试前按项目的方式装好依赖（例如 npm ci），装出来的东西不要提交。
- 只剩合回时调用 submit_merge 请父对话收尾：计划其余步骤都做完、后台命令都结束、没有等回答的提问、按下面的「验证」跑通，tests 写上跑了哪些编译、测试和结果，handoff 按模板写交接要点（关键文件和模块必填，以后再交给你时上下文大就只带这份摘要，写清哪里的代码、哪些文档、做了什么决定）。面板把改动提交到你的分支，父对话合回原分支（父对话所在的分支）、把计划最后的收尾步骤标完成、结束这个子对话并删除独立分支。调用后结束这一轮。
- 验证没跑通不要调用，先修好；做完却不调用的，面板会提醒你。父对话合不进去（冲突）或者觉得验证不够时会退回给你，按它说的处理好再调用。合并结果推回来之前不说完成。不要推送这个分支（面板会拦下，git push 报 remote-agent-panel-no-push），也不要自己去原目录合并。`
}

/** 对话自己改代码时的验证范围：小改动跑快速检查就收尾，省掉完整测试的时间 */
export function verifyPart(host: EngineHost): string[] {
  const v = host.verify
  if (!v) return []
  const [rules, picked] = verifyParts(v.steps, {
    platform: v.platform,
    wslDistro: v.wslDistro,
    scaled: v.scaled,
    parentRun: v.parentRun,
    changedFiles: v.changedFiles,
  })
  // 收尾总结里的耗时统计：只对独立分支的子对话提，它才是写收尾总结的那个。
  // 项目配了测试步骤就要求（不限于范围为 parent 的）：它自己跑的那几步也有后台命令的真实耗时
  const timed = v.parentRun === 'child' && v.steps.some((x) => x.enabled)
  // 规则、本轮结论、耗时要求各是一段：改动清单一变只重发结论那段（见 shared/prompt-delta.ts）
  return [rules, picked, timed ? TEST_TIME_SUMMARY_RULE : '']
}

/** 要改文件时才开独立分支：不说清楚的话模型会直接在原目录里改，隔离就落空了 */
export function editPart(host: EngineHost) {
  if (!host.beginEdit) return ''
  return `## 改文件前先开独立分支
这个对话设成了在独立分支里改文件，现在你还在原目录里：看代码、回答问题、跑只读的命令都可以直接做，但不要在这里改、新建或删除任何文件，也不要跑会写文件的命令。
- 确定要改文件时先调用 begin_edit，面板从当前目录开一个独立分支。能确定要改、改哪几处时就调用，不要先把要改的文件逐个读完再开：开分支后会在新目录里接着做，之前读过的内容要重读，模型那边的缓存也会作废。
- 调用成功后用一两句写下已经查到的情况和打算怎么改，然后马上结束这一轮；面板会切到独立分支的目录里，带上这段对话接着改。
- 只是回答问题、出方案时不用调用。`
}

/**
 * 对话的执行计划：当前计划和维护规则。项目里的对话（父、子都有）每一轮都带上，
 * 计划的规则由面板在 set_plan 里兜底（完成的锁死、做完收起），这里讲清楚什么时候列、怎么更新、等待怎么挂
 */
export function planPart(host: EngineHost, coordinator: boolean): string[] {
  const { task } = host
  if (!task.projectId) return []
  const kind = wrapKind(host)
  const cur = activePlan(task)
  const nowMs = Date.now()
  const now = cur ? `当前计划：\n${planText(task, cur)}` : '现在没有进行中的计划。'
  // ADR 0020：每轮都把「当前第几步、多久没更新、下一步」正面摆在前面；滞后 / 新输入没处理时再插一条提醒
  const check = [planNowText(task, nowMs), planNotice(task, nowMs)].filter(Boolean).join('\n')
  // 当前计划和维护规则分成两段：计划每轮都在变，规则不变，续接会话时只重发前一段（见 shared/prompt-delta.ts）
  return [
    `## 执行计划\n${now}`,
    // 进度一句（「已 N 分钟」每分钟都变）单独成段：计划没动时只重发这一句，不连计划全文。
    // 这一段总要有：变空了会被列进「不再适用的规则」，计划收起或只剩收尾那一轮，模型会以为计划不用管了
    `## 计划进度\n${check || (cur ? '没有进行中或待做的步骤：前面的都做完了，就接着做计划最后的收尾步骤。' : '没有进行中的计划。')}`,
    `## 计划怎么维护
- 三步以上、不是一下就能做完的事，先用 set_plan 列出计划再动手；单一、简单的事和纯问答不用列。做的过程中发现新的步骤就加进计划。面板按计划判断你做完没有：动了手却没列计划、或者计划没做完就结束这一轮，面板会推你接着做。
- 最多两层：主步骤写要交付的一件事，子步骤写这件事里的具体动作。步骤名写做什么，不写怎么想的。某个主步骤要交给工作流时调用 start_workflow 并带上它的 step，等它的方式和等子对话一样。
- **动手前先把这一步标成「进行中」**（set_plan 带它的 id + status），一份计划里同时只能有一个进行中；**做完立刻**在同一批动作里把它标完成、再把下一步标进行中。不要连着做完几步再一起更新，也不要在计划里还有进行中的步骤时去做别的步骤的事。
- **按计划一直做下去**：计划没做完、也没在等结果时，不要结束这一轮——做完一步马上接着做下一步。不要只写一句「接下来跑检查 / 先改某处」就停下，要做的事直接调用工具去做；只有全部做完、卡住了要问、或者在等结果时才结束这一轮。
- 什么算完成一步：改完代码并且跑通这一步该跑的检查（这一步涉及多项时，跑完它该跑的那几项）；只是起了个子任务、跑完一条命令、写了一段说明，都不算完成。
- **要等结果的用「等待中」，不要用「进行中」**：调用 run_background${coordinator ? ' / create_conversation / send_to_conversation' : ''} 时带上 step，面板会把那一步标成等待中，你立刻接着做计划的下一步，不要干等或轮询。结果推回来时先处理那一步：成功面板会标完成；没成功面板会把它退回进行中、备注写「需要修复：原因」——计划里没有「失败」，先查清原因修好后重做，确实不做了才标跳过并写明原因。跑十几分钟的命令、等子对话时那一步本来就该是等待中。
- **新输入先判计划**：这一轮的输入带了新要求（用户新消息、父对话转达、子对话 / 后台结果里带了新任务）时，第一件事是判断现有计划要不要改——要改就立刻 set_plan 再动手；不改就用一句话说明为什么不变，再继续。
- **增量还是重开**：同一件事的细化、加一步、插一步、调顺序、改步骤名、作废某一步 → 用 set_plan 带已有步骤 id、partial: true 只交变更项（默认做法）；目标本身变了（换方向、需求被推翻、方案整体换掉）、剩下的步骤大部分作废、或者用户明确说「重新做 / 换个方案 / 别按刚才那个来」→ 先 finish_plan 结束这份计划，再用 set_plan 带新 title 开一份新的（旧计划和耗时留在「以前的计划」里）。只加内容却整份重开、或者换了方向还在旧计划上打补丁，都不行。
- 每次 set_plan 交整份列表时，已有的步骤带上 id；步骤一多（10 条以上）就分两批交：一批带上 partial 为 true 只写要变的步骤（带 id），其余没写到的步骤留在计划里不动，免得一次拼一大段 JSON 拼错。
- 完成的步骤不再重开：后来的内容哪怕和它完全一样，也新加一步去做。
- 用户中途加了内容：先判断它该放进计划的哪一步——属于还没完成的步骤就并进那一步（加子步骤），不属于就在合适的位置新加主步骤，然后按计划接着做。同一件事不要另开一份计划。
- 计划的步骤全部完成后调用 finish_plan 结束这份计划（不需要写总结）；之后再有新内容，用 set_plan 开一份新的计划（写 title）。这一轮该给用户的结论照常写——那是回复内容，不是计划总结。
${
  kind
    ? `- 计划的最后一步「${WRAP_UP[kind].title}」由面板加在最后，别删、别挪到前面，也不要自己再写一条重复的收尾步骤（见下面「收尾：计划的最后一步」）。
`
    : ''
}- 不要用 CLI 自带的待办 / 计划工具（TodoWrite、update_plan 这类）记计划，用 set_plan，用户在面板的计划窗口里看进度。${
      coordinator
        ? `
- 你是父对话：分析只做到判断这件事属于哪个模块、该交给哪个子对话为止，具体定位和修改交给子对话，把你查到的模块、文件和线索一起交过去。交给子对话的每件事是计划里的一个主步骤，带 step 挂成等待中；用户随时发来的新消息马上答复或分派，不要因为在等子对话让用户等。
- 子对话停住、被中断、没继续：用 send_to_conversation 交回原来那个子对话接着做（面板会把它重新拉起来），不要另建一个子对话重做同一件事；只有它确实起不来（交回时报错、状态是失败）才另建，并在派单里写明接手的是哪个子对话的活。`
        : ''
    }`,
  ]
}

/**
 * 节点 / 子任务共用的开头。helper：派出的子任务（不含「版本控制」）——授权和收尾、合并流程是写给要交付的对话的，
 * 子任务拿到整段只会多读上千字，父对话允许推送时还会读到「做完就推送并合并主干」
 */
export function commonPart(host: EngineHost, w?: Workflow, chat = false, helper = false, vcsHelper = false) {
  const req = requestParts(host.task)
  // 授权段按调用者给（shared/sub-policy.ts）：子任务、「版本控制」子任务、顶层的节点各一段，子对话里的节点读子对话那份
  const sub = subPolicy({ helper, vcsHelper, child: !!host.task.parentTaskId, project: !!host.policy })
  const policy = sub ?? policyPart(host)
  return [
    req.head,
    // 放在前面：同一个任务里各个节点提示词的开头都一样，按前缀匹配缓存的模型服务能多命中一段
    promptLangRules(),
    req.extra,
    w?.document.trim() ? `## 工作流说明\n${w.document.trim()}` : '',
    // 对话（含它派出的子任务）用不到共享状态：对话里跑过工作流后 task.runs 会留着上一次运行，
    // 注入旧状态会让模型去调根本没注册的 read_state / write_state
    chat ? '' : statePart(host.task),
    [policy, docRootText(host.policy?.docs) || plainDocRootText(host.policy?.docRoot)].filter(Boolean).join('\n\n'),
    goalPart(host),
    rulesPart(host),
    searchPart(host),
    // UE 项目里子任务也不能编译（整台机器共用 UBT / DDC，见 uePart），只留这一句
    helper
      ? host.ueBuild
        ? '## UE 编译\n这是 UE 项目：子任务不编译（Build.bat、UBT、UHT、Cook、启动 Editor 都不做），只改代码、做不需要编译的检查。'
        : ''
      : buildPart(host),
    fileFormatPart(host),
    // 总结的类型和字段在 shared/summary-card.ts 定义，界面按同一张表把它画成卡片
    summaryCardRules(),
    `## 通用要求\n完成后用${promptLangWord()}按上面的「总结格式」写总结卡：做了什么、改了哪些文件、有没有遗留问题都在卡片字段里。\n` +
      // 用户 2026-11-11 报：Agent 删掉自己加的代码时只删代码那几行，当初一起加的空行留在原处（P4 项目里没有差异给评审，常漏到提交）
      '删掉你自己加过的代码（临时日志、调试代码、改主意不要的实现）时，把当时一起加的空行也删掉，删完那一处要和加之前一样；删整段时要删的内容连同前后多出来的空行一起框进去，删完看一眼那几行，不留只剩空行的改动。\n' +
      // 一次输出太长时，模型服务的连接容易中途断开，整个节点白做
      '写很长的文件时分几次写：先写开头一部分，再分段追加或编辑补上，每次不超过约 300 行；不要一次输出整个大文件。\n' +
      // 用户明确要求：所有命令静默跑。弹出来的窗口既把结果带走（对话拿不到输出），也打断用户手上的事
      '所有命令都在当前会话里静默执行，不要新开命令行或终端窗口（start、cmd /k、Start-Process、wt、open -a Terminal 这类），除非用户明确要求打开窗口。',
  ]
}

/**
 * 评审代码改动的子任务用的开头（ADR 0013）：只留需求、语言、用户补充、目标和必须遵守的规则。
 * 工作流说明、搜索排除、编译收尾、授权和文件格式都是写给动手的角色的，评审拿到只会去搜项目、跑检查
 */
export function reviewCommonPart(host: EngineHost) {
  const req = requestParts(host.task)
  return [req.head, promptLangRules(), req.extra, goalPart(host), rulesPart(host)]
}

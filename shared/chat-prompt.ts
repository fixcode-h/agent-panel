/**
 * Chat 模式（Chat 页没有项目的顶层对话）一轮的提示词（ADR 0038）。
 * 不套项目对话那一整套：没有授权情况（没有项目就没有推送策略）、搜索排除、工作流、执行方式、子对话、
 * 面板计划、收尾和总结卡（用户 2026-11-01 定：Chat 页不要总结卡）。以前共用一套时 Chat 页读到「调用面板工具 ask_push」
 * 「你是项目对话」，可这些工具和身份都不存在。
 * 计划用 CLI 自带的待办 / 计划（TodoWrite、Codex 的 plan 这类）：只有 CLI 定义写了 todos 的才会被面板解析显示，
 * 其余的让模型在回复里列；面板计划只在 Agent 模式。放在单独的文件里：engine.ts 到了行数上限
 */
import type { EngineHost } from './engine.ts'
import { promptLangRules } from './prompt-lang.ts'

/** 能用后台命令时说清楚什么时候用：不说的话模型照样同步跑长命令，一直卡着（项目对话和 Chat 模式共用） */
export function backgroundPart(host: Pick<EngineHost, 'runBackground'>) {
  if (!host.runBackground) return ''
  return `## 长命令放到后台
预计超过一分钟的命令（完整测试、端到端测试、长时间的检查、编译）用 run_background 交给面板在后台跑，它马上返回，结果跑完会自动推回给你：
- 等结果的时候接着做不依赖它的事：读代码、写文档、改和这条命令无关的文件。不要改这条命令要检查的文件，改了结果就不算数（面板会标出期间被改过）。
- 编译、打包这类会抢文件锁的命令把 exclusive 设为 true，面板按项目排队，同一时间只跑一个。
- 面板一直盯着它直到真正结束：成功、失败、被停止、超过限时都会把结果推回来；十分钟没有任何输出、或者跑了很久（15 分钟起，之后间隔翻倍）也会提醒你看一眼。按命令正常要多久写 timeout_minutes（写宽一些），不写默认两小时。手上没有别的事时直接结束这一轮，对话会停在「等结果」，结果到了接着处理；不要反复调用 check_background 轮询，也不要用 sleep 干等。
- 结果推回来先核对用时和输出是不是合理；提醒你没输出时用 check_background 看一眼，确认卡住就用 stop_background 停掉、查清原因再重跑。
- 不要在前台用 sleep 等待（等 CI、等部署、等别的进程）：前台命令跑着时用户发来的消息要等它结束才能处理。要等就把等待和检查写成一条命令交给 run_background，或者直接结束这一轮、告诉用户你在等什么。
- 几秒就能跑完的命令照常直接执行。`
}

/** todos：这一轮的 CLI 自带待办会不会被面板显示（CLI 定义的 todos 字段，见 EngineHost.cliTodos） */
export const chatModePart = (todos: boolean) => `## Chat 模式
这是 Chat 页的对话：不属于任何项目，没有子对话、子任务和工作流。${
  todos
    ? '多步的事用你自己（CLI 自带）的待办 / 计划工具列出来，面板会把它显示给用户。'
    : '多步的事先把计划列出来再做：面板不显示这个 CLI 的待办，所以计划和做到哪一步都写在回复里（编号列表）。'
}要拆给多个 Agent 并行、要按项目流程（评审、测试验收、版本控制）做的事，请用户到项目里开对话。`

/** extra：对话里用 /rule 发布的规则、对话目标这类随对话变的段落（由 engine 拼好传进来，没有时是空串） */
export function chatConversationPrompt(
  host: Pick<EngineHost, 'prompt' | 'runBackground' | 'cliTodos'>,
  extra: string[],
) {
  return [
    `## 用户这次的消息\n${host.prompt}`,
    promptLangRules(),
    ...extra,
    backgroundPart(host),
    chatModePart(!!host.cliTodos),
  ].filter(Boolean)
}

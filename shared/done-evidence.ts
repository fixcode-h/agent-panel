import { z } from 'zod'
import type { TaskMessage, TestStep, ToolUse } from './schema.ts'
import { PANEL_TOOL_RE, panelToolName } from './panel-tools.ts'

/**
 * 完成依据（分析稿 A3）：Agent 用 end_turn 记成「做完了」时，面板从这一轮的工具调用记录里整理出
 * 改了哪些文件、跑过哪些验证命令和退出码，记在那次结束上（EndTurnRecord.evidence），对话停下后画成一张卡片。
 *
 * 做没做完原来只有 Agent 自己说了算：子对话有评审和收尾核对，顶层对话自己直接改的没有第二道。
 * 这里只看工具调用（硬规则：不按回复文字判断状态，ADR 0041、0049）：
 * - 改了代码（改文件类调用里有不是文档的文件）却一条验证命令都没跑：卡片上标出来，默认只标不拦；
 * - 项目设置打开「改了代码要跑过测试步骤才能结束」（Project.requireVerify）时，end_turn 被拒并说清原因（endTurnCheck）。
 * 「验证命令」：项目配了测试步骤时认命令里含某条步骤命令的；也认常见的测试、类型检查、lint、编译命令。
 * 配了测试步骤又打开了拦截时，只认测试步骤（用户要的就是「按项目的步骤跑过」）
 */

export const EvidenceCommand = z.object({
  command: z.string(),
  /** CLI 报得出时才有 */
  exitCode: z.number().optional(),
  failed: z.boolean().optional(),
  /** 对上了哪条测试步骤（步骤名） */
  step: z.string().optional(),
})
export type EvidenceCommand = z.infer<typeof EvidenceCommand>

export const DoneEvidence = z.object({
  /** 这一轮改过的文件（工具调用点名的，去重，最多 FILES_MAX 个） */
  files: z.array(z.string()).default([]),
  /** 超出 FILES_MAX 没列出来的文件数 */
  moreFiles: z.number().int().optional(),
  /** 这一轮跑过的验证命令（最多 COMMANDS_MAX 条，同一条命令只留最后一次） */
  commands: z.array(EvidenceCommand).default([]),
  /** 改的文件里有代码（不全是文档） */
  code: z.boolean().default(false),
  /** 改了代码却一条验证命令都没跑 */
  unverified: z.boolean().default(false),
})
export type DoneEvidence = z.infer<typeof DoneEvidence>

const FILES_MAX = 30
const COMMANDS_MAX = 12
/** 命令原文最多留多长：卡片上一行显示 */
const COMMAND_MAX = 300

/** 只算文档、不算代码的文件：只改了这些不要求跑验证 */
const DOC_RE = /\.(md|mdx|markdown|txt|rst|adoc)$/i

/** 常见的验证命令：测试、类型检查、lint、编译。按命令的写法认，宽泛的 build 只认包管理器脚本这类明确入口 */
const VERIFY_RES = [
  /\b(?:npm|pnpm|yarn|bun)\s+(?:run\s+)?(?:test|typecheck|type-check|lint|check|build|verify|e2e)\b/i,
  /(?:^|[\s;&|(])(?:npx\s+|bunx\s+)?(?:tsc|vitest|jest|pytest|mocha|eslint|oxlint|ruff|mypy|pyright|phpunit|rspec)\b/i,
  /\bplaywright\s+test\b/i,
  /\b(?:cargo|go|dotnet|swift)\s+(?:test|check|build|vet|clippy)\b/i,
  /\b(?:mvn|mvnw|gradle|gradlew)\b.*\b(?:test|verify|check|build)\b/i,
  /\b(?:make|ninja|ctest)\s+(?:test|check)\b/i,
  /\bnode\s+--test\b/i,
  /\bpython3?\s+-m\s+(?:pytest|unittest)\b/i,
]

const isPanel = (x: Pick<ToolUse, 'name' | 'label'>) =>
  !!(panelToolName(x.name ?? '') || PANEL_TOOL_RE.test(`${x.name ?? ''} ${x.label}`))

const squash = (s: string) => s.replace(/\s+/g, ' ').trim()

/** 这条命令对上了哪条测试步骤（命令里含步骤的命令原文） */
export function matchStep(command: string, steps: Pick<TestStep, 'name' | 'command'>[]) {
  const c = squash(command)
  return steps.find((s) => {
    const want = squash(s.command)
    return !!want && c.includes(want)
  })
}

/** 是不是验证命令：对上测试步骤，或者是常见的测试 / 检查 / 编译命令 */
export function isVerifyCommand(command: string, steps: Pick<TestStep, 'name' | 'command'>[] = []) {
  return !!matchStep(command, steps) || VERIFY_RES.some((re) => re.test(command))
}

/** 这一轮的消息（从这一轮的输入之后起）里整理完成依据 */
export function doneEvidence(
  msgs: Pick<TaskMessage, 'role' | 'tools'>[],
  steps: Pick<TestStep, 'name' | 'command'>[] = [],
): DoneEvidence {
  const files: string[] = []
  const commands = new Map<string, EvidenceCommand>()
  for (const m of msgs) {
    if (m.role !== 'agent') continue
    for (const x of m.tools) {
      if (isPanel(x) || x.running) continue
      if (x.kind === 'edit' && !x.failed && x.label.trim()) {
        const f = x.label.trim()
        if (!files.includes(f)) files.push(f)
      } else if (x.kind === 'run') {
        const cmd = squash(x.label || x.input || '')
        if (!cmd || !isVerifyCommand(cmd, steps)) continue
        const step = matchStep(cmd, steps)?.name
        // 同一条命令跑了几次只留最后一次：卡片看的是「最后跑成什么样」
        commands.delete(cmd)
        commands.set(cmd, {
          command: cmd.slice(0, COMMAND_MAX),
          ...(x.exitCode !== undefined && { exitCode: x.exitCode }),
          ...(x.failed && { failed: true }),
          ...(step && { step }),
        })
      }
    }
  }
  const code = files.some((f) => !DOC_RE.test(f))
  const list = [...commands.values()].slice(-COMMANDS_MAX)
  return {
    files: files.slice(0, FILES_MAX),
    ...(files.length > FILES_MAX && { moreFiles: files.length - FILES_MAX }),
    commands: list,
    code,
    unverified: code && !list.length,
  }
}

/**
 * 打开了「改了代码要跑过测试步骤才能结束」时，这一轮能不能记成做完：返回拒绝的说明（交给 Agent，不翻译），能结束返回空。
 * 配了测试步骤的只认测试步骤；没配的认常见的验证命令
 */
export function verifyGateError(ev: DoneEvidence, steps: Pick<TestStep, 'name' | 'command'>[]): string {
  if (!ev.code) return ''
  const named = steps.filter((s) => s.command.trim())
  if (named.length) {
    if (ev.commands.some((c) => c.step)) return ''
    const list = named
      .slice(0, 6)
      .map((s) => `「${s.name}」${s.command}`)
      .join('；')
    return `这一轮改了代码（${ev.files.slice(0, 3).join('、')}${ev.files.length > 3 ? ' 等' : ''}），还没跑过项目的测试步骤：项目设置要求改了代码先跑测试步骤再结束。按适用的步骤跑一遍（${list}），看结果，再调用 end_turn。`
  }
  if (ev.commands.length) return ''
  return `这一轮改了代码（${ev.files.slice(0, 3).join('、')}${ev.files.length > 3 ? ' 等' : ''}），还没跑过任何验证命令：项目设置要求改了代码先验证再结束。这个项目没配测试步骤，跑一下能验证这次改动的测试、类型检查或编译，看结果，再调用 end_turn。`
}

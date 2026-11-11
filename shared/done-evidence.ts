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
 * 配了测试步骤又打开了拦截时，只认测试步骤（用户要的就是「按项目的步骤跑过」）。
 *
 * 工具调用之外还有两份材料（TurnExtra，服务端在 end_turn 时现取，见 server/exec/turn-extra.ts）：
 * - 用命令（sed、脚本、代码生成）改的文件：调用记录里看不出来，取这一轮的工作区快照差补上；
 * - 插件工具（MCP）按声明报的「改了哪些文件」「验证通过没有」：解析层把它们都记成 other，不补就看不见。
 */

export const EvidenceCommand = z.object({
  command: z.string(),
  /** CLI 报得出时才有 */
  exitCode: z.number().optional(),
  failed: z.boolean().optional(),
  /** 对上了哪条测试步骤（步骤名） */
  step: z.string().optional(),
  /** 插件工具报的验证（command 是验证的名字，不是命令行） */
  plugin: z.boolean().optional(),
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

/** 工具调用之外补进来的材料（见文件开头）：都是这一轮的 */
export interface TurnExtra {
  /** 命令改的、插件工具改的文件（相对工作目录） */
  files?: string[]
  /** 插件工具报的验证 */
  commands?: EvidenceCommand[]
  /** 插件验证通过、之后没再改过的文件：门禁不再要求它们走项目的测试步骤（改资产和改代码各走各的验证） */
  covered?: string[]
}

/** 门禁看的测试步骤：老数据、单测只给名字和命令，适用范围按「总是执行」算 */
export type GateStep = Pick<TestStep, 'name' | 'command'> & Partial<Pick<TestStep, 'appliesTo' | 'scope' | 'enabled'>>

const normPath = (f: string) => f.trim().replace(/\\/g, '/').replace(/^\.\//, '')

/** 这一轮改过的全部文件：改文件类调用点名的（成功的），加上补进来的（同一个文件一个写相对路径、一个写绝对路径时不重复列） */
export function turnFiles(msgs: Pick<TaskMessage, 'role' | 'tools'>[], extra: TurnExtra = {}): string[] {
  const files: string[] = []
  const seen = new Set<string>()
  const add = (f: string) => {
    const k = normPath(f)
    if (!k || seen.has(k)) return
    seen.add(k)
    files.push(f.trim())
  }
  for (const m of msgs) {
    if (m.role !== 'agent') continue
    for (const x of m.tools) if (x.kind === 'edit' && !x.failed && !x.running && !isPanel(x)) add(x.label)
  }
  for (const f of extra.files ?? []) add(f)
  return files
}

/** 门禁要的另两样：这一轮改过的全部文件、插件验证过的文件（end-turn.ts 交给 verifyGateError） */
export const gateFiles = (msgs: Pick<TaskMessage, 'role' | 'tools'>[], extra: TurnExtra = {}) => ({
  files: turnFiles(msgs, extra),
  covered: extra.covered ?? [],
})

/** 这一轮的消息（从这一轮的输入之后起）里整理完成依据 */
export function doneEvidence(
  msgs: Pick<TaskMessage, 'role' | 'tools'>[],
  steps: Pick<TestStep, 'name' | 'command'>[] = [],
  extra: TurnExtra = {},
): DoneEvidence {
  const files = turnFiles(msgs, extra)
  const commands = new Map<string, EvidenceCommand>()
  for (const m of msgs) {
    if (m.role !== 'agent') continue
    for (const x of m.tools) {
      if (isPanel(x) || x.running) continue
      if (x.kind === 'run') {
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
  for (const c of extra.commands ?? []) {
    commands.delete(c.command)
    commands.set(c.command, c)
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

/** 这条验证最后一次是失败的：CLI 报了失败，或者退出码不是 0 */
const failedRun = (c: EvidenceCommand) => !!c.failed || (c.exitCode !== undefined && c.exitCode !== 0)

/** 每个名字（测试步骤名、插件验证名）最后一次的结果：commands 按跑的先后排，后面的盖掉前面的 */
function lastBy(list: EvidenceCommand[], key: (c: EvidenceCommand) => string | undefined) {
  const out = new Map<string, EvidenceCommand>()
  for (const c of list) {
    const k = key(c)
    if (k) out.set(k, c)
  }
  return out
}

const exitText = (c: EvidenceCommand) => (c.exitCode !== undefined ? `，退出码 ${c.exitCode}` : '')

const FAILED_TAIL =
  '先修好再跑通，然后调用 end_turn；确实修不了（环境问题、要用户提供东西），用 end_turn 的 blocked 写明卡在哪、需要谁做什么。'

/**
 * 打开了「改了代码要跑过测试步骤才能结束」时，这一轮能不能记成做完：返回拒绝的说明（交给 Agent，不翻译），能结束返回空。
 * 配了测试步骤的只认测试步骤；没配的认常见的验证命令。
 * - 只看适用的步骤（开着、命令非空、stepApplies 按这一轮改的文件筛过）：只改了 Lua、配置时不逼它去整编 C++；一条都不适用就放行；
 * - 跑失败不算过：适用的步骤里跑过的，最后一次都要成功；没配步骤的看最后一次验证命令；
 * - 插件工具报的验证（UE 蓝图编译这类）最后一次失败同样拒绝；验证通过的文件不再要求走项目步骤（extra.covered）。
 * files 是这一轮改过的全部文件（ev.files 最多列 30 个，筛步骤要看全的）
 */
export function verifyGateError(
  ev: DoneEvidence,
  steps: GateStep[],
  opts: {
    files?: string[]
    covered?: string[]
    /**
     * 这条步骤对这批改动适不适用：end-turn.ts 交 shared/test-steps.ts 的 stepApplies 进来。
     * 不在这里直接导入：schema.ts 经 turn-end.ts 用到这个文件，test-steps.ts 又导入 schema.ts，会成环
     */
    applies?: (step: GateStep, files: string[]) => boolean
  } = {},
): string {
  if (!ev.code) return ''
  const changed = (opts.files ?? ev.files).map(normPath)
  const head = `这一轮改了代码（${changed.slice(0, 3).join('、')}${changed.length > 3 ? ' 等' : ''}）`
  const pluginBad = [...lastBy(ev.commands, (c) => (c.plugin ? c.command : undefined)).values()].filter(failedRun)
  if (pluginBad.length)
    return `${head}，插件的验证「${pluginBad.map((c) => c.command).join('」「')}」最后一次没通过：${FAILED_TAIL}`
  const covered = new Set((opts.covered ?? []).map(normPath))
  const files = changed.filter((f) => f && !DOC_RE.test(f) && !covered.has(f))
  // 改的代码都已经由插件验证过（只改了资产、蓝图编译通过）
  if (!files.length) return ''
  const shell = ev.commands.filter((c) => !c.plugin)
  const live = steps.filter((s) => s.enabled !== false && s.command.trim())
  if (live.length) {
    const due = opts.applies ? live.filter((s) => opts.applies!(s, files)) : live
    if (!due.length) return ''
    const last = lastBy(shell, (c) => c.step)
    const ran = due.filter((s) => last.has(s.name))
    if (!ran.length) {
      const list = due
        .slice(0, 6)
        .map((s) => `「${s.name}」${s.command}`)
        .join('；')
      return `${head}，还没跑过项目的测试步骤：项目设置要求改了代码先跑测试步骤再结束。按适用的步骤跑一遍（${list}），看结果，再调用 end_turn。`
    }
    const bad = ran.filter((s) => failedRun(last.get(s.name)!))
    if (bad.length)
      return `${head}，测试步骤${bad.map((s) => `「${s.name}」`).join('')}最后一次没通过${bad.length === 1 ? exitText(last.get(bad[0].name)!) : ''}：${FAILED_TAIL}`
    return ''
  }
  const end = shell.at(-1)
  if (!end)
    return `${head}，还没跑过任何验证命令：项目设置要求改了代码先验证再结束。这个项目没配测试步骤，跑一下能验证这次改动的测试、类型检查或编译，看结果，再调用 end_turn。`
  if (failedRun(end))
    return `${head}，最后一次验证命令（${end.command.slice(0, 80)}）没通过${exitText(end)}：${FAILED_TAIL}`
  return ''
}

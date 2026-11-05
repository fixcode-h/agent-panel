/**
 * Bug 报告按阶段走（用户 2026-11-05 定的）：论证（加日志 → 用户复现贴日志 → 分析，可以多轮）→ 根因（用户同意或否决）
 * → 修复方案（用户确认）→ 修复 → 验证（用户复现贴日志，AI 分析没问题就收尾；用户也可以点结束跳过验证）。
 * 这里放阶段的判定、每个阶段交报告要齐的东西、能改哪些文件、用户的决定交给 AI 的话；
 * 交报告、确认、收尾核对的入口在 bug-diagnosis.ts。交给 Agent 的话是提示词，不翻译
 */
import type { BugCase, BugPhase, Diagnosis, DiagnosisNote } from './bug-diagnosis-schema.ts'

export const normPath = (p: string) => p.trim().replace(/\\/g, '/').replace(/^\.\//, '').replace(/^\/+/, '')

/** 日志计划里的位置可能写成 `path:行号`：只取文件 */
const fileOf = (p: string) => normPath(p).replace(/:\d+(:\d+)?$/, '')

/** 这一版是哪个阶段：旧数据没有 phase，根因证实了的当修复方案（以前根因和方案是一版），没证实的当论证 */
export const phaseOf = (d: Pick<Diagnosis, 'phase' | 'confirmed'>): BugPhase =>
  d.phase ?? (d.confirmed ? 'plan' : 'evidence')

const PHASES: BugPhase[] = ['evidence', 'cause', 'plan', 'verify']

export const PHASE_TEXT: Record<BugPhase, string> = {
  evidence: '论证',
  cause: '根因',
  plan: '修复方案',
  verify: '验证',
}

/** 最后一版论证或根因（判断能不能往方案走） */
const lastCore = (list: Diagnosis[]) =>
  [...list].reverse().find((d) => phaseOf(d) === 'evidence' || phaseOf(d) === 'cause')

/** 交方案要先有用户同意的根因：最后一版论证 / 根因是用户同意了的根因；旧数据里确认过的方案也算 */
export function causeAgreed(list: Diagnosis[]): boolean {
  const core = lastCore(list)
  if (core) return phaseOf(core) === 'cause' && core.status === 'approved'
  return list.some((d) => phaseOf(d) === 'plan' && d.status === 'approved')
}

/** 最后一版修复方案，且它之后没有回到论证 / 根因 */
export function lastPlan(list: Diagnosis[]): Diagnosis | undefined {
  for (let i = list.length - 1; i >= 0; i--) {
    const p = phaseOf(list[i])
    if (p === 'plan') return list[i]
    if (p === 'evidence' || p === 'cause') return undefined
  }
  return undefined
}

/** 交验证要先有用户确认、已经修完的方案 */
export const planApproved = (list: Diagnosis[]) => lastPlan(list)?.status === 'approved'

/** 论证阶段加过临时日志的文件：修完要删，删的时候不算超出方案 */
export const logFilesOf = (list: Diagnosis[]) => [
  ...new Set(
    list
      .filter((d) => phaseOf(d) === 'evidence')
      .flatMap((d) => [...d.logPlan.map((l) => fileOf(l.file)), ...d.files.map(fileOf)])
      .filter(Boolean),
  ),
]

/** 日志计划里的文件和这次写的 files 合起来：同意加日志后只放行这些 */
export const evidenceFiles = (c: Pick<BugCase, 'logPlan' | 'files'>) => [
  ...new Set([...c.logPlan.map((l) => fileOf(l.file)), ...c.files.map(fileOf)].filter(Boolean)),
]

/**
 * 这次交的是哪个阶段：参数里写了就按它；没写按档案推（根因没证实是论证；证实了看有没有同意过的根因、确认过的方案）
 */
export function inputPhase(input: Record<string, unknown>, c: BugCase, list: Diagnosis[]): BugPhase {
  const p = input.phase
  if (typeof p === 'string' && (PHASES as string[]).includes(p)) return p as BugPhase
  if (!c.confirmed) return 'evidence'
  if (planApproved(list)) return 'verify'
  return causeAgreed(list) ? 'plan' : 'cause'
}

/**
 * 能改哪些文件：files 是放行的范围（还要排除 FREE_FILE 由调用方处理），deny 是不能改时给 Agent 的话。
 * 同意加日志后只放行日志计划里的文件；确认方案后放行方案里的文件，加上论证时加过日志的文件（要删临时日志）
 */
export function editScope(list: Diagnosis[]): { files: string[] } | { deny: string } {
  const d = list.at(-1)
  if (!d) return { deny: '这是用户报的 Bug：先按流程查，用 submit_diagnosis 交报告，用户同意了再改文件。' }
  const phase = phaseOf(d)
  const v = d.version
  if (d.status === 'pending')
    return {
      deny: d.awaiting
        ? `第 ${v} 版的日志已经加好，在等用户复现贴日志：先不改文件，等用户的回复。`
        : `第 ${v} 版报告还在等用户确认：确认之前不改文件，先等用户的回复。`,
    }
  if (d.status === 'questioned')
    return { deny: `用户对第 ${v} 版提了意见：先逐条处理、用 submit_diagnosis 交新一版，用户同意后再改文件。` }
  if (d.status === 'cancelled')
    return {
      deny: `用户取消了第 ${v} 版，这次不修：不改文件。用户要你接着修时，先用 submit_diagnosis 交新一版，确认后再改。`,
    }
  if (phase === 'evidence') {
    if (d.status === 'approved') return { files: d.files }
    return {
      deny: `用户给了第 ${v} 版要的日志：先分析，交下一版（还没定论交 phase: evidence 继续论证，证实了交 phase: cause）。`,
    }
  }
  if (phase === 'cause')
    return { deny: `用户同意了第 ${v} 版的根因：先交 phase: plan 的修复方案，用户确认后再改文件。` }
  const plan = lastPlan(list)
  if (!plan || plan.status !== 'approved')
    return { deny: '还没有用户确认的修复方案：先交 phase: plan，用户确认后再改文件。' }
  return { files: [...new Set([...plan.files, ...logFilesOf(list)])] }
}

export const KIND_TEXT: Record<DiagnosisNote['kind'], string> = {
  question: '疑问',
  change: '改方案',
  info: '补充信息',
}

const quoteOf = (n: DiagnosisNote) => (n.quote ? `「${n.quote.replace(/\s+/g, ' ').slice(0, 300)}」` : '')

/** 用户的标注逐条列出来 */
export const notesList = (notes: DiagnosisNote[]) =>
  notes.map((n) => `${n.id}. [${KIND_TEXT[n.kind]}]${quoteOf(n)}${n.comment ? `：${n.comment}` : ''}`).join('\n')

const CLEANUP =
  '收尾前把 `[排查-` 前缀的临时日志全部删掉（面板会核对）；修改的代码里排查需要的正式日志要留下或补上：按项目已有的日志写法、级别和前缀，打关键分支和关键值，不打密钥和大段数据，下次出同类问题看日志就能定位。'

/** 用户的决定交给 AI 的话：按这一版的阶段和用户的选择分别写 */
export function phaseFeedback(d: Diagnosis): string {
  const v = d.version
  const phase = phaseOf(d)
  const overall = d.overall ? `\n\n用户的整体意见：${d.overall}` : ''
  const notes = d.notes.length ? `\n\n用户的标注：\n${notesList(d.notes)}` : ''
  const logs = d.logs.trim() ? `\n\n用户贴的日志：\n\`\`\`\n${d.logs.trim()}\n\`\`\`` : ''
  const files = d.logFiles.length ? `\n\n用户附上的日志文件（随这条消息附上）：${d.logFiles.join('、')}` : ''
  if (d.status === 'questioned') {
    const back =
      phase === 'cause'
        ? '\n\n用户否决了这版根因：觉得用户说得对、证据确实不完整，就回到论证，交 phase: evidence 的新一版（新的日志计划）；证据其实够，就交 phase: cause 的新一版逐条回答。'
        : phase === 'verify'
          ? '\n\n验证没通过：把这次修法和失败证据写进「已排除」，回到论证（phase: evidence）或交新一版修复方案（phase: plan）。'
          : ''
    return `用户对第 ${v} 版（${PHASE_TEXT[phase]}）还有意见，先不要改文件：
${notesList(d.notes) || '（没有逐条标注，见整体意见）'}${overall}${back}

逐条查清后用 submit_diagnosis 交新一版：answers 按编号回答「疑问」和「改方案」（查了什么、结论、补了什么证据或改了哪一节），「补充信息」用进报告里即可。只处理被问到的几条，别的小节照抄上一版，不要整份重写。`
  }
  if (d.status === 'answered') {
    if (phase === 'verify')
      return `用户按第 ${v} 版的验证步骤复现了，给了结果。只分析这一段日志，对照「看到什么算修好了」：
- 没问题：用 update_bug_case 的 result 记下验证结果，${CLEANUP}然后请父对话收尾（submit_merge）。
- 还有问题：不在这次修法上接着改，把修法和失败证据写进「已排除」，回到论证交 phase: evidence 的新一版，或交新一版 phase: plan。${overall}${logs}${files}`
    return `用户按第 ${v} 版的日志计划复现了，给了日志。只分析这一段（不混进以前的日志），对照「每种结果说明什么」更新假设表：
- 证据链三环齐了、根因证实：交 phase: cause（confirmed: true），写清证据链和每条现象怎么解释。
- 还没定论：交 phase: evidence 的新一版，写下一轮要加的日志和为什么；上一轮的临时日志先留着，最后一起删。${overall}${logs}${files}`
  }
  // approved
  if (phase === 'evidence')
    return `用户同意了第 ${v} 版的日志计划，现在加日志：
- 只在日志计划里的文件加，统一前缀 \`[排查-<主题>]\`，打出计划里写的值，不改任何逻辑。
- 加完能自己复现（跑测试、跑命令）就自己跑，分析后交下一版（还没定论交 phase: evidence，证实了交 phase: cause）。
- 自己复现不了：调用 request_logs 写清复现步骤、日志在哪、过滤条件，然后结束这一轮，等用户贴日志。${notes}${overall}`
  if (phase === 'cause')
    return `用户同意了第 ${v} 版的根因。现在设计修复方案，交 phase: plan：影响面、至少两个有实质区别的修法和五项比较、选定和理由、要改的文件、验证计划；修改处要留哪些正式日志也写进方案。用户确认之前不改文件。${notes}${overall}`
  if (phase === 'plan')
    return `用户确认了第 ${v} 版的修复方案，按它修：
- 先写改前失败的测试（没法自动化的写成可重复的手工步骤），再按方案改。
- 只改方案里的文件：${d.files.map((f) => `\`${f}\``).join('、') || '（见方案）'}（补测试、回写文档、翻译不算）。要改别的文件，先交新一版方案写明为什么，等用户确认。
- 修完用 update_bug_case 的 result 记下回归测试和影响面逐条的验证，然后交 phase: verify：collect 写用户怎么复现验证、日志在哪、看到什么算修好了，等用户给结果。
- 改完验证不过：不要在这次修法上接着改，把修法和失败证据写进「已排除」，回到论证交新一版。${notes}${overall}`
  return `用户在第 ${v} 版点了结束，跳过验证。${CLEANUP}然后请父对话收尾（submit_merge）。${notes}${overall}`
}

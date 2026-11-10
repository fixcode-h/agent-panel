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

/** 第几版：旧数据没有 rev，按交报告的顺序号 */
export const revOf = (d: Pick<Diagnosis, 'rev' | 'version'>) => d.rev ?? d.version

/**
 * 新交的这一份是第几版（用户 2026-11-06 定：版本号只在方案被推翻时往上加）。
 * - 回到更早的阶段（根因被否决回到论证、验证没过回到论证或重出方案）：之前的结论不成立了，+1。
 * - 用户确认过的修复方案换成新方案（修的时候发现要改别的文件）：+1。
 * - 按用户的意见修改、论证多轮、阶段往下走（论证 → 根因 → 方案 → 验证）：还是同一版。
 * 只看阶段和用户的决定，不看回复的文字
 */
export function nextRev(list: Diagnosis[], phase: BugPhase): { rev: number; overturned: boolean } {
  const prev = list.at(-1)
  if (!prev) return { rev: 1, overturned: false }
  const from = phaseOf(prev)
  const back = PHASES.indexOf(phase) < PHASES.indexOf(from)
  const replan = phase === 'plan' && from === 'plan' && prev.status === 'approved'
  const overturned = back || replan
  return { rev: revOf(prev) + (overturned ? 1 : 0), overturned }
}

/** 这一份是这一版里同一阶段的第几轮（按意见改了几次、论证了几轮）：弹窗的版本下拉用来区分 */
export function roundOf(d: Diagnosis, list: Diagnosis[]): number {
  const i = list.indexOf(d)
  const before = i >= 0 ? list.slice(0, i + 1) : [...list, d]
  return before.filter((x) => revOf(x) === revOf(d) && phaseOf(x) === phaseOf(d)).length
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

/**
 * 快速级别根因和方案合成一版（用户 2026-11-05 定：一行就能修的 Bug 不用确认三道）：这一版是修复方案，
 * 它之前没有用户同意过的根因，根因就跟着这一版一起确认。list 是全部版本（含这一版），只看它之前的
 */
export function causeInPlan(d: Diagnosis, list: Diagnosis[]): boolean {
  // 只有快速级别能合成：别的级别（含没有 phase 的旧数据）照旧是单独确认的方案
  if (phaseOf(d) !== 'plan' || d.level !== 'quick') return false
  const i = list.indexOf(d)
  return !causeAgreed(i >= 0 ? list.slice(0, i) : list)
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
 * 用户点了「不修了」之后给 Agent 的话：报告关闭，不再交新版、不改文件；用户回头又要修，请他在父对话重新报这个 Bug。
 * 交报告、改文件、收尾三处共用一个说法。发给 Agent 的提示词，不翻译
 */
export const closedInfo = (v: number) =>
  `用户在第 ${v} 版点了「不修了」，这份诊断报告已经关闭：不能再交新一版，也不改文件。用户之后又要修，告诉用户在父对话里重新报这个 Bug（会开新的子对话），不要在这里接着修。`

/**
 * 不修了、但临时日志还没删完（shared/bug-cleanup.ts）：这时要它删日志，不能说「不改文件」
 * （实跑时它刚删完日志又收到「不改文件」，接着去请父对话收尾）
 */
export const cleaningInfo = (v: number) =>
  `用户在第 ${v} 版点了「不修了」，现在只删临时日志：用改文件工具把 [排查-] 日志一处一处删掉（连加日志时带进来的空行），不改别的，删完结束这一轮，面板会核对；不交报告，也不请父对话收尾。`

/** 取消后还在删临时日志（Agent 删着，或核对没过等用户决定） */
export const cleaning = (d: Pick<Diagnosis, 'status' | 'cleanup'> | undefined) =>
  d?.status === 'cancelled' && (d.cleanup?.state === 'running' || d.cleanup?.state === 'failed')

/** 取消后要删的文件：查到临时日志的文件，加上用户勾了一起删的新文件 */
export const cleanupFiles = (d: Pick<Diagnosis, 'cleanup'>) => [
  ...new Set([...(d.cleanup?.found ?? []).map((x) => x.file), ...(d.cleanup?.drop ?? [])]),
]

/** 报告关闭时的说法：清理中和已关闭分开（交报告、改文件、收尾三处共用） */
export const closedOrCleaning = (d: Pick<Diagnosis, 'status' | 'cleanup'>, v: number) =>
  cleaning(d) ? cleaningInfo(v) : closedInfo(v)

/**
 * 能改哪些文件：files 是放行的范围（还要排除 FREE_FILE 由调用方处理），deny 是不能改时给 Agent 的话。
 * 同意加日志后只放行日志计划里的文件；确认方案后放行方案里的文件，加上论证时加过日志的文件（要删临时日志）
 */
export function editScope(list: Diagnosis[]): { files: string[] } | { deny: string } {
  const d = list.at(-1)
  if (!d) return { deny: '这是用户报的 Bug：先按流程查，用 submit_diagnosis 交报告，用户同意了再改文件。' }
  const phase = phaseOf(d)
  const v = revOf(d)
  if (d.status === 'pending')
    return {
      deny: d.awaiting
        ? `第 ${v} 版的日志已经加好，在等用户复现贴日志：先不改文件，等用户的回复。`
        : `第 ${v} 版报告还在等用户确认：确认之前不改文件，先等用户的回复。`,
    }
  if (d.status === 'questioned')
    return { deny: `用户对第 ${v} 版提了意见：先逐条处理、用 submit_diagnosis 改好再交，用户同意后再改文件。` }
  // 取消后删临时日志：只放行查到日志的文件（和用户勾了要删的新文件），其余照旧不改
  if (d.status === 'cancelled') return cleaning(d) ? { files: cleanupFiles(d) } : { deny: closedInfo(v) }
  if (phase === 'evidence') {
    if (d.status === 'approved') return { files: d.files }
    return {
      deny: `用户给了第 ${v} 版要的日志：先分析，再交报告（还没定论交 phase: evidence 继续论证，证实了交 phase: cause）。`,
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

// 正式日志只对已有日志体系的模块要求（实测：纯函数库照「留下或补上正式日志」会被推着加 console.log）
const CLEANUP =
  '收尾前把 `[排查-` 前缀的临时日志全部删掉（面板会核对）。正式日志：改到的模块已经有日志体系的，按它的写法、级别和前缀在关键分支补上关键值（不打密钥和大段数据），下次出同类问题看日志就能定位；没有日志的模块（纯函数、工具库）不加，在 result 里写一句为什么不加。'

/** 用户的决定交给 AI 的话：按这一版的阶段和用户的选择分别写 */
export function phaseFeedback(d: Diagnosis): string {
  const v = revOf(d)
  const phase = phaseOf(d)
  const overall = d.overall ? `\n\n用户的整体意见：${d.overall}` : ''
  const notes = d.notes.length ? `\n\n用户的标注：\n${notesList(d.notes)}` : ''
  const logs = d.logs.trim() ? `\n\n用户贴的日志：\n\`\`\`\n${d.logs.trim()}\n\`\`\`` : ''
  const files = d.logFiles.length
    ? `\n\n用户给的日志文件（本机路径，用工具读，大文件按需分段读）：${d.logFiles.join('、')}`
    : ''
  if (d.status === 'questioned') {
    const back =
      phase === 'cause'
        ? `\n\n用户否决了这版根因：觉得用户说得对、证据确实不完整，就回到论证，交 phase: evidence（新的日志计划，面板记成第 ${v + 1} 版）；证据其实够，就再交 phase: cause 逐条回答（还是第 ${v} 版）。`
        : phase === 'verify'
          ? `\n\n验证没通过：把这次修法和失败证据写进「已排除」，回到论证（phase: evidence）或重新出修复方案（phase: plan），面板记成第 ${v + 1} 版。`
          : ''
    return `用户对第 ${v} 版（${PHASE_TEXT[phase]}）还有意见，先不要改文件：
${notesList(d.notes) || '（没有逐条标注，见整体意见）'}${overall}${back}

逐条查清后用 submit_diagnosis 再交（按意见修改还是第 ${v} 版，不升版本号）：answers 按编号回答「疑问」和「改方案」（查了什么、结论、补了什么证据或改了哪一节），「补充信息」用进报告里即可。只处理被问到的几条，别的小节照抄上一版，不要整份重写。`
  }
  if (d.status === 'answered') {
    if (phase === 'verify')
      return `用户按第 ${v} 版的验证步骤复现了，给了结果。只分析这一段日志，对照「看到什么算修好了」：
- 没问题：用 update_bug_case 的 result 记下验证结果，${CLEANUP}然后请父对话收尾（submit_merge）。
- 还有问题：不在这次修法上接着改，把修法和失败证据写进「已排除」，回到论证交 phase: evidence，或重新出方案交 phase: plan（面板记成第 ${v + 1} 版）。${overall}${logs}${files}`
    return `用户按第 ${v} 版的日志计划复现了，给了日志。只分析这一段（不混进以前的日志），对照「每种结果说明什么」更新假设表：
- 证据链三环齐了、根因证实：交 phase: cause（confirmed: true），写清证据链和每条现象怎么解释。
- 还没定论：再交一轮 phase: evidence（还是第 ${v} 版）。next 写清这一轮的日志看到了什么、为什么没能定论（路标停在哪一跳、哪些假设排除了）、新假设从哪来；把假设表更新全，再按「论证的日志一次加够」把这条新路径上的分叉和路标一次补齐，不只补一两处。上一轮的临时日志先留着，最后一起删。${overall}${logs}${files}`
  }
  // approved
  if (phase === 'evidence')
    return `用户同意了第 ${v} 版的日志计划，现在加日志：
- 日志计划里的每一处都加上（不挑几处先加），只在日志计划里的文件加，统一前缀 \`[排查-<主题>]\`，打出计划里写的值，不改任何逻辑。
- 加完能自己复现（跑测试、跑命令）就自己跑，分析后再交报告（还没定论交 phase: evidence，证实了交 phase: cause）。
- 自己复现不了：调用 request_logs 写清复现步骤、日志在哪、过滤条件，然后结束这一轮，等用户贴日志。${notes}${overall}`
  if (phase === 'cause')
    return `用户同意了第 ${v} 版的根因。现在设计修复方案，交 phase: plan：影响面、至少两个有实质区别的修法和五项比较、选定和理由、要改的文件、验证计划；模块已有日志体系的，修改处要留哪些正式日志也写进方案。用户确认之前不改文件。${notes}${overall}`
  if (phase === 'plan')
    return `用户确认了第 ${v} 版的修复方案，按它修：
- 先写改前失败的测试（没法自动化的写成可重复的手工步骤），再按方案改。
- 只改方案里的文件：${d.files.map((f) => `\`${f}\``).join('、') || '（见方案）'}（补测试、回写文档、翻译不算）。要改别的文件，先重新交 phase: plan 写明为什么（换掉确认过的方案，面板记成第 ${v + 1} 版），等用户确认。
- 修完用 update_bug_case 的 result 记下回归测试和影响面逐条的验证，然后交 phase: verify：collect 写用户怎么复现验证、日志在哪、看到什么算修好了，等用户给结果。
- 改完验证不过：不要在这次修法上接着改，把修法和失败证据写进「已排除」，回到论证重新交报告。${notes}${overall}`
  return `用户在第 ${v} 版点了结束，跳过验证。${CLEANUP}然后请父对话收尾（submit_merge）。${notes}${overall}`
}

/** 不改方案也能顺带改的：测试、文档、翻译（修 Bug 本来就要补回归测试、回写文档） */
const FREE_FILE = /(^|\/)(tests?|__tests__|docs|locales?)\/|\.(test|spec)\.[^/]+$|\.md$/i

/** 实际改动里超出已确认范围的文件：范围里写目录（以 / 结尾）时目录下的都算 */
export function outOfPlan(changed: string[], files: string[]) {
  const plan = files.map(normPath).filter(Boolean)
  return changed
    .map(normPath)
    .filter((p) => p && !FREE_FILE.test(p))
    .filter((p) => !plan.some((f) => p === f || (f.endsWith('/') && p.startsWith(f))))
}

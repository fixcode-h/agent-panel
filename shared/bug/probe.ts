/**
 * 补排查（设计稿「Bug 模式子对话体验」第 1 节）：报告出来以后随时加日志、调试绘制、其他临时代码，报告不重出、阶段不变。
 * 一次补排查就是一个「排查窗口」：窗口开着的这一轮面板放行改文件（server/hooks/guards.ts 的 bugDeny），
 * 改之前给要动的文件拍快照，这一轮结束后逐行核对改了什么——只许新增带标记的行：
 * 单行带 `[排查-P3]`，多行用一对注释 `// [排查-P2 开始]` … `// [排查-P2 结束]` 包起来。
 * 判断只看 diff，不看回复里说了什么（ADR 0041、0049）。
 * 这里只放纯函数（编号、标记解析、核对、给 Agent 的话）；读写文件、快照在 server/tasks/bug-probe.ts
 */
import { t } from '../i18n.ts'
import { lineDiff, linesOf } from './cleanup.ts'
import type { BugProbe, BugRepro, ProbeKind, ProbeProblem, ProbeSpot, ProbeState } from './probe-schema.ts'

type WithProbes = { probes?: BugProbe[]; repros?: BugRepro[] } | undefined

export const PROBE_KIND_TEXT = (): Record<ProbeKind, string> => ({
  log: t('补日志'),
  draw: t('调试绘制'),
  code: t('其他临时代码'),
})

export const PROBE_STATE_TEXT = (): Record<ProbeState, string> => ({
  adding: t('在加'),
  added: t('刚加好'),
  bad: t('没按规则加'),
  removing: t('在撤'),
  removed: t('已撤掉'),
  stuck: t('没撤干净'),
})

/** 下一个编号：P 后面的数字接着往上数，撤掉的也占着号（复现记录、对话里提到的编号不会指错） */
export const nextProbeId = (list: BugProbe[] = []) =>
  `P${list.reduce((m, p) => Math.max(m, Number(p.id.slice(1)) || 0), 0) + 1}`

/** 窗口开着的那一条：在加或在撤。同一时间只开一个窗口 */
export const openProbe = (bug: WithProbes) => bug?.probes?.find((p) => p.state === 'adding' || p.state === 'removing')

/** 还在代码里的（没撤掉的） */
export const liveProbes = (bug: WithProbes) => (bug?.probes ?? []).filter((p) => p.state !== 'removed')

/** 有加好了的：能放到用户的工作区复现 */
export const probedReady = (bug: WithProbes) => (bug?.probes ?? []).some((p) => p.state === 'added')

/** 能撤的：加好了、没按规则加、上次没撤干净 */
export const removable = (p: BugProbe) => p.state === 'added' || p.state === 'bad' || p.state === 'stuck'

/** 补排查动过的文件（没撤掉的那几条）：收尾、不修了时要删，放行改它们 */
export const probeFiles = (bug: WithProbes) => [
  ...new Set(liveProbes(bug).flatMap((p) => [...p.spots.map((s) => s.file), ...p.problems.map((x) => x.file)])),
]

/** 按文件后缀取注释符号：Lua、SQL 用 --，脚本和配置用 #，其余（C++、TS、C#…）用 // */
export function commentOf(file: string): string {
  if (/\.(lua|sql|hs)$/i.test(file)) return '--'
  if (/\.(py|sh|bash|zsh|rb|ya?ml|toml|ps1|pl|r|cmake)$/i.test(file) || /(^|\/)(CMakeLists\.txt|Makefile)$/.test(file))
    return '#'
  return '//'
}

const single = (id: string) => `[排查-${id}]`
const start = (id: string) => `[排查-${id} 开始]`
const end = (id: string) => `[排查-${id} 结束]`

/** 这一条在文件里占哪几行（下标从 0 起）：带 `[排查-P3]` 的行，加上成对标记之间（含两头）的行 */
export function probeLineSet(lines: string[], id: string): Set<number> {
  const out = new Set<number>()
  for (let i = 0; i < lines.length; i++) {
    if (lines[i].includes(single(id))) out.add(i)
    if (!lines[i].includes(start(id))) continue
    out.add(i)
    const j = lines.findIndex((l, k) => k > i && l.includes(end(id)))
    // 只有开始没有结束：只认开始这一行，剩下的照常按「没带标记」核对
    if (j < 0) continue
    for (let k = i + 1; k <= j; k++) out.add(k)
    i = j
  }
  return out
}

const blank = (s: string) => !s.trim()

/** 和这几行挨着的连续空行（加的时候常顺手带一个空行，撤的时候一起删） */
function blankNeighbours(lines: string[], set: Set<number>, among?: Set<number>): Set<number> {
  const out = new Set<number>()
  const ok = (i: number) => i >= 0 && i < lines.length && blank(lines[i]) && (!among || among.has(i))
  for (const i of set) {
    for (let k = i - 1; ok(k) && !set.has(k); k--) out.add(k)
    for (let k = i + 1; ok(k) && !set.has(k); k++) out.add(k)
  }
  return out
}

const cut = (s: string) => s.trim().slice(0, 300)

/**
 * 加完核对一个文件：base 是加之前的快照，now 是现在。新加的行要么带这一条的标记，要么是挨着它们的空行；
 * 原有的行一行都不能动。spot 是加在哪（第一行带标记的行、加了几行），没加东西时没有 spot
 */
export function checkProbeAdd(
  id: string,
  file: string,
  base: string,
  now: string,
): { spot?: ProbeSpot; problems: ProbeProblem[] } {
  const lines = linesOf(now)
  const mine = probeLineSet(lines, id)
  const ops = lineDiff(base, now)
  const added = new Set(ops.flatMap((o) => (o.op === 'add' ? [o.b] : [])))
  const ownBlank = blankNeighbours(lines, new Set([...mine].filter((i) => added.has(i))), added)
  const problems: ProbeProblem[] = []
  let count = 0
  let first = -1
  for (const o of ops) {
    if (o.op === 'del') problems.push({ file, line: o.a + 1, text: cut(o.text), why: 'changed' })
    if (o.op !== 'add') continue
    if (mine.has(o.b) || ownBlank.has(o.b)) {
      count++
      if (mine.has(o.b) && (first < 0 || o.b < first)) first = o.b
    } else problems.push({ file, line: o.b + 1, text: cut(o.text), why: 'unmarked' })
  }
  return { spot: first >= 0 ? { file, line: first + 1, lines: count } : undefined, problems }
}

/**
 * 撤完核对一个文件：pre 是点「撤掉」那一刻的内容，ids 是这一次一起撤的几条（同一个文件里可能有好几条）。
 * 这几条的行（和挨着的空行）要删掉，别的行一行都不能动
 */
export function checkProbeRemove(ids: string[], file: string, pre: string, now: string): ProbeProblem[] {
  const lines = linesOf(pre)
  const mine = new Set(ids.flatMap((id) => [...probeLineSet(lines, id)]))
  const optional = blankNeighbours(lines, mine)
  const problems: ProbeProblem[] = []
  for (const o of lineDiff(pre, now)) {
    if (o.op === 'add') problems.push({ file, line: o.b + 1, text: cut(o.text), why: 'extra' })
    if (o.op === 'del' && !mine.has(o.a) && !optional.has(o.a))
      problems.push({ file, line: o.a + 1, text: cut(o.text), why: 'changed' })
    if (o.op === 'same' && mine.has(o.a)) problems.push({ file, line: o.b + 1, text: cut(lines[o.a]), why: 'left' })
  }
  return problems
}

/** 日志里认出的标记：`[排查-P3]`、`[排查-P2 开始]` 里的 P3、P2，论证日志的主题（`[排查-购物车]`） */
export function markerHits(text: string): string[] {
  const out = new Set<string>()
  for (const m of text.matchAll(/\[排查-([^\]\s]{1,60})/g)) out.add(m[1])
  return [...out]
}

/** 这一条打出来过没有：最近一次复现在它加好之后、日志里有它的编号 */
export function probeHit(p: BugProbe, repros: BugRepro[] = []): 'hit' | 'miss' | undefined {
  const after = repros.filter((r) => !p.doneAt || r.at >= p.doneAt)
  if (!after.length) return undefined
  return after.some((r) => r.hits.includes(p.id)) ? 'hit' : 'miss'
}

export const nextReproId = (list: BugRepro[] = []) => `R${list.length + 1}`

/** 复现记录最多留这么多条：再多的也看不过来，留最近的 */
const MAX_REPROS = 30

/** 取到一段新增日志：记一条复现记录（带 [排查- 的一行都没有也记，「该打没打」本身就是证据） */
export function addRepro(
  bug: { repros?: BugRepro[] },
  got: { path: string; startLine: number; endLine: number; related: number; hits?: string[] },
  at: string,
): BugRepro {
  const list = (bug.repros ??= [])
  const r: BugRepro = {
    id: nextReproId(list),
    at,
    path: got.path,
    startLine: got.startLine,
    endLine: got.endLine,
    related: got.related,
    hits: (got.hits ?? []).slice(0, 100),
  }
  list.push(r)
  if (list.length > MAX_REPROS) list.splice(0, list.length - MAX_REPROS)
  return r
}

const KIND_RULE: Record<ProbeKind, string> = {
  log: '打出用户想看的值；日志的输出文字以 `[排查-{id}]` 开头（面板取日志时按它认出是哪一处打出来的），用项目已有的日志写法。',
  draw: '用项目已有的调试绘制（UE 的 DrawDebug*、前端临时画个框、写个角标），画出用户想看的位置和数值；几行的代码整段用一对标记包起来。',
  code: '临时改常量、跳过一步、强制走某个分支：原有的行一行都不改，在它前后新增带标记的行实现（重新赋值、提前 return、包一层判断）。',
}

/**
 * 开窗口时交给 Agent 的话（提示词，不翻译）：要加什么、加在哪、每处改动都带标记、加完就停。
 * files 是用户点选的调用栈位置；没点就让它自己定
 */
export function probeAddPrompt(p: Pick<BugProbe, 'id' | 'kind' | 'ask' | 'targets'>, rev?: number): string {
  const where = p.targets.length
    ? `加在这几处（用户从调用栈里点的）：\n${p.targets.map((x) => `- ${x}`).join('\n')}`
    : '加在哪由你按报告的调用栈和代码定，加在能回答用户问题的最少几处。'
  const kind = KIND_RULE[p.kind].replaceAll('{id}', p.id)
  return `用户要补排查（编号 ${p.id}，${rev ? `第 ${rev} 版报告不变、阶段不变，` : ''}这一轮面板放开改文件，只做这一件事）：
${p.ask}

${where}

规则（这一轮结束面板按改动逐行核对，不看你的回复）：
- ${kind}
- 只新增带标记的行，原有的行一行都不改、不删。
- 单行：这一行里带 \`[排查-${p.id}]\`。多行：用一对注释包起来，上面一行写 \`// [排查-${p.id} 开始]\`，下面一行写 \`// [排查-${p.id} 结束]\`（注释符号按文件的语言，Lua 用 --、Python 用 #）。
- 只用改文件工具改，不用 shell 命令写文件（面板在你改之前给文件拍快照，撤掉时按快照核对）。
- 加完就结束这一轮：不交诊断报告、不改报告、不请父对话收尾。能自己跑起来复现的可以跑，看到了什么写在回复里；要重新编译或热重载才生效的，回复里写一句。`
}

const EMPTY = '这一轮没有加任何带标记的代码（或者没用改文件工具改，面板没拍到快照）'

const WHY_TEXT: Record<ProbeProblem['why'], string> = {
  unmarked: '新加的这一行没带标记',
  changed: '改了 / 删了原有的这一行',
  left: '这一行还在',
  extra: '多出了这一行',
  empty: '',
}

/** 核对没过的地方，一行一处（给 Agent 和清单里那一行共用） */
export function problemText(list: ProbeProblem[]): string {
  return list
    .map((x) => (x.why === 'empty' ? `- ${EMPTY}` : `- ${x.file}:${x.line} ${WHY_TEXT[x.why]}：${x.text}`))
    .join('\n')
}

/** 加的时候没按规则来：用户点「让它改」时交给 Agent 的话，窗口重新开一轮 */
export function probeRetryPrompt(p: Pick<BugProbe, 'id' | 'problems'>): string {
  return `补排查 ${p.id} 面板核对没过，这几处不合规则：
${problemText(p.problems)}
改好：没带标记的新行补上 \`[排查-${p.id}]\` 标记（多行用一对 \`[排查-${p.id} 开始]\` / \`[排查-${p.id} 结束]\` 包起来），改动过的原有行改回原样。只做这些，改完结束这一轮，面板会再核对。`
}

/** 撤掉几条：交给 Agent 一处一处删（提示词，不翻译） */
export function probeRemovePrompt(list: Pick<BugProbe, 'id' | 'spots'>[]): string {
  const rows = list
    .map(
      (p) =>
        `- ${p.id}：${p.spots.map((s) => `${s.file}:${s.line}`).join('、') || '按编号在你加过的文件里找'}（带 [排查-${p.id}] 的行，和成对的 [排查-${p.id} 开始] … [排查-${p.id} 结束] 整段）`,
    )
    .join('\n')
  return `用户要撤掉补排查加的临时代码：
${rows}
用改文件工具一处一处删：只删这几条带标记的行和成对标记之间的行，加的时候带进来的空行一起删；别的行一行都不改，不要用 git checkout / git restore / p4 revert 整个文件还原（文件里还有别的改动）。删完结束这一轮，面板会核对；不交报告，也不请父对话收尾。`
}

/** 临时排查改动清单的一行：论证时的日志（L1…，来自报告的日志计划）和补排查加的（P1…）合起来显示 */
export type LedgerRow = {
  id: string
  from: 'evidence' | 'probe'
  kind: ProbeKind
  file: string
  line?: number
  /** 论证日志：第几版、打什么；补排查：用户写的那句 */
  text: string
  rev?: number
  /** 加了几行（论证日志不知道，按一行算） */
  lines: number
  state?: ProbeState
  hit?: 'hit' | 'miss'
  probe?: BugProbe
}

type LedgerBug =
  | {
      probes?: BugProbe[]
      repros?: BugRepro[]
      diagnoses?: {
        phase?: string
        confirmed?: boolean
        rev?: number
        version: number
        logPlan: { id: string; file: string; line?: number; print: string; fn: string }[]
      }[]
    }
  | undefined

/**
 * 清单的全部行：论证日志按编号去重（多轮论证同一处只列一次，留最早那版），补排查按编号。
 * 撤掉了的补排查留在清单里（灰掉）：对话里、复现记录里提到的编号还对得上
 */
export function ledgerRows(bug: LedgerBug): LedgerRow[] {
  const rows: LedgerRow[] = []
  const seen = new Set<string>()
  const repros = bug?.repros ?? []
  for (const d of bug?.diagnoses ?? []) {
    if ((d.phase ?? (d.confirmed ? 'plan' : 'evidence')) !== 'evidence') continue
    for (const l of d.logPlan) {
      const id = l.id || `L${seen.size + 1}`
      if (seen.has(id)) continue
      seen.add(id)
      rows.push({
        id,
        from: 'evidence',
        kind: 'log',
        file: l.file.replace(/:\d+(:\d+)?$/, ''),
        line: l.line,
        text: l.print || l.fn,
        rev: d.rev ?? d.version,
        lines: 1,
        hit: repros.some((r) => r.hits.includes(id)) ? 'hit' : undefined,
      })
    }
  }
  for (const p of bug?.probes ?? [])
    rows.push({
      id: p.id,
      from: 'probe',
      kind: p.kind,
      file: p.spots[0]?.file ?? p.problems.find((x) => x.file)?.file ?? '',
      line: p.spots[0]?.line,
      text: p.ask,
      rev: p.rev,
      lines: p.spots.reduce((n, s) => n + s.lines, 0),
      state: p.state,
      hit: p.state === 'added' ? probeHit(p, repros) : undefined,
      probe: p,
    })
  return rows
}

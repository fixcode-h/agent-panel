/**
 * 面板复核回归测试（分析稿 B9）：「改前失败、改后通过」以前只有修的那个 Agent 自己说。
 * 修复、验证这一版交上来后，面板把档案里写的回归测试命令（result.commands）在改前的代码（对话开始时的提交，
 * 加上现在的测试文件）和现在的代码上各跑一次，真实输出放进修复、验证页；跑不了的照实标「面板没有复核」。
 * 这里放纯函数（要跑哪些、怎么判、页面上怎么写），跑命令在 server/tasks/bug-recheck.ts。
 * 判定只看退出码，不看输出里写了什么
 */
import type { Diagnosis, Recheck, RecheckRun } from './diagnosis-schema.ts'
import { alert, sec, table } from './md.ts'
import { phaseOf } from './phase.ts'
import { t } from '../i18n.ts'
import type { TaskMessage } from '../schema.ts'

/** 一条命令最多跑多久：测试套件跑得久的也够，卡死的不会一直占着 */
export const RECHECK_TIMEOUT_MS = 5 * 60_000
/** 输出只留最后这么多字：失败的断言、汇总都在末尾 */
export const RECHECK_OUT_MAX = 6000

const norm = (s: string) => s.replace(/\s+/g, ' ').trim()

/** 测试文件：改前那一次要用现在的测试去跑旧代码（新写的回归测试改前还不存在） */
export const TEST_FILE = /(^|\/)(tests?|__tests__|spec)\/|\.(test|spec)\.[^/]+$|_test\.[^/]+$|(^|\/)test_[^/]+$/i

/**
 * 这条命令 Agent 在这个对话里跑过没有：面板只重跑跑过的（CLI 的权限那一关已经过了，
 * 面板不替它执行一条用户没机会拦的新命令）
 */
export function ranInConversation(command: string, messages: Pick<TaskMessage, 'tools'>[]): boolean {
  const want = norm(command)
  if (!want) return false
  return messages.some((m) =>
    (m.tools ?? []).some((x) => x.kind === 'run' && [x.label, x.input].some((s) => !!s && norm(s).includes(want))),
  )
}

/** 这一版要复核哪几条命令（去重、去空） */
export const recheckCommands = (d: Pick<Diagnosis, 'result'>) => [
  ...new Set((d.result?.commands ?? []).map((c) => c.trim()).filter(Boolean)),
]

/** 这一版交上来后要不要跑：修复、验证这一版，还在等用户，写了命令，还没跑过 */
export const needsRecheck = (d: Diagnosis) =>
  (phaseOf(d) === 'fix' || phaseOf(d) === 'verify') &&
  d.status === 'pending' &&
  !d.recheck &&
  recheckCommands(d).length > 0

/** 一次运行算失败：退出码不是 0（超时、没跑起来不算失败也不算通过，见 runOk） */
const failed = (r?: RecheckRun) => !!r && !r.error && !r.timedOut && r.code !== null && r.code !== 0
const passed = (r?: RecheckRun) => !!r && !r.error && !r.timedOut && r.code === 0

/**
 * 复核结论：pass 每条都是改前失败、改后通过；fail 有一条改后没通过或改前就通过了（测试拦不住这个 Bug）；
 * partial 跑了但有的跑不了（超时、取不到改前的代码、没在对话里跑过）；running 在跑；none 没有可复核的
 */
export type RecheckVerdict = 'pass' | 'fail' | 'partial' | 'running' | 'none'

export function recheckVerdict(r: Recheck | undefined): RecheckVerdict {
  if (!r) return 'none'
  if (r.state === 'running') return 'running'
  if (r.state === 'skipped' || !r.items.length) return 'none'
  const ran = r.items.filter((x) => !x.skip)
  if (ran.some((x) => failed(x.after) || passed(x.before))) return 'fail'
  if (ran.length === r.items.length && ran.every((x) => failed(x.before) && passed(x.after))) return 'pass'
  return ran.some((x) => x.after && !x.after.error) ? 'partial' : 'none'
}

/** 决策卡上的胶囊 */
export function recheckTag(d: Diagnosis): { text: string; tone: 'success' | 'danger' | 'warning' | 'accent' } | null {
  const phase = phaseOf(d)
  if (phase !== 'fix' && phase !== 'verify') return null
  const v = recheckVerdict(d.recheck)
  if (v === 'pass') return { text: t('面板复核通过'), tone: 'success' }
  if (v === 'fail') return { text: t('面板复核没通过'), tone: 'danger' }
  if (v === 'running') return { text: t('面板复核中'), tone: 'accent' }
  if (v === 'partial') return { text: t('面板只复核了一部分'), tone: 'warning' }
  return null
}

const secs = (ms: number) => (ms < 1000 ? `${ms}ms` : `${(ms / 1000).toFixed(1)}s`)

/** 一次运行在表里怎么写 */
function runCell(r: RecheckRun | undefined, want: 'fail' | 'pass'): string {
  if (!r) return t('面板没有复核')
  if (r.error) return `${t('面板没有复核')}：${r.error}`
  if (r.timedOut) return t('{s} 还没跑完，面板停了它', { s: secs(r.ms) })
  const ok = want === 'fail' ? failed(r) : passed(r)
  const code = r.code === null ? t('没有退出码') : t('退出码 {n}', { n: r.code })
  const what = r.code === 0 ? t('通过') : t('失败')
  return `${ok ? '✓' : '✗'} ${what}（${code}，${secs(r.ms)}）`
}

/** 输出放进代码块：里面有 ``` 时围栏加长，不让它把代码块提前截断 */
function outBlock(title: string, r: RecheckRun | undefined): string {
  if (!r || (!r.out.trim() && !r.error)) return ''
  const body = r.out.trim() || r.error
  const fence = '`'.repeat(Math.max(3, ...[...body.matchAll(/`{3,}/g)].map((m) => m[0].length + 1)))
  return `**${title}**\n\n${fence}text\n${body}\n${fence}`
}

/** 修复、验证页上的「面板复核回归测试」一节（Markdown） */
export function recheckMd(d: Diagnosis): string {
  const phase = phaseOf(d)
  if (phase !== 'fix' && phase !== 'verify') return ''
  const r = d.recheck
  const cmds = recheckCommands(d)
  if (!r) {
    if (!cmds.length)
      return sec(
        t('面板复核回归测试'),
        t('面板没有复核：档案里没写能直接跑的回归测试命令（result.commands），上面的测试结果是它自己说的。'),
      )
    return sec(
      t('面板复核回归测试'),
      d.status === 'pending'
        ? t('这一轮结束后面板会跑：{cmds}', { cmds: cmds.map((c) => `\`${c}\``).join('、') })
        : t('面板没有复核：这一版交上来时没有跑。'),
    )
  }
  if (r.state === 'running')
    return sec(
      t('面板复核回归测试'),
      t('面板正在改前和现在的代码上各跑一次：{cmds}', { cmds: r.items.map((x) => `\`${x.command}\``).join('、') }),
    )
  if (r.state === 'skipped') return sec(t('面板复核回归测试'), alert('warning', `${t('面板没有复核')}：${r.why}`))
  const v = recheckVerdict(r)
  const head =
    v === 'pass'
      ? t('面板自己跑过：每条都是改前失败、改后通过。')
      : v === 'fail'
        ? alert('caution', t('面板跑出来和「改前失败、改后通过」对不上，看下面的输出。'))
        : alert('warning', t('有的命令面板没能复核，下面照实写了原因。'))
  const rows = r.items.map((x) => [
    `\`${x.command}\``,
    x.skip ? `${t('面板没有复核')}：${x.skip}` : runCell(x.before, 'fail'),
    x.skip ? '—' : runCell(x.after, 'pass'),
  ])
  const outs = r.items
    .filter((x) => !x.skip)
    .flatMap((x, i) => [
      r.items.length > 1 ? `### ${t('第 {n} 条', { n: i + 1 })}` : '',
      outBlock(t('改前的输出'), x.before),
      outBlock(t('改后的输出'), x.after),
    ])
    .filter(Boolean)
  return sec(
    t('面板复核回归测试'),
    [
      head,
      table([t('命令'), t('改前（应当失败）'), t('改后（应当通过）')], rows),
      t('改前是对话开始时的代码加上现在的测试文件，改后是现在的代码；只看退出码。'),
      ...outs,
    ]
      .filter(Boolean)
      .join('\n\n'),
  )
}

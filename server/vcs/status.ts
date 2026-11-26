/**
 * 版本管理状态一览（vcs_status 工具，版本管理服务 ADR 0073）：一次说清「这个对话改过 / 打开着的文件，
 * 和库里最新比落没落后、谁还打开着、是不是二进制、加减多少行」。
 *
 * 起因（2026-11-26 复盘 §5-5）：收尾节点花了约 6 分钟手工 p4 opened / fstat / diff 一个个排查，
 * 才弄清哪些文件落后、哪些别人也开着。签出钩子（./p4-plan.ts）只在改的那一刻看一次，交之前没有地方整体看。
 * Git 走 server/exec/git.ts，P4 走 p4Runner（都经 server/vcs/run.ts 限流、计数）；别的版本管理只回改动清单。
 */
import path from 'node:path'
import { gitRun } from '../exec/git.ts'
import { p4Runner, parseZtag, type P4Run } from '../p4-split.ts'
import { p4DiffStat } from './change-stat.ts'
import { detectVcs } from './detect.ts'

/** 没法合并的文件类型（p4 的 headType）：和 p4-plan.ts 同一条规则 */
const UNMERGEABLE = /binary|apple|resource/i

export interface VcsFileRow {
  /** 相对工作目录的路径（不在工作目录下的保留原样） */
  file: string
  add?: number
  del?: number
  /** P4：打开的动作（edit / add / delete…）；Git：untracked */
  action?: string
  /** 库里比本地新：P4 是 have < head，Git 是上游（按上次 fetch）改过这个文件 */
  behind?: boolean
  have?: number
  head?: number
  /** 别的 client 也打开着（P4 的 otherOpen：user@client） */
  others?: string[]
  binary?: boolean
}

export interface VcsStatusReport {
  vcs: 'git' | 'p4' | 'none'
  rows: VcsFileRow[]
  /** 补充说明：Git 上游按上次 fetch 算、P4 连不上等 */
  note?: string
}

export interface VcsStatusInput {
  /** 工作目录（对话的目录） */
  root: string
  /** 这个对话记下的改动（task.changes，路径相对 root） */
  changes: { path: string; add?: number; del?: number }[]
  /** Agent 点名只看这些文件；不给时看 changes，P4 再加上这个目录下打开着的 */
  files?: string[]
  /** 测试替换 */
  p4?: P4Run
}

const rel = (root: string, f: string) => {
  const r = path.relative(root, path.resolve(root, f))
  return (r && !r.startsWith('..') ? r : f).replace(/\\/g, '/')
}

export async function vcsStatus(i: VcsStatusInput): Promise<VcsStatusReport> {
  const vcs = (await detectVcs(i.root).catch(() => undefined))?.vcs
  const want = i.files?.length ? i.files.map((f) => rel(i.root, f)) : i.changes.map((c) => rel(i.root, c.path))
  if (vcs === 'p4') return p4Status(i, want)
  if (vcs === 'git') return gitStatus(i, want)
  const rows = i.changes
    .filter((c) => want.includes(rel(i.root, c.path)))
    .map((c) => ({ file: rel(i.root, c.path), add: c.add, del: c.del }))
  return { vcs: 'none', rows, note: '这个目录不是 Git / P4 工作区：只列出面板记下的改动。' }
}

async function p4Status(i: VcsStatusInput, want: string[]): Promise<VcsStatusReport> {
  const run = i.p4 ?? p4Runner(i.root)
  const fields = 'clientFile,action,headType,headRev,haveRev,otherOpen,otherOpen0,otherOpen1,otherOpen2'
  const dir = `${i.root.replace(/[\\/]+$/, '')}/...`
  const abs = want.map((f) => path.resolve(i.root, f))
  // 点名的文件问一次；没点名时再问这个目录下打开着的（-Ro）：对话自己签出却还没改的也要列出来
  const [named, opened, lines] = await Promise.all([
    abs.length ? run(['-ztag', 'fstat', '-T', fields, ...abs]) : undefined,
    i.files?.length ? undefined : run(['-ztag', 'fstat', '-Ro', '-T', fields, dir]),
    p4DiffStat(i.root, run).catch(() => null),
  ])
  const recs = [...parseZtag(named?.out ?? ''), ...parseZtag(opened?.out ?? '')].filter((r) => r.clientFile)
  if (!recs.length && (named?.err || opened?.err) && !want.length)
    return { vcs: 'p4', rows: [], note: `问 P4 失败：${(named?.err || opened?.err || '').split('\n')[0]}` }
  const byFile = new Map<string, VcsFileRow>()
  for (const r of recs) {
    const file = rel(i.root, r.clientFile)
    const have = Number(r.haveRev || 0)
    const head = Number(r.headRev || 0)
    const others = [r.otherOpen0, r.otherOpen1, r.otherOpen2].filter(Boolean)
    const more = Number(r.otherOpen || 0) - others.length
    byFile.set(file, {
      file,
      ...(r.action && { action: r.action }),
      ...(head > 0 && have < head && { behind: true, have, head }),
      ...(Number(r.otherOpen || 0) > 0 && { others: more > 0 ? [...others, `等 ${Number(r.otherOpen)} 人`] : others }),
      ...(UNMERGEABLE.test(r.headType ?? '') && { binary: true }),
    })
  }
  // 点名了但 P4 不认识的（还没 add 的新文件、不在视图里的）：照样列一行，不悄悄丢掉
  for (const f of want) if (!byFile.has(f)) byFile.set(f, { file: f, action: 'not in depot' })
  const stat = new Map([...(lines ?? new Map())].map(([f, v]) => [rel(i.root, f), v]))
  const fromTask = new Map(i.changes.map((c) => [rel(i.root, c.path), c]))
  for (const row of byFile.values()) {
    const s = stat.get(row.file) ?? fromTask.get(row.file)
    if (s && (s.add || s.del)) Object.assign(row, { add: s.add ?? 0, del: s.del ?? 0 })
  }
  return { vcs: 'p4', rows: [...byFile.values()] }
}

async function gitStatus(i: VcsStatusInput, want: string[]): Promise<VcsStatusReport> {
  if (!want.length) return { vcs: 'git', rows: [], note: '这个对话还没有记下改动；要看别的文件就用 files 点名。' }
  const [num, untracked, up] = await Promise.all([
    gitRun(i.root, ['diff', '--numstat', 'HEAD', '--', ...want]),
    gitRun(i.root, ['ls-files', '--others', '--exclude-standard', '--', ...want]),
    gitRun(i.root, ['rev-parse', '--abbrev-ref', '@{u}']),
  ])
  // 上游改过的文件：只按本地已有的远端引用算，不 fetch（联网慢、也可能要凭据），所以在 note 里写明
  const upstream = up.code === 0 ? up.stdout.trim() : ''
  const behindSet = new Set<string>()
  if (upstream) {
    const d = await gitRun(i.root, ['diff', '--name-only', `HEAD...${upstream}`, '--', ...want])
    for (const l of d.stdout.split('\n').filter(Boolean)) behindSet.add(l.trim())
  }
  const numRows = new Map<string, { add: number; del: number; binary: boolean }>()
  for (const line of num.stdout.split('\n')) {
    const m = /^(\d+|-)\t(\d+|-)\t(.+)$/.exec(line)
    if (m) numRows.set(m[3], { add: Number(m[1]) || 0, del: Number(m[2]) || 0, binary: m[1] === '-' })
  }
  const newFiles = new Set(untracked.stdout.split('\n').filter(Boolean))
  const fromTask = new Map(i.changes.map((c) => [rel(i.root, c.path), c]))
  const rows = want.map((file): VcsFileRow => {
    const n = numRows.get(file)
    const t = fromTask.get(file)
    return {
      file,
      ...(newFiles.has(file) ? { action: 'untracked', add: t?.add ?? 0, del: 0 } : {}),
      ...(n && { add: n.add, del: n.del, ...(n.binary && { binary: true }) }),
      ...(!n && !newFiles.has(file) && t && { add: t.add ?? 0, del: t.del ?? 0, action: 'committed' }),
      ...(behindSet.has(file) && { behind: true }),
    }
  })
  return {
    vcs: 'git',
    rows,
    note: upstream ? `「落后」按上次 fetch 到的 ${upstream} 算（面板不替你 fetch）。` : '当前分支没有上游，不比远端。',
  }
}

/** 交给 Agent 的文字：要先问用户的排最前，其余按改动量；默认最多 60 行，返回不超过约 4000 字 */
export function formatVcsStatus(r: VcsStatusReport, limit = 60): string {
  if (!r.rows.length) return [`${label(r.vcs)}：没有要看的文件。`, r.note].filter(Boolean).join('\n')
  const risky = (x: VcsFileRow) => !!x.binary && (!!x.behind || !!x.others?.length)
  const size = (x: VcsFileRow) => (x.add ?? 0) + (x.del ?? 0)
  const rows = [...r.rows].sort((a, b) => Number(risky(b)) - Number(risky(a)) || size(b) - size(a))
  const count = (f: (x: VcsFileRow) => boolean) => rows.filter(f).length
  const head = [
    `${label(r.vcs)} · ${rows.length} 个文件`,
    `落后 ${count((x) => !!x.behind)}`,
    r.vcs === 'p4' ? `别人也开着 ${count((x) => !!x.others?.length)}` : '',
    `二进制 ${count((x) => !!x.binary)}`,
  ]
    .filter(Boolean)
    .join('，')
  const warn = rows.filter(risky)
  const out = [head]
  if (warn.length)
    out.push(
      `【要先问用户】${warn.map((x) => x.file).join('、')}：没法合并的文件落后于库里或别人也开着，提交前请用户决定保留哪边，不要自己覆盖。`,
    )
  let used = out.join('\n').length
  let shown = 0
  for (const x of rows.slice(0, limit)) {
    const line = `- ${x.file}${describeRow(x)}`
    if (used + line.length > 3600) break
    out.push(line)
    used += line.length + 1
    shown++
  }
  if (shown < rows.length) out.push(`还有 ${rows.length - shown} 个没列出：用 files 点名要看的。`)
  if (r.note) out.push(r.note)
  return out.join('\n')
}

/** 单测用：不经 detectVcs 直接测 P4 那一支（测试机上没有真的 P4 工作区） */
export const p4StatusForTest = (i: VcsStatusInput) =>
  p4Status(
    i,
    i.changes.map((c) => rel(i.root, c.path)),
  )

const label = (vcs: VcsStatusReport['vcs']) => (vcs === 'p4' ? 'P4' : vcs === 'git' ? 'Git' : '没有版本管理')

function describeRow(x: VcsFileRow) {
  const parts = [
    x.action ?? '',
    x.add !== undefined || x.del !== undefined ? `+${x.add ?? 0} −${x.del ?? 0}` : '',
    x.behind ? (x.head ? `落后：本地 #${x.have} / 库里 #${x.head}` : '落后于上游') : '',
    x.others?.length ? `别人也开着：${x.others.join('、')}` : '',
    x.binary ? '二进制' : '',
  ].filter(Boolean)
  return parts.length ? `  ${parts.join(' · ')}` : ''
}

/** 给引擎宿主的 vcs_status：每次调用现读这个对话记下的改动（一轮里还会变），现问 Git / P4 */
export function vcsStatusFor(task: { changes: VcsStatusInput['changes'] }, root: string) {
  return {
    call: async (req: { files?: string[] }) =>
      formatVcsStatus(await vcsStatus({ root, changes: task.changes, ...(req.files?.length && { files: req.files }) })),
  }
}

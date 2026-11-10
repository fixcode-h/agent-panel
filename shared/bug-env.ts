/**
 * 诊断报告的「环境（面板自动采集）」（分析稿 B4）：现象卡里的环境和版本以前靠 Agent 填，经常是「未知」。
 * 面板知道的自己附上：操作系统、Node、CLI 和模型、分支、最近十次提交、没提交的改动、依赖锁文件最近一次改动。
 * 这里只放纯函数（解析 git 的输出、渲染成 Markdown）；跑命令在 server/exec/bug-env.ts
 */
import type { BugEnv } from './bug-diagnosis-schema.ts'
import { table } from './bug-md.ts'
import { t } from './i18n.ts'

/** 最近几次提交 */
export const ENV_COMMITS = 10
/** 未提交改动最多列这么多个文件，多出来的只记个数 */
export const ENV_DIRTY_MAX = 30

/** 认得的依赖锁文件（项目根下，按这个顺序取第一个存在的） */
export const LOCK_FILES = [
  'package-lock.json',
  'pnpm-lock.yaml',
  'yarn.lock',
  'bun.lock',
  'bun.lockb',
  'Cargo.lock',
  'go.sum',
  'poetry.lock',
  'uv.lock',
  'Pipfile.lock',
  'Gemfile.lock',
  'composer.lock',
  'packages.lock.json',
]

/** git log 的格式：短哈希、标题、作者、日期之间用 NUL 隔开（标题里什么字符都可能有） */
export const COMMIT_FORMAT = '%h%x00%s%x00%an%x00%ad'

/** `git log --format=<COMMIT_FORMAT> --date=short` 的输出 → 提交列表 */
export function parseCommits(out: string): BugEnv['commits'] {
  return out
    .split('\n')
    .map((l) => l.replace(/\r$/, ''))
    .filter((l) => l.includes('\0'))
    .slice(0, ENV_COMMITS)
    .map((l) => {
      const [hash = '', title = '', author = '', date = ''] = l.split('\0')
      return { hash: hash.trim(), title: title.slice(0, 300), author: author.slice(0, 200), date: date.trim() }
    })
    .filter((c) => c.hash)
}

/**
 * `git status --porcelain` 的输出 → 未提交改动的文件。改名的取新名字；带空格的路径 git 会加引号，去掉。
 * 超过上限的只记个数（more）
 */
export function parseDirty(out: string): { files: string[]; more: number } {
  const all = out
    .split('\n')
    .map((l) => l.replace(/\r$/, ''))
    .filter((l) => l.length > 3)
    .map((l) => {
      const rest = l.slice(3)
      const to = rest.includes(' -> ') ? rest.slice(rest.lastIndexOf(' -> ') + 4) : rest
      return to.replace(/^"(.*)"$/, '$1').slice(0, 500)
    })
    .filter(Boolean)
  const files = [...new Set(all)]
  return { files: files.slice(0, ENV_DIRTY_MAX), more: Math.max(0, files.length - ENV_DIRTY_MAX) }
}

/** 一样都没取到（旧报告、演示里没有宿主）：不出这一节 */
export const envEmpty = (e: BugEnv | undefined) =>
  !e || !(e.os || e.node || e.cli || e.model || e.branch || e.commits.length || e.dirty.length || e.lock)

/** 这一版要显示的环境：自己带的，否则是这个 Bug 第一次采集到的那份（旧数据只有第一份报告上有） */
export const envOf = (d: { env?: BugEnv }, list?: { env?: BugEnv }[]) => d.env ?? list?.find((x) => x.env)?.env

/**
 * 「环境（面板自动采集）」一节的 Markdown。author：写不写提交人（设置里「引入点写作者」的开关，和引入点同一个）。
 * 取不到的项直接省略，不写「未知」
 */
export function envMd(e: BugEnv | undefined, opts: { author?: boolean } = {}): string {
  if (!e || envEmpty(e)) return ''
  const code = (s: string) => `\`${s.replace(/`/g, "'")}\``
  const rows: string[][] = []
  if (e.os) rows.push([t('操作系统'), e.os])
  if (e.node) rows.push(['Node.js', e.node])
  if (e.cli || e.model) rows.push([t('CLI 和模型'), [e.cli, e.model && code(e.model)].filter(Boolean).join(' · ')])
  if (e.branch) rows.push([t('分支'), code(e.branch)])
  if (e.lock?.hash)
    rows.push([
      t('依赖锁文件'),
      t('{file} 最近一次改动：{hash}《{title}》{date}', {
        file: code(e.lock.file),
        hash: code(e.lock.hash),
        title: e.lock.title,
        date: e.lock.date ? `（${e.lock.date}）` : '',
      }),
    ])
  const withAuthor = opts.author !== false
  const commits = table(
    withAuthor ? [t('提交号'), t('标题'), t('作者'), t('日期')] : [t('提交号'), t('标题'), t('日期')],
    e.commits.map((c) => (withAuthor ? [code(c.hash), c.title, c.author, c.date] : [code(c.hash), c.title, c.date])),
  )
  const dirty = e.dirty.length
    ? [...e.dirty.map((f) => `- ${code(f)}`), e.dirtyMore ? `- ${t('…还有 {n} 个文件', { n: e.dirtyMore })}` : '']
        .filter(Boolean)
        .join('\n')
    : ''
  return [
    table([t('项'), t('值')], rows),
    commits && `**${t('最近 {n} 次提交', { n: e.commits.length })}**\n\n${commits}`,
    dirty && `**${t('交报告时没提交的改动（{n} 个文件）', { n: e.dirty.length + e.dirtyMore })}**\n\n${dirty}`,
    t('取自你的项目目录（不是它的独立分支），交第一份报告时采集。'),
  ]
    .filter(Boolean)
    .join('\n\n')
}

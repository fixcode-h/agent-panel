#!/usr/bin/env node
/**
 * 生成 GitHub Release 的说明：从上一个同类版本以来的提交说明里整理出「新功能 / 改进与调整 / Bug 修复 / 依赖升级」，
 * 依赖升级从 package.json 的差异自动得出，最后附上下载说明。
 *
 * 提交说明的写法（见 AGENTS.md）：标题或正文里以「新功能：」「改进：」「修复：」「依赖：」开头的行各成一条，
 * 「标题 — 说明」会把标题加粗；一个提交里没有这些前缀时，用它的标题作为一条「改进与调整」。
 *
 * 用法：node scripts/release-notes.mjs <版本号> <main|dev> [上一个标签]
 */
import { execFileSync } from 'node:child_process'

const [version, channel = 'main', prevArg] = process.argv.slice(2)
if (!version) throw new Error('用法：node scripts/release-notes.mjs <版本号> <main|dev> [上一个标签]')
const git = (...args) => execFileSync('git', args, { encoding: 'utf8' }).trim()

/** 上一个同类版本：正式版找不带 -dev 的标签，预览版找带 -dev 的标签；只看当前提交的祖先 */
function previousTag() {
  if (prevArg) return prevArg
  const tags = git('tag', '--merged', 'HEAD', '--sort=-creatordate', '--list', 'v*').split('\n').filter(Boolean)
  return tags.find((t) => (channel === 'dev' ? t.endsWith('-dev') : !t.includes('-'))) ?? ''
}

const prev = previousTag()
const range = prev ? [`${prev}..HEAD`] : ['HEAD', '-n', '30']
const SEP = '\u001e'
const commits = git('log', '--no-merges', `--format=%B${SEP}`, ...range)
  .split(SEP)
  .map((c) => c.trim())
  .filter(Boolean)

const sections = { 新功能: [], 改进与调整: [], 'Bug 修复': [], 依赖升级: [] }
const KINDS = { 新功能: '新功能', 改进: '改进与调整', 调整: '改进与调整', 修复: 'Bug 修复', 依赖: '依赖升级' }
const IGNORE = /^(Co-Authored-By|Claude-Session|Signed-off-by):/i

/** 「标题 — 说明」把标题加粗 */
const item = (text) => {
  const m = text.match(/^(.+?)\s+[—–-]{1,2}\s+(.+)$/)
  return m ? `**${m[1].trim()}** — ${m[2].trim()}` : text
}

for (const c of commits) {
  const lines = c.split('\n').map((l) => l.replace(/^\s*[-*]\s*/, '').trim())
  let found = false
  for (const l of lines) {
    const m = l.match(/^(新功能|改进|调整|修复|依赖)\s*[:：]\s*(.+)$/)
    if (!m) continue
    sections[KINDS[m[1]]].push(item(m[2]))
    found = true
  }
  if (!found && lines[0] && !IGNORE.test(lines[0])) sections['改进与调整'].push(item(lines[0]))
}

// 依赖升级：对比 package.json
if (prev) {
  try {
    const before = JSON.parse(git('show', `${prev}:package.json`))
    const after = JSON.parse(git('show', 'HEAD:package.json'))
    for (const key of ['dependencies', 'devDependencies']) {
      const a = before[key] ?? {}
      const b = after[key] ?? {}
      for (const [n, v] of Object.entries(b)) {
        if (!(n in a)) sections['依赖升级'].push(`新增 \`${n}\` ${v}`)
        else if (a[n] !== v) sections['依赖升级'].push(`\`${n}\` ${a[n]} → ${v}`)
      }
      for (const n of Object.keys(a)) if (!(n in b)) sections['依赖升级'].push(`移除 \`${n}\``)
    }
  } catch {
    // 上一个版本没有 package.json 时跳过
  }
}

const dedupe = (list) => [...new Set(list)]
const out = [`## Agent 面板 v${version} ${channel === 'dev' ? '预览版' : '更新'}`, '']
if (channel === 'dev') out.push('> dev 分支的开发中版本，功能可能还不稳定。正式版在合并到主干后发布。', '')
for (const [title, list] of Object.entries(sections)) {
  if (!list.length) continue
  out.push(`### ${title}`, '', ...dedupe(list).map((l) => `- ${l}`), '')
}
if (Object.values(sections).every((l) => !l.length)) out.push('没有功能变化。', '')
const name = `agent-panel-${version}`
out.push(
  '### 下载',
  '',
  `- Windows — \`${name}.zip\`，解压后双击 \`AgentPanel.exe\`（不弹命令行窗口，图标在任务栏通知区，右键可以退出）`,
  `- macOS / Linux — \`${name}.tar.gz\`，解压后运行 \`./start.sh\``,
  '',
  '需要 Node.js 20+，以及至少一个已登录的 CLI（Claude Code、Codex 或 Command Code）。启动后会自动用浏览器打开 http://127.0.0.1:8787 。',
  '升级时把旧版本目录里的 `data/` 复制到新版本目录即可保留配置和任务。',
  '',
)
if (prev)
  out.push(
    `完整改动：[${prev}...v${version}](https://github.com/${process.env.GITHUB_REPOSITORY ?? 'fixcode-h/agent-panel'}/compare/${prev}...v${version})`,
    '',
  )
process.stdout.write(out.join('\n'))

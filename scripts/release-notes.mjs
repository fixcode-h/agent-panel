#!/usr/bin/env node
/**
 * 生成 GitHub Release 的说明：从上一个同类版本以来的提交说明里整理出「新功能 / 改进与调整 / Bug 修复 / 依赖升级」，
 * 依赖升级从 package.json 的差异自动得出，最后附上下载说明。
 *
 * 提交说明的写法（见 AGENTS.md）：标题或正文里以「新功能：」「改进：」「修复：」「依赖：」开头的行各成一条，
 * 「标题 — 说明」会把标题加粗；一个提交里没有这些前缀时，用它的标题作为一条「改进与调整」；「内部：」开头的行和标题不进说明。
 * 「界面：」（界面细节的调整，历史提交里常见）和「调整：」一样归到「改进与调整」，前缀去掉。
 *
 * 用法：node scripts/release-notes.mjs <版本号> <main|dev> [上一个标签] [--allow-no-tag]
 * 正式版（main）找不到上一个正式版标签时直接失败：以前悄悄改取最近 30 个提交，发出去的说明漏掉或多出一截还看不出来
 * （多半是 checkout 没带标签）。本地试跑、还没有任何标签的仓库加 --allow-no-tag，退回最近 30 个提交并在 stderr 提示。
 */
import { execFileSync } from 'node:child_process'
import path from 'node:path'
import { fileURLToPath } from 'node:url'

const KINDS = {
  新功能: '新功能',
  改进: '改进与调整',
  调整: '改进与调整',
  界面: '改进与调整',
  修复: 'Bug 修复',
  依赖: '依赖升级',
}
const PREFIX = new RegExp(`^(${Object.keys(KINDS).join('|')})\\s*[:：]\\s*(.+)$`)
const IGNORE = /^(Co-Authored-By|Claude-Session|Signed-off-by):/i
/** 没有上一个标签时退回的提交数（只在 --allow-no-tag 或预览版时用） */
export const FALLBACK_COMMITS = 30

/** 「标题 — 说明」把标题加粗 */
const item = (text) => {
  const m = text.match(/^(.+?)\s+[—–-]{1,2}\s+(.+)$/)
  return m ? `**${m[1].trim()}** — ${m[2].trim()}` : text
}

/** 上一个同类版本：正式版找不带 -dev 的标签，预览版找带 -dev 的标签；tags 是 HEAD 的祖先、按创建时间从新到旧 */
export function pickPreviousTag(tags, channel) {
  return tags.find((t) => (channel === 'dev' ? t.endsWith('-dev') : !t.includes('-'))) ?? ''
}

/**
 * 取哪些提交（git log 的参数）。正式版没有上一个标签时直接失败，除非显式允许；
 * 返回的 warning 交给调用方打到 stderr（不混进说明正文）
 */
export function commitRange({ prev, channel, allowNoTag = false }) {
  if (prev) return { range: [`${prev}..HEAD`], warning: '' }
  if (channel !== 'dev' && !allowNoTag)
    throw new Error(
      '找不到上一个正式版标签（v<主>.<次>.<提交数>，不带后缀）：更新说明没法确定从哪个提交开始。' +
        '出包时检查 checkout 有没有带上标签（fetch-depth: 0）；本地试跑加 --allow-no-tag，或者第三个参数直接给标签',
    )
  return {
    range: ['HEAD', '-n', String(FALLBACK_COMMITS)],
    warning: `没有找到上一个${channel === 'dev' ? '预览版' : '正式版'}标签，只取最近 ${FALLBACK_COMMITS} 个提交`,
  }
}

/** 按前缀把提交说明分到各节；commits 是每个提交的完整说明（标题 + 正文） */
export function classify(commits) {
  const sections = { 新功能: [], 改进与调整: [], 'Bug 修复': [], 依赖升级: [] }
  for (const c of commits) {
    const lines = c.split('\n').map((l) => l.replace(/^\s*[-*]\s*/, '').trim())
    let found = false
    for (const l of lines) {
      // 「内部：」是开发文档、测试这类用户感受不到的改动，不进更新说明
      if (/^内部\s*[:：]/.test(l)) {
        found = true
        continue
      }
      const m = l.match(PREFIX)
      if (!m) continue
      sections[KINDS[m[1]]].push(item(m[2]))
      found = true
    }
    if (!found && lines[0] && !IGNORE.test(lines[0])) sections['改进与调整'].push(item(lines[0]))
  }
  return sections
}

const isMain = process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)
if (isMain) main()

function main() {
  const args = process.argv.slice(2)
  const [version, channel = 'main', prevArg] = args.filter((a) => !a.startsWith('--'))
  if (!version)
    throw new Error('用法：node scripts/release-notes.mjs <版本号> <main|dev> [上一个标签] [--allow-no-tag]')
  const git = (...a) => execFileSync('git', a, { encoding: 'utf8' }).trim()

  const prev =
    prevArg ||
    pickPreviousTag(
      git('tag', '--merged', 'HEAD', '--sort=-creatordate', '--list', 'v*').split('\n').filter(Boolean),
      channel,
    )
  const { range, warning } = commitRange({ prev, channel, allowNoTag: args.includes('--allow-no-tag') })
  if (warning) process.stderr.write(`release-notes：${warning}\n`)
  const SEP = '\u001e'
  const commits = git('log', '--no-merges', `--format=%B${SEP}`, ...range)
    .split(SEP)
    .map((c) => c.trim())
    .filter(Boolean)

  const sections = classify(commits)

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
    `- macOS — \`${name}-mac.tar.gz\`（或 \`${name}-mac.zip\`），解压后双击 \`Agent 面板.app\`；也可以运行 \`./start.sh\``,
    `- Linux — \`${name}-linux.tar.gz\`，解压后运行 \`./start.sh\``,
    '',
    'macOS / Linux 运行一次 `./install-service.sh` 可以开机自动在后台运行；macOS 的 .app 没有代码签名，第一次打开要右键 →「打开」。',
    '需要 Node.js 22+，以及至少一个已登录的 CLI（Claude Code、Codex 或 Command Code）。启动后会自动用浏览器打开 http://127.0.0.1:8787 。',
    'Windows 第一次运行时如果提示「Windows 已保护你的电脑」：托盘程序没有代码签名，点「更多信息」→「仍要运行」即可。',
    '已经装过的可以在面板的「设置 · 版本更新」里直接更新，数据保存在用户目录的 `.agent-panel` 下，不会丢；包的 SHA256 在 `SHA256SUMS` 里。',
    '',
  )
  if (prev)
    out.push(
      `完整改动：[${prev}...v${version}](https://github.com/${process.env.GITHUB_REPOSITORY ?? 'fixcode-h/agent-panel'}/compare/${prev}...v${version})`,
      '',
    )
  process.stdout.write(out.join('\n'))
}

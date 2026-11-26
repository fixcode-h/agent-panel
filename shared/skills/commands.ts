/**
 * 命令类别（设计稿《技能由面板推送》3.2、7.2 的第一版）：技能条件里写 `command: vcs`、`failed: test` 时，
 * 按命令里的程序名（和必要时的子命令）认出它是哪一类。只看命令原文，不看回复文字（ADR 0041、0049）。
 *
 * 一条命令拆成几段（&&、||、;、| 分开，shared/hooks/defs.ts 的 commandSegments），任意一段对上就算。
 * 拿不准的不认：宁可漏推一个技能，也不在不相干的命令上乱推。新加一类只加一行
 */
import { commandSegments } from '../hooks/defs.ts'

interface CommandCategory {
  /** 第一个词就是这些程序的 */
  programs: string[]
  /** 第一个词是这个程序、后面对得上正则的（npm test、cargo build 这类） */
  subs?: Record<string, RegExp>
}

/** 内置的几类：类别名就是条件里写的值 */
export const COMMAND_CATEGORIES: Record<string, CommandCategory> = {
  vcs: { programs: ['git', 'p4', 'svn', 'hg'] },
  // 会改版本库或工作区的版本管理命令：project-vcs 只在这时推。开工先跑的 git status / log / diff 不算，
  // 不然每个对话第一条命令就把整份 project-vcs 推进去（2026-11-26 Flash 实测：6 个对话全在 git status 上推了）
  'vcs-write': {
    programs: [],
    subs: {
      git: /^(commit|push|merge|rebase|reset|checkout|switch|stash|cherry-pick|revert|tag|am|apply|restore|rm|mv|clean|pull|worktree)\b/,
      p4: /^(edit|add|delete|submit|revert|shelve|unshelve|integrate|resolve|move|reopen|sync|change)\b/,
      svn: /^(commit|ci|update|up|revert|switch|merge|add|delete|rm|move|mv)\b/,
      hg: /^(commit|ci|push|pull|merge|update|up|rebase|revert|strip|shelve)\b/,
    },
  },
  test: {
    programs: ['jest', 'vitest', 'mocha', 'pytest', 'ctest', 'phpunit', 'rspec', 'busted', 'playwright'],
    subs: {
      npm: /^(test|t)\b|^run\s+test/,
      pnpm: /^(test|t)\b|^run\s+test/,
      yarn: /^(run\s+)?test/,
      npx: /^(vitest|jest|mocha|playwright)\b/,
      node: /(^|\s)--test\b/,
      cargo: /^test\b/,
      go: /^test\b/,
      dotnet: /^test\b/,
      mvn: /(^|\s)test\b/,
      gradle: /(^|\s)test\b/,
      python: /^-m\s+(pytest|unittest)\b/,
      python3: /^-m\s+(pytest|unittest)\b/,
    },
  },
  build: {
    programs: ['make', 'cmake', 'msbuild', 'ninja', 'tsc', 'unrealbuildtool', 'build', 'runuat', 'ubt'],
    subs: {
      npm: /^run\s+build/,
      pnpm: /^(run\s+)?build/,
      yarn: /^(run\s+)?build/,
      cargo: /^build\b/,
      go: /^build\b/,
      dotnet: /^build\b/,
      gradle: /(^|\s)(build|assemble)\b/,
      mvn: /(^|\s)(package|compile|install)\b/,
    },
  },
  search: { programs: ['rg', 'grep', 'egrep', 'fgrep', 'find', 'fd', 'ag', 'ack', 'findstr', 'select-string'] },
}

/** 一个词的程序名：去掉引号、路径和 .exe 这类后缀，小写 */
const prog = (word: string) =>
  word
    .replace(/^["']|["']$/g, '')
    .replaceAll('\\', '/')
    .split('/')
    .pop()!
    .toLowerCase()
    .replace(/\.(exe|cmd|bat|com|sh|ps1)$/, '')

/** 一段命令的程序名和后面的参数原文；前面的 VAR=x 环境变量跳过 */
function head(seg: string): { name: string; rest: string } {
  // 带引号的程序路径（"C:\Program Files\Perforce\p4.exe"）里有空格，先整个当成一个词
  const words = [...seg.trim().matchAll(/"[^"]*"|'[^']*'|\S+/g)].map((m) => m[0])
  let i = 0
  while (i < words.length && /^[A-Za-z_][A-Za-z0-9_]*=/.test(words[i])) i++
  return { name: words[i] ? prog(words[i]) : '', rest: words.slice(i + 1).join(' ') }
}

/** 这条命令属于哪几类（可能一类都不是） */
export function commandCategories(command: string): Set<string> {
  const out = new Set<string>()
  for (const seg of commandSegments(command)) {
    const { name, rest } = head(seg)
    if (!name) continue
    for (const [cat, c] of Object.entries(COMMAND_CATEGORIES)) {
      if (c.programs.includes(name) || c.subs?.[name]?.test(rest)) out.add(cat)
    }
  }
  return out
}

/** 命令里出现的程序名（每段第一个词） */
export const commandPrograms = (command: string) =>
  new Set(
    commandSegments(command)
      .map((s) => head(s).name)
      .filter(Boolean),
  )

/** 条件值对不对得上这条命令：值是「类别或程序名」，多个用 | 分开 */
export function commandMatches(value: string, command: string): boolean {
  if (!command.trim()) return false
  const want = value
    .split('|')
    .map((x) => x.trim().toLowerCase())
    .filter(Boolean)
  if (!want.length) return false
  const cats = commandCategories(command)
  const progs = commandPrograms(command)
  return want.some((w) => cats.has(w) || progs.has(w))
}

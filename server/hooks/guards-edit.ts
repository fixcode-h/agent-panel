import path from 'node:path'
import { statSync } from 'node:fs'
import { tmpdir } from 'node:os'
import type { Task } from '../../shared/schema.ts'
import type { HookFacts } from '../../shared/hooks.ts'
import { globMatch } from '../../shared/hook-defs.ts'
import { runSegments, segHead } from '../../shared/command-scope.ts'

/**
 * 改文件前的两个守卫（借鉴 ECC 的 GateGuard 和 config-protection，设计稿
 * designs/ECC借鉴-配置安全扫描与钩子档位-设计稿.md §3、§4）。和 guards.ts 一样只看工具调用记录和路径，不读回复文字；
 * 都是「拦一次」：同一个对话里同一个文件第二次放行，不会卡死。默认在严格档
 */

/**
 * 检查配置的默认路径（不许改检查配置）：lint、格式化、类型检查、测试框架的配置。
 * 没有 / 的按文件名在任意目录匹配。pyproject.toml 不列：它还放依赖和版本，按文件拦误伤太多
 */
export const CHECK_CONFIG_GLOBS = [
  '.eslintrc*',
  'eslint.config.*',
  '.oxlintrc*',
  'oxlint.json',
  '.prettierrc*',
  'prettier.config.*',
  'biome.json',
  'biome.jsonc',
  'tsconfig*.json',
  '.editorconfig',
  '.clang-format',
  '.clang-tidy',
  '.luacheckrc',
  '.stylelintrc*',
  'jest.config.*',
  'vitest.config.*',
  'playwright.config.*',
  '.golangci.yml',
  '.golangci.yaml',
  'ruff.toml',
  '.ruff.toml',
  'mypy.ini',
  '.flake8',
]

/** 每个对话里拦过一次的文件（守卫 id + 绝对路径）：再来一次就放行。记在内存里，重启清空 */
const warned = new Map<string, Set<string>>() // 模块状态：运行时，「说过一次」的记录，重启后最多再提醒一次
function firstTime(taskId: string, key: string) {
  const seen = warned.get(taskId) ?? new Set<string>()
  if (seen.has(key)) return false
  seen.add(key)
  warned.set(taskId, seen)
  return true
}

const isFile = (p: string) => {
  try {
    return statSync(p).isFile()
  } catch {
    return false
  }
}
const inside = (dir: string, p: string) => {
  const r = path.relative(path.resolve(dir), path.resolve(p))
  return r === '' || (!r.startsWith('..') && !path.isAbsolute(r))
}
/** 临时文件：项目的 .tmp/、系统临时目录（不算改项目；项目本身就在临时目录里时按项目算，同 guards.ts） */
const scratch = (cwd: string, abs: string) =>
  inside(path.join(cwd, '.tmp'), abs) || (inside(tmpdir(), abs) && !inside(cwd, abs))
const slash = (s: string) => s.replace(/\\/g, '/')
const SED_INPLACE = /\bsed\s+(?:-\S+\s+)*-[a-zA-Z]*i/

/**
 * 这次调用要改哪些文件：改文件工具点名的，加上 shell 里 `sed -i` 的目标（命令行改文件最常见的写法；
 * 其余重定向、脚本改的算不出来，不猜）
 */
export function editTargets(facts: HookFacts): string[] {
  const tool = facts.tool
  if (!tool) return []
  if (tool.kind === 'edit') return (tool.paths.length ? tool.paths : [tool.path]).filter(Boolean)
  if (tool.kind !== 'shell') return []
  const out: string[] = []
  for (const seg of runSegments(String(tool.input.command ?? ''))) {
    if (segHead(seg) !== 'sed' || !/\s-[a-zA-Z]*i/.test(seg)) continue
    // sed -i 's/a/b/' 文件…：最后几个不以 - 开头、也不是脚本的参数是文件
    const args = seg
      .trim()
      .split(/\s+/)
      .slice(1)
      .map((a) => a.replace(/^["']|["']$/g, ''))
    const files = args.filter((a) => !a.startsWith('-') && !/^[sy]?\/|^[0-9,$]*[a-z]$/.test(a))
    out.push(...files.slice(-1))
  }
  return out
}

/**
 * 这个对话自最近一次压缩以来，有没有读过、搜到过这个文件：在工具调用记录（对象、参数、输出）里找它的路径。
 * 压缩之后模型手里只剩摘要，之前读过的不算
 */
export function seenInHistory(task: Pick<Task, 'messages'>, cwd: string, file: string): boolean {
  const abs = path.resolve(cwd, file)
  const keys = [slash(path.relative(cwd, abs)), slash(abs)].filter(Boolean)
  const tools = task.messages.flatMap((m) => (m.role === 'agent' ? m.tools : []))
  let from = 0
  tools.forEach((x, i) => {
    if (x.kind === 'compact') from = i + 1
  })
  // 改文件不算看过（这次要拦的那次调用自己也可能已经记进去了）；命令看输出（rg 的结果）和命令行（cat、sed -n），
  // 但 sed -i 那条不算：它正是这次要拦的
  return tools.slice(from).some((x) => {
    const parts =
      x.kind === 'read' || x.kind === 'search'
        ? [x.label, x.detail, x.input ?? '', x.output ?? '']
        : x.kind === 'run'
          ? [x.output ?? '', SED_INPLACE.test(x.input ?? x.label) ? '' : (x.input ?? x.label)]
          : []
    const text = slash(parts.join('\n'))
    return !!text && keys.some((k) => text.includes(k))
  })
}

/** 改之前先看过：要改一个已有的文件，这个对话却没读过、没搜到过它，拦一次让它先看要改的位置 */
export function readBeforeEditDeny(cwd: string, task: Pick<Task, 'id' | 'messages'>, facts: HookFacts): string {
  for (const f of editTargets(facts)) {
    const abs = path.resolve(cwd, f)
    if (scratch(cwd, abs) || !isFile(abs) || seenInHistory(task, cwd, f)) continue
    if (!firstTime(task.id, `read:${abs}`)) continue
    return `【面板】${f} 这个对话里还没读过：先读一下要改的那几段（或用 rg -n 搜到位置再按行读），确认现在的内容再改，别凭印象改。确实不用看就再改一次，面板不再拦。`
  }
  return ''
}

/** 一个文件是不是检查配置：带 / 的通配按相对项目根的路径比，不带的按文件名比 */
export function isCheckConfig(rel: string, globs: string[]): boolean {
  const r = slash(rel).replace(/^\.\//, '')
  const base = r.split('/').pop() ?? r
  return globs.some((g) => !!g.trim() && globMatch(g.trim(), g.includes('/') ? r : base))
}

/**
 * 不许改检查配置：检查不过时去放宽 lint 规则、关掉严格模式、改测试配置跳过文件，事后很难发现。
 * 改这类文件拦一次，让它先说明原因；用户要它改的再改一次就放行（放行的那次面板记进日志和最近触发）
 */
export function checkConfigDeny(cwd: string, taskId: string, extra: string[], facts: HookFacts): string {
  const globs = [...CHECK_CONFIG_GLOBS, ...extra]
  for (const f of editTargets(facts)) {
    const abs = path.resolve(cwd, f)
    const rel = path.relative(cwd, abs)
    if (scratch(cwd, abs) || rel.startsWith('..') || !isCheckConfig(rel, globs)) continue
    if (!firstTime(taskId, `config:${abs}`)) continue
    return `【面板】${slash(rel)} 是检查配置（lint、格式化、类型检查或测试的配置）。不要为了让检查通过去放宽或跳过检查：先改代码。确实要改（用户要求的、或者配置本身错了），先一句话说明原因，再改一次，面板不再拦。`
  }
  return ''
}

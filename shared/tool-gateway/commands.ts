/**
 * 命令类别注册表（设计稿 7.2）：一个类别一行，「程序名 / 参数形状 → 类别」。按顺序问，第一个认的说了算
 * （git grep 先算搜索、再轮到版本管理；dotnet test 先算测试、再轮到编译）。
 *
 * 判断尽量复用已有的那一份：段首程序名和参数（shared/command-scope.ts 的 segHead / segArgs）、几分钟的编译和常驻命令
 * （heavySegment / endlessSegment）、UE 的编译和自动化测试（shared/test-steps.ts）、程序名（shared/custom-tools/match.ts 的 programOf）。
 * 拿不准的一律不归类：不归类就放行，宁可多走一次原命令，也不给出和原命令语义不一样的结果
 */
import { endlessSegment, heavySegment, runSegments, segArgs, segHead } from '../command-scope.ts'
import { programOf } from '../custom-tools/match.ts'
import { isUeAutomationCommand, isUeBuildCommand } from '../test-steps.ts'
import type { CommandCategory, ParsedCommand } from './types.ts'

/** 一段命令拆好的样子：段首程序（小写、去掉路径和后缀）和它后面的参数 */
export interface Seg {
  seg: string
  head: string
  args: string
}

/** npx / bunx / pnpm exec 这类只是转手跑别的程序：认它后面那个 */
const RUNNERS = /^(?:npx|bunx|pnpx)$/
function segOf(raw: string): Seg {
  const seg = raw.trim().replace(/^&\s*/, '')
  let head = segHead(seg).replace(/["']+$/, '')
  let args = segArgs(seg)
  if (RUNNERS.test(head) || (head === 'pnpm' && /^(?:exec|dlx)\s/.test(args))) {
    const rest = head === 'pnpm' ? args.replace(/^\S+\s+/, '') : args
    const inner = rest.replace(/^(?:-\S+\s+)*/, '')
    head = segHead(inner)
    args = segArgs(inner)
  }
  return { seg, head, args }
}

const has = (list: string[]) => (s: Seg) => list.includes(s.head)
const SCRIPT_RUN = /^(?:npm|pnpm|yarn|bun)$/

export interface CommandCategoryDef {
  id: CommandCategory
  match: (s: Seg) => boolean
}

export const COMMAND_CATEGORY_DEFS: CommandCategoryDef[] = [
  {
    id: 'search',
    match: (s) =>
      has(['rg', 'grep', 'egrep', 'fgrep', 'ag', 'ack', 'findstr', 'select-string', 'sls', 'fd'])(s) ||
      (s.head === 'git' && /^grep\b/.test(s.args)) ||
      // find 只认按名字找（-name / -iname）：-type、-newer 这类拿不准是不是在「找」
      (s.head === 'find' && /(?:^|\s)-i?name\s/.test(s.args)) ||
      // Windows：dir /s 递归列、where /r 递归找、Get-ChildItem -Recurse 带过滤
      (s.head === 'dir' && /(?:^|\s)\/s\b/i.test(s.args)) ||
      (s.head === 'where' && /(?:^|\s)\/r\s/i.test(s.args)) ||
      (['get-childitem', 'gci'].includes(s.head) &&
        /-recurse\b/i.test(s.args) &&
        /-(?:filter|include)\b/i.test(s.args)),
  },
  {
    id: 'lint',
    match: (s) =>
      (s.head === 'luac' && /(?:^|\s)-p\b/.test(s.args)) ||
      has(['luacheck', 'selene', 'eslint', 'oxlint', 'stylelint', 'ruff', 'flake8', 'pylint', 'shellcheck'])(s) ||
      (s.head === 'stylua' && /--check\b/.test(s.args)) ||
      (SCRIPT_RUN.test(s.head) && /^(?:run\s+)?lint(?::\S+)?\b/.test(s.args)),
  },
  {
    id: 'test',
    match: (s) =>
      has(['jest', 'vitest', 'pytest', 'mocha', 'ctest'])(s) ||
      programOf(s.seg) === 'pytest' ||
      (SCRIPT_RUN.test(s.head) && /^(?:run\s+)?test(?::\S+)?\b/.test(s.args)) ||
      (['dotnet', 'cargo', 'go'].includes(s.head) && /^test\b/.test(s.args)) ||
      (['mvn', 'mvnw', 'gradle', 'gradlew'].includes(s.head) && /(?:^|\s)test\b/.test(s.args)) ||
      isUeAutomationCommand(s.seg),
  },
  {
    id: 'build',
    match: (s) =>
      // UE 的编译（Build.bat、UBT、RunUAT）；编辑器本身不算编译
      (isUeBuildCommand(s.seg) && !/^(?:unrealeditor|ue4editor)/.test(s.head)) ||
      has(['msbuild', 'devenv', 'ninja', 'make'])(s) ||
      (['dotnet', 'cargo'].includes(s.head) && /^build\b/.test(s.args)) ||
      (s.head === 'cmake' && /^--build\b/.test(s.args)) ||
      (SCRIPT_RUN.test(s.head) && /^(?:run\s+)?build(?::\S+)?\b/.test(s.args)),
  },
  { id: 'vcs', match: has(['git', 'p4', 'svn', 'hg']) },
  {
    id: 'read',
    match: has([
      'cat',
      'type',
      'get-content',
      'gc',
      'head',
      'tail',
      'less',
      'more',
      'ls',
      'dir',
      'tree',
      'get-childitem',
      'gci',
      'stat',
      'wc',
    ]),
  },
  // 几分钟的装依赖、打包，和不会自己结束的开发服务器、监听（command-scope.ts 的判定）
  { id: 'long', match: (s) => heavySegment(s.seg) || endlessSegment(s.seg) },
]

/** 一段命令的类别；拿不准返回 undefined */
export function categoryOf(seg: string): CommandCategory | undefined {
  const s = segOf(seg)
  if (!s.head) return undefined
  return COMMAND_CATEGORY_DEFS.find((d) => d.match(s))?.id
}

/** cd 这类只是换目录的段：认类别时跳过它（`cd web && rg foo` 的类别是 search，段数照样是 2，不改道） */
const MOVE = /^(?:cd|pushd|popd|set-location|sl)$/

/** 整条命令认出来的样子：段数按管道、&&、; 拆（heredoc 正文不算），类别按第一个不是换目录的段 */
export function parseCommand(cmd: string): ParsedCommand {
  const segs = runSegments(cmd)
  const main = segs.find((s) => !MOVE.test(segHead(s))) ?? segs[0] ?? ''
  const category = main ? categoryOf(main) : undefined
  // 带引号的程序路径（"D:\Program Files\…\Build.bat"）programOf 按空格切会认错，用段首程序名
  const program = /^["']/.test(main.trim()) ? segOf(main).head : programOf(main) || segOf(main).head
  return {
    program,
    ...(category ? { category } : {}),
    segments: segs.length,
  }
}

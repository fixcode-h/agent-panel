/**
 * 搜索规范检查的入口（用户 2026-11-27 定）：把一条命令按段切开，认出其中的搜索段，逐条问 ./rules.ts 的规则，
 * 返回每段的问题和按规范改好的写法。纯函数：路径落在哪由调用方按真实目录判断（scopeOf），单测给假的
 */
import { segHead, stripHeredocs } from '../command-scope.ts'
import { unwrapShell } from '../shell-command.ts'
import { splitTop } from '../tool-gateway/shell-split.ts'
import { parseRg } from './rg-args.ts'
import { SEARCH_SPEC_RULES, type Scope } from './rules.ts'
import { CONVERTERS, isPlan, type Converted } from './to-rg.ts'
import { splitWords, type Word } from './words.ts'

export { searchSpecPrompt, SEARCH_BY_TYPE } from './guide.ts'
export type { Scope } from './rules.ts'

export interface SpecCtx {
  /** 工作目录（绝对路径） */
  cwd: string
  /** base 下的 p 换成绝对路径（p 可能是绝对路径、相对路径、Git Bash 的 /g/x） */
  resolve: (base: string, p: string) => string
  /** 绝对路径落在哪 */
  scopeOf: (abs: string) => Scope
  excludes: string[]
}

export interface SegViolation {
  /** 这一段原文 */
  seg: string
  whys: string[]
  /** 按规范改好的这一段（有能自动改的才有） */
  fixed?: string
  advice: string[]
}

// 模块状态：常量，加载后不改
const MOVE = new Set(['cd', 'pushd', 'set-location', 'sl', 'chdir'])
/** 在别的命令输出里过滤时也常用的几个：被管道喂进来、又没给文件时不算搜索 */
// 模块状态：常量，加载后不改
const FILTERS = new Set(['grep', 'egrep', 'fgrep', 'ugrep', 'findstr', 'select-string', 'sls'])

/** 重定向（2>/dev/null、> out.txt）不是程序的参数：换算前去掉，吞报错由 hide-errors 规则按原文认 */
function dropRedirects(words: Word[]): Word[] {
  const out: Word[] = []
  for (let i = 0; i < words.length; i++) {
    const w = words[i]
    if (w.quoted || !/^(?:\d?>>?|\d?>&\d|<|&>)/.test(w.v)) {
      out.push(w)
      continue
    }
    // 只写了符号（2> /dev/null）的，目标在下一个词
    if (/^(?:\d?>>?|<|&>)$/.test(w.v)) i++
  }
  return out
}

/** ls / dir / Get-ChildItem 只看一层是规范写法，带递归才算搜索 */
function recursiveList(head: string, args: Word[]): boolean {
  if (head === 'ls') return args.some((a) => /^-[A-Za-z]*R/.test(a.v) || a.v === '--recursive')
  if (head === 'dir') return args.some((a) => /^\/s$/i.test(a.v))
  return args.some((a) => /^-(recurse|r)$/i.test(a.v))
}

/** 这一段是不是要检查的搜索；是的话程序名（git grep 记成 git-grep） */
function searchHead(seg: string, words: Word[], piped: boolean): { head: string; args: Word[] } | undefined {
  let head = segHead(seg)
  const at = words.findIndex((w) => segHead(w.v) === head)
  let args = at >= 0 ? words.slice(at + 1) : words.slice(1)
  if (head === 'git' && args[0]?.v === 'grep') {
    head = 'git-grep'
    args = args.slice(1)
  }
  if (head === 'rg') return { head, args }
  if (!(head in CONVERTERS)) return undefined
  if (['ls', 'dir', 'get-childitem', 'gci'].includes(head) && !recursiveList(head, args)) return undefined
  if (FILTERS.has(head) && piped) {
    const c = CONVERTERS[head](args, head)
    if (isPlan(c) && !c.paths.length && !c.globs.length) return undefined
  }
  return { head, args }
}

/** 检查一条命令；全合规范返回空数组 */
export function checkSearchCommand(command: string, ctx: SpecCtx): SegViolation[] {
  const clean = stripHeredocs(unwrapShell(command))
  const parts = splitTop(clean) ?? clean.split(/\n|&&|\|\||;/).map((text) => ({ text, op: '' as const }))
  const out: SegViolation[] = []
  let base = ctx.cwd
  for (const part of parts) {
    const seg = part.text.trim()
    if (!seg) continue
    const words = dropRedirects(splitWords(seg))
    const h0 = segHead(seg)
    if (MOVE.has(h0)) {
      const to = words.slice(1).find((w) => !w.v.startsWith('-'))
      if (to) base = ctx.resolve(base, to.v)
      continue
    }
    const hit = searchHead(seg, words, part.op === '|')
    if (!hit) continue
    const rg = hit.head === 'rg' ? parseRg(hit.args) : undefined
    const converted: Converted | undefined = rg ? undefined : CONVERTERS[hit.head](hit.args, hit.head)
    const paths = rg ? rg.paths : converted && isPlan(converted) ? converted.paths : []
    const scopes = (paths.length ? paths : ['']).map((p) => ctx.scopeOf(p ? ctx.resolve(base, p) : base))
    const check = { text: seg, head: hit.head, args: hit.args, rg, converted, scopes, excludes: ctx.excludes }
    const issues = SEARCH_SPEC_RULES.map((r) => r.check(check)).filter((x) => !!x)
    if (!issues.length) continue
    // 换算不出 rg 的（按修改时间找、-exec 这些）只给建议：别的规则修好的半截命令仍然不合规范，不拿出来
    let fixed = seg
    if ((!converted || isPlan(converted)) && !issues.some((i) => i.noFix))
      for (const i of issues) if (i.patch) fixed = i.patch(fixed)
    out.push({
      seg,
      whys: issues.map((i) => i.why),
      ...(fixed !== seg ? { fixed } : {}),
      advice: issues.map((i) => i.advice).filter((x): x is string => !!x),
    })
  }
  return out
}

/** 退回时交给 Agent 的说明（提示词，不翻译） */
export function searchSpecDenyText(v: SegViolation[]): string {
  const items = v
    .slice(0, 4)
    .map((x, n) =>
      [
        `${n + 1}. \`${x.seg.length > 160 ? `${x.seg.slice(0, 160)}…` : x.seg}\``,
        `   问题：${x.whys.join('；')}`,
        ...(x.fixed ? [`   改成：\`${x.fixed}\``] : []),
        ...x.advice.map((a) => `   ${a}`),
      ].join('\n'),
    )
  return [
    '【面板】这条命令里的搜索不符合搜索规范，整条没有执行：',
    ...items,
    '按上面改好、其余部分照原样再跑一次。完整规范见系统提示词「搜索规范」一节（只用 rg；起点写到模块目录；从项目根搜要带文件类型；要搜排除目录就把它写成起点；不加 -r、--no-ignore、2>/dev/null）。',
  ].join('\n')
}

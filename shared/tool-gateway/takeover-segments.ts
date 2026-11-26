/**
 * 多段命令逐段改道（ADR 0084 第 11 条）：按引号把命令切成段，认得的搜索段各自交给 find，
 * 改写时只在每个搜索段前面原地插一句「打印面板这段的结果」，别的段、连接符、顺序一字不动，shell 照原样跑整条。
 *
 * 插的是 `node "<脚本>" && `：脚本只打印、退出码 0，所以 `a && 搜索`、`a; 搜索`、`搜索 | head` 的语义都不变
 * （管道比 && 绑得紧，面板那段不会被 head 截掉）。拿不准的段不接，整条拿不准的（换目录、循环、子 shell）一段都不接。
 * 例外是开头一句 `cd <写死的目录> && …`：模型（Claude Code 尤其）几乎每条搜索都这么起头，之后的相对路径按这个目录算就对得上
 */
import { categoryOf } from './commands.ts'
import { parseSearchCommand, type SearchSpec } from './search-args.ts'
import { splitTop } from './shell-split.ts'

/** 一个接得住的搜索段：参数，和面板那段插在原命令的哪个位置 */
export interface SearchUnit {
  search: SearchSpec
  at: number
  /**
   * 开头是 `cd <目录>;`（分号连的）时的那个目录：cd 失败时搜索还在原目录跑，所以只有这个目录就是 CLI 的工作目录时
   * 两边才一致，服务端核对后才接（复盘 2026-11-26：`cd <项目根>;` 有 59 条，约 13 条真正的目录搜索被漏掉）
   */
  sameDir?: string
}

/**
 * 跟在搜索后面、不改变「搜了什么」的管道段：截前后几行、排序去重。数行数（wc）、再过滤（grep -v）会让面板那段和原输出对不上，不算。
 * echo、printf、true 是 `rg … ; echo "exit:$?"` 这类用 ; 连的，不在管道里，本来就不影响
 */
const PIPE_TAILS = ['head', 'tail', 'sort', 'uniq']

export const firstWord = (seg: string) =>
  seg
    .trim()
    .split(/\s+/)[0]
    ?.replace(/^.*[\\/]/, '')
    .toLowerCase() ?? ''

/** 换目录的段：之后的相对路径就不是按工作目录算了，面板查的范围对不上 */
const MOVE_DIR = /^(?:cd|pushd|popd|set-location|sl)$/
/**
 * 开头的 `cd <目录>`：目录是写死的（不带变量、~、-），cmd 的 `cd /d` 不认。
 * 只认第一段、后面是 `&&`（cd 失败就不往下跑，搜索一定在这个目录里）；`;` 连的 cd 失败了搜索还在原目录跑，
 * 所以 `;` 只在目录就是工作目录时接（SearchUnit.sameDir，服务端核对）
 */
const LEAD_CD = /^cd\s+(?:"([^"$`]+)"|'([^']+)'|([^\s"'$`;&|]+))$/i
function leadDir(text: string): string | undefined {
  const m = LEAD_CD.exec(text.trim())
  const dir = m?.[1] ?? m?.[2] ?? m?.[3]
  if (!dir || /^[-~]|^\/d$|[$%]/i.test(dir)) return undefined
  return dir
}

/** 绝对路径（/x、C:\x、C:/x、\\server） */
const isAbs = (p: string) => /^(?:[A-Za-z]:)?[\\/]/.test(p)

/** 搜索的路径换成「cd 的目录 + 原路径」：空表示 cd 的目录本身；绝对路径不动。服务端按 CLI 的工作目录再换成相对的 */
function underDir(s: SearchSpec, dir: string): SearchSpec {
  const d = dir.replace(/[\\/]+$/, '')
  const paths = s.paths.length ? s.paths.map((p) => (isAbs(p) ? p : `${d}/${p}`)) : [d]
  // 照原样跑（代答）的跑法不在 cd 的目录里，去掉：逐段改写用不到它
  const { run: _run, ...rest } = s
  return { ...rest, paths }
}

/** 循环、条件、函数：里面的搜索可能跑多次、参数要运行时才知道 */
const KEYWORDS = /^(?:for|while|until|if|then|else|elif|fi|do|done|case|esac|function|foreach|select)$/

/**
 * 每个接得住的搜索段；一个都没有、或整条拿不准时返回 undefined。接得住的条件：
 * - 读得懂的按内容搜（parseSearchCommand 认得、不是按名字找文件）；
 * - 不是被管道喂进来的（那样搜的是上一段的输出），前面不是 `||`（可能根本不跑），自己不放后台；
 * - 输出再管道下去只接 PIPE_TAILS。
 * 整条拿不准：有换目录（开头一句 `cd <目录> &&` 除外，见 leadDir）、循环条件关键字、子 shell 或花括号组
 */
export function searchUnits(command: string): SearchUnit[] | undefined {
  const parts = splitTop(command)
  if (!parts) return undefined
  const op = parts.length > 1 ? parts[1].op : undefined
  const dir = op === '&&' || op === ';' ? leadDir(parts[0].text) : undefined
  const semi = op === ';' && dir ? dir : undefined
  if (
    parts.some(
      (p, i) =>
        (MOVE_DIR.test(firstWord(p.text)) && !(i === 0 && dir)) ||
        KEYWORDS.test(firstWord(p.text)) ||
        /^[({]/.test(p.text),
    )
  )
    return undefined
  const units: SearchUnit[] = []
  parts.forEach((p, i) => {
    if (categoryOf(p.text) !== 'search' || p.op === '|' || p.op === '||') return
    for (let j = i + 1; j < parts.length && parts[j].op === '|'; j++)
      if (!PIPE_TAILS.includes(firstWord(parts[j].text))) return
    // 后台跑的（`grep … &`）：面板那段先打印完，搜索结果什么时候出来说不准
    if (parts[i + 1]?.op === '&') return
    const search = parseSearchCommand(p.text)
    if (search?.mode === 'content')
      units.push({ search: dir ? underDir(search, dir) : search, at: p.start, ...(semi && { sameDir: semi }) })
  })
  return units.length ? units : undefined
}

/** 在每个位置插一句打印对应脚本；从后往前插，前面的位置不会被挪动。路径一律用正斜杠（Windows 上 node 也认） */
export function rewriteAt(original: string, inserts: { at: number; script: string }[]): string {
  let out = original
  for (const x of [...inserts].sort((a, b) => b.at - a.at))
    out = `${out.slice(0, x.at)}node "${x.script.replace(/\\/g, '/')}" && ${out.slice(x.at)}`
  return out
}

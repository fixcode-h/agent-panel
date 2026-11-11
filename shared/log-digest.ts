/**
 * 编译、测试日志的提炼（工作包 I，「Agent 模式可优化与扩展点」优化 4 的编译日志）：
 * 后台命令以前只把输出结尾 6000 字推回对话，报错在中间、结尾是汇总时会漏掉错误，而那 6000 字又整段进了上下文。
 * 现在边跑边按编译器的格式认出错误和警告行（去重、限条数），推回时只给「退出码 + 错误和警告 + 结尾几十行 + 完整日志的路径」，
 * 成功时只给最后几行。认行只看格式（文件位置 + error / warning、错误码），不猜语义
 */

/** 错误行：MSVC / UBT（a.cpp(12): error C2065:）、gcc / clang（a.c:3:5: error:）、tsc（a.ts(1,2): error TS2322:）、
 * 链接（error LNK2019:）、rustc（error[E0308]:）、行首的 error: / ERROR、UE 日志（LogXxx: Error:）、测试框架的失败行 */
const ERROR_RES = [
  /\b(?:fatal\s+)?error\s+[A-Z]{1,4}\d{2,5}\b/,
  /[:)]\s*(?:fatal\s+)?error\b\s*[:A-Z]/,
  /^\s*(?:fatal\s+)?error(?:\[[A-Z]?\d+\])?\s*:/i,
  /^\s*ERROR\b/,
  /\bLog\w+:\s*Error:/,
  /^\s*(?:FAIL|FAILED|not ok)\b/,
  /^\s*(?:✖|×|✗)\s/,
]
const WARN_RES = [
  /\bwarning\s+[A-Z]{1,4}\d{2,5}\b/,
  /[:)]\s*warning\b\s*[:A-Z]/,
  /^\s*warning(?:\[[A-Z]?\d+\])?\s*:/i,
  /^\s*WARNING\b/,
  /\bLog\w+:\s*Warning:/,
]

/** 列多少条：错误按编译器先报的在前，后面多是连锁报错；警告只是提个醒 */
export const DIGEST_ERRORS = 30
export const DIGEST_WARNINGS = 10
/** 一行最多多长：模板展开的报错一行能有几千字 */
const LINE_MAX = 400

export interface LogDigest {
  errors: string[]
  warnings: string[]
  /** 认出来的总条数（去重后），列出来的只是前几条 */
  errorCount: number
  warningCount: number
}

/** 去掉行首的时间戳、进度前缀，同一条报错在不同时间打印两次算一条 */
const key = (line: string) =>
  line
    .replace(/^\s*\[[^\]]*\]\s*(?:\[[^\]]*\]\s*)*/, '')
    .replace(/\s+/g, ' ')
    .trim()

/** 边跑边收的提炼器：每来一行 add 一次，跑完取 digest()。保存的行数有上限，长时间的日志也不涨内存 */
export function createDigest() {
  const errors = new Set<string>()
  const warnings = new Set<string>()
  let errorCount = 0
  let warningCount = 0
  const seenErr = new Set<string>()
  const seenWarn = new Set<string>()
  const add = (raw: string) => {
    const line = raw.replace(/\s+$/, '')
    if (!line.trim()) return
    if (ERROR_RES.some((re) => re.test(line))) {
      const k = key(line)
      if (seenErr.has(k)) return
      // 只记已经列出来的那几条的键：超出条数的只计数，seenErr 不会无限增长
      errorCount++
      if (errors.size < DIGEST_ERRORS) {
        seenErr.add(k)
        errors.add(line.length > LINE_MAX ? `${line.slice(0, LINE_MAX)}…` : line)
      }
      return
    }
    if (WARN_RES.some((re) => re.test(line))) {
      const k = key(line)
      if (seenWarn.has(k)) return
      warningCount++
      if (warnings.size < DIGEST_WARNINGS) {
        seenWarn.add(k)
        warnings.add(line.length > LINE_MAX ? `${line.slice(0, LINE_MAX)}…` : line)
      }
    }
  }
  const digest = (): LogDigest => ({ errors: [...errors], warnings: [...warnings], errorCount, warningCount })
  return { add, digest }
}

export const digestLines = (lines: string[]) => {
  const d = createDigest()
  for (const l of lines) d.add(l)
  return d.digest()
}

/** 结尾留几行：失败时报错前后的上下文和汇总，成功时只要最后的汇总 */
const TAIL_FAIL_LINES = 40
const TAIL_FAIL_CHARS = 3000
const TAIL_OK_LINES = 5
const TAIL_OK_CHARS = 600

const fence = (s: string) => `\n\`\`\`\n${s}\n\`\`\``

/**
 * 推回给 Agent 的日志部分（不含开头「跑完了：成功 / 失败」那句）：
 * 成功 → 最后几行 + 警告条数；失败 → 错误行、警告行、结尾几十行。有完整日志文件时写明路径，要细节让它搜那个文件
 */
export function digestText(lines: string[], d: LogDigest, ok: boolean, logFile = ''): string {
  const tailLines = lines.slice(-(ok ? TAIL_OK_LINES : TAIL_FAIL_LINES))
  let tail = tailLines.join('\n')
  const maxChars = ok ? TAIL_OK_CHARS : TAIL_FAIL_CHARS
  if (tail.length > maxChars) tail = `…${tail.slice(-maxChars)}`
  const parts: string[] = []
  if (!ok && d.errors.length)
    parts.push(
      `错误（${d.errorCount} 条${d.errorCount > d.errors.length ? `，列前 ${d.errors.length} 条` : ''}）：${fence(d.errors.join('\n'))}`,
    )
  if (d.warningCount) {
    if (ok) parts.push(`另有 ${d.warningCount} 条警告${logFile ? '，在完整日志里' : ''}。`)
    else
      parts.push(
        `警告（${d.warningCount} 条${d.warningCount > d.warnings.length ? `，列前 ${d.warnings.length} 条` : ''}）：${fence(d.warnings.join('\n'))}`,
      )
  }
  if (tail.trim()) parts.push(`输出结尾：${fence(tail)}`)
  if (logFile) parts.push(`完整日志：${logFile}（要细节用 rg 搜这个文件，不要整份读进来）`)
  return parts.join('\n')
}

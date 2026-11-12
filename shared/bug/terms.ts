/**
 * 诊断报告里 Agent 写的文字补上 Markdown 标记（shared/bug/diagnosis-md.ts 用，用户 2026-11-07 要求）：
 * 模型常把文件名、函数名、字段写成普通文字（「s_CSM_Foo.lua 在 OnTaskChange 记录 CurType」），弹窗里一片同色的字，
 * 哪些是代码、哪些是说明分不出来；要用户留意的话也混在正文里。
 *
 * 统一的规则（和对话里一致，见 web/src/lib/file-path.ts 的 linkPaths）：
 * - 带目录的文件路径 → 反引号包起来，渲染时画成能点开的文件标记；
 * - 单独的文件名、函数名、变量、字段、`键=值` → 反引号包起来，按行内代码显示；
 * - 「注意：/警告：/风险：」开头的一行 → 单独一行的写成 `> [!WARNING]` 提示块，列表里的把这几个字加粗。
 *
 * 只补没写的：已经在反引号、代码块、链接、网址、HTML 标签里的原样不动，不改写内容
 */

/** 能认成文件的扩展名：和 file-path.ts 的白名单同一类（代码、配置、文档、表格），不认 a.b、v1.2 这种 */
const EXT =
  'ts|tsx|js|jsx|mjs|cjs|json|jsonc|md|css|scss|less|html|vue|py|go|rs|java|kt|swift|c|h|cc|cpp|hpp|cs|rb|php|' +
  'ya?ml|toml|ini|sql|sh|ps1|bat|lua|proto|xml|txt|log|csv|xlsx?|xlsm|docx?|uasset|umap|cfg|conf|gradle|dart'

/**
 * 一个词：文件路径 | 键=值 | 标识符（可带 . : 成员访问和结尾的 ()）。
 * 左右不能紧挨字母数字和路径符号，免得从一个长词中间切出半截
 */
const TERM = new RegExp(
  String.raw`(?<![\w\`/\\.\-])(?:` +
    // 文件：可选盘符或 ./ ../，若干目录段，文件名.扩展名，可带 :行号
    String.raw`((?:[A-Za-z]:[\\/]|\.{1,2}[\\/])?(?:[\w.\-]+[\\/])*[\w\-]+(?:\.[\w\-]+)*\.(?:${EXT})(?::\d+(?::\d+)?)?)` +
    // 键=值：target_type=59、client_param1=InstanceID
    String.raw`|([A-Za-z_]\w*=[\w.\-]+)` +
    // 标识符
    String.raw`|([A-Za-z_]\w*(?:(?:\.|:)[A-Za-z_]\w*)*(?:\(\))?)` +
    String.raw`)(?![\w\`/\\])`,
  'g',
)

/** 驼峰里像产品名、不是代码的词：不包 */
// 模块状态：常量，加载后不改
const PLAIN = new Set([
  'GitHub',
  'GitLab',
  'JavaScript',
  'TypeScript',
  'PowerShell',
  'WebSocket',
  'macOS',
  'iOS',
  'iPhone',
  'iPad',
  'YouTube',
  'OpenAI',
  'DeepSeek',
  'ClaudeCode',
  'VSCode',
  'PlayStation',
  'WeChat',
  'UE4',
  'UE5',
])

/** 像代码的标识符：带下划线（snake_case、s_CSM_Foo、MAX_N），驼峰里有小写接大写，成员访问，或结尾 () */
function codeLike(word: string) {
  if (PLAIN.has(word)) return false
  if (/\(\)$/.test(word)) return true
  if (/[.:]/.test(word)) return word.split(/[.:]/).some(codeLike)
  return /[A-Za-z0-9]_[A-Za-z0-9]|^_\w/.test(word) || /[a-z][A-Z]/.test(word)
}

/** 不动的片段：代码块、行内代码、Markdown 链接 / 图片、网址、HTML 标签（表格里的 <br>） */
const KEEP = /(```[\s\S]*?```|`[^`\n]*`|!?\[[^\]\n]*\]\([^)\n]*\)|https?:\/\/[^\s)）]+|<[^>\n]+>)/

function wrap(text: string) {
  return text.replace(TERM, (all, file?: string, kv?: string, id?: string) => {
    if (file || kv) return `\`${all}\``
    return id && codeLike(id) ? `\`${all}\`` : all
  })
}

/** 文件名、标识符补上反引号 */
export function codeTerms(text: string): string {
  if (!text) return text
  return text
    .split(KEEP)
    .map((part, i) => (i % 2 ? part : wrap(part)))
    .join('')
}

/** 「注意：/警告：/风险：」开头的行：单独一行的写成提示块，列表项里的把标签加粗 */
const FLAG = /^(\s*(?:[-*+]\s+|\d+[.)]\s+)?)(注意|警告|风险|重要|务必)[：:]\s*(.+)$/

export function flagLines(text: string): string {
  if (!text) return text
  return text
    .split('\n')
    .map((line) => {
      const m = FLAG.exec(line)
      if (!m) return line
      const [, lead, word, rest] = m
      if (lead.trim()) return `${lead}**${word}**：${rest}`
      // 前后空一行：提示块后面紧跟的一行不空行会被 Markdown 当成提示块的续行吞进去
      return `\n> [!WARNING]\n> ${rest}\n`
    })
    .join('\n')
}

/** 报告里 Agent 写的一段文字：先补标记，再把要注意的行标出来 */
export const marked = (text: string) => flagLines(codeTerms(text))

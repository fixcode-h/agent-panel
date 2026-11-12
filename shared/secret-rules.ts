/**
 * 像真实密钥的文本：面板里所有「查有没有写进真密钥」的地方共用这一份（凭据守卫、钩子校验、配置安全扫描）。
 * scripts/secret-check.mjs 是给本仓库 lint 用的独立脚本（不引 TypeScript），规则是同一套，
 * shared/secret-rules.test.ts 核对两边一致：改一边要同步改另一边
 */

/** 值长度要求写进正则，避免把代码里的 `api_key = getKey()`、文档里的 `sk-` 前缀本身当成密钥 */
export const SECRET_RULES: { name: string; re: RegExp }[] = [
  { name: '私钥块', re: /-----BEGIN (?:[A-Z0-9]+ )*PRIVATE KEY-----/ },
  // OpenAI / Anthropic / OpenRouter 等以 sk- 开头的密钥（sk-ant-、sk-proj-、sk-or-v1-）
  { name: 'sk- 开头的 API key', re: /\bsk-(?:ant-|proj-|or-v1-)?[A-Za-z0-9_-]{20,}/ },
  { name: 'Google API key', re: /\bAIza[0-9A-Za-z_-]{30,}/ },
  { name: 'Hugging Face 令牌', re: /\bhf_[A-Za-z0-9]{20,}/ },
  { name: 'GitHub 令牌', re: /\b(?:gh[pousr]_[A-Za-z0-9]{30,}|github_pat_[A-Za-z0-9_]{40,})/ },
  { name: 'Slack 令牌', re: /\bxox[abprs]-[A-Za-z0-9-]{10,}/ },
  { name: 'AWS 访问密钥', re: /\bAKIA[0-9A-Z]{16}\b/ },
  { name: 'Bearer 令牌', re: /\bBearer\s+([A-Za-z0-9._~+/=-]{24,})/i },
  { name: 'URL 里的密码', re: /\b[a-z][a-z0-9+.-]*:\/\/[^\s:@/]+:([^\s@/]{8,})@/i },
  {
    name: '赋值的密钥',
    re: /\b(?:api[_-]?key|apikey|secret[_-]?key|access[_-]?token|auth[_-]?token|client[_-]?secret|password|passwd)\b\s*[:=]\s*['"`]?([A-Za-z0-9_\-./+=]{16,})/i,
  },
]

// 只看值本身像不像占位符，不看整行：注释里写「测试用的假 key」不豁免真实值
const PLACEHOLDER = /^(?:x{4,}|0{6,}|\*{3,}|\.{3,}|<[^>]*>|\$\{[^}]*\})$/i

/** 明显的假值、占位符或示例 */
export function isPlaceholder(value: string): boolean {
  if (!value) return false
  if (PLACEHOLDER.test(value)) return true
  // 连续 4 个 x/0 是占位符的常见写法；真实密钥里出现的概率可以忽略
  if (/x{4,}|0{6,}/i.test(value)) return true
  return /(?:your[-_]?|example|placeholder|fake|dummy|sample|changeme|redacted|not[-_]?real|test[-_]?(?:key|token|secret))/i.test(
    value,
  )
}

/** 环境变量名和代码里的引用（process.env.OPENAI_API_KEY），不是密钥的值：只对「赋值的密钥」生效 */
const isReference = (value: string) =>
  /^(?:process\.env|import\.meta|os\.environ|System\.getenv)\b/.test(value) || /^[A-Z][A-Z0-9_.]*$/.test(value)

/** 一行里像真实密钥的值：返回规则名和值；没有返回 undefined */
export function secretInLine(line: string): { rule: string; value: string } | undefined {
  if (line.includes('secret-check-ok')) return undefined
  for (const { name, re } of SECRET_RULES) {
    const m = re.exec(line)
    if (!m) continue
    const value = m[1] ?? m[0]
    if (isPlaceholder(value)) continue
    if (name === '赋值的密钥' && isReference(value)) continue
    return { rule: name, value }
  }
  return undefined
}

/** 整段文字里有没有像真实密钥的值 */
export const hasSecret = (text: string) => text.split('\n').some((l) => !!secretInLine(l))

/** 只显示前几位和后几位，方便核对，又不把完整密钥留在界面和日志里 */
export function maskSecret(value: string): string {
  if (value.length <= 12) return `${value.slice(0, 2)}…${value.slice(-2)}`
  return `${value.slice(0, 6)}…${value.slice(-4)}`
}

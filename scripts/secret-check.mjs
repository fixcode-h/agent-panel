// 防止真实凭据被写进仓库：`npm run lint` 会跑这个检查，CI 和本地都会拦住。
// 用法：node scripts/secret-check.mjs             检查已跟踪 + 未跟踪（不含 .gitignore）的文件
//       node scripts/secret-check.mjs --staged    只检查暂存的文件，适合放进提交前检查
//       node scripts/secret-check.mjs <文件...>   只检查给出的文件
// 命中时打印文件、行号、规则和脱敏后的片段（只留前几位和后几位），并以非 0 退出。
// 确实要用示例值：写成 sk-xxxx / your-api-key 这类占位符，或在该行结尾加 secret-check-ok 并说明原因。
import { execFileSync } from 'node:child_process'
import { existsSync, readFileSync, statSync } from 'node:fs'
import path from 'node:path'
import { fileURLToPath } from 'node:url'

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..')

// 只看值本身像不像占位符，不看整行：注释里写「测试用的假 key」不豁免真实值
const PLACEHOLDER = /^(?:x{4,}|0{6,}|\*{3,}|\.{3,}|<[^>]*>|\$\{[^}]*\})$/i

/** 判断命中的值是不是明显的假值、占位符或示例 */
export function isPlaceholder(value) {
  if (!value) return false
  if (PLACEHOLDER.test(value)) return true
  // 连续 4 个 x/0 是占位符的常见写法；真实密钥里出现的概率可以忽略
  if (/x{4,}|0{6,}/i.test(value)) return true
  return /(?:your[-_]?|example|placeholder|fake|dummy|sample|changeme|redacted|not[-_]?real|test[-_]?(?:key|token|secret))/i.test(
    value,
  )
}

// 值的长度要求写进正则，避免把代码里的 `api_key = getKey()`、文档里的 `sk-` 前缀本身当成密钥
export const RULES = [
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

// 纯 hex 的长串在哈希、测试夹具、压缩产物里很常见，只靠熵分不出真假，交给上面的前缀规则
const HEX_ONLY = /^[0-9a-f]+$/i
// 字符集不含 `/`：否则 ComfyUI 工作流里的路径（/ComfyUI/...）会被当成随机串
const TOKEN_CHARS = /^[A-Za-z0-9+_=-]+$/

/** 香农熵（每字符比特），随机串一般在 4.5 以上 */
export function entropy(s) {
  const counts = new Map()
  for (const ch of s) counts.set(ch, (counts.get(ch) ?? 0) + 1)
  let h = 0
  for (const n of counts.values()) {
    const p = n / s.length
    h -= p * Math.log2(p)
  }
  return h
}

/** 没有已知前缀、但看起来是随机生成的令牌 */
export function looksRandom(value) {
  if (value.length < 32 || !TOKEN_CHARS.test(value) || HEX_ONLY.test(value)) return false
  if (!/[A-Z]/.test(value) || !/[a-z]/.test(value) || !/[0-9]/.test(value)) return false
  return entropy(value) >= 4.5
}

// lock 文件和压缩产物里全是 integrity 哈希、sourcemap 的 base64，不跑高熵检测（前缀规则照跑）
const NO_ENTROPY = /(?:^|\/)(?:package-lock\.json|npm-shrinkwrap\.json|[^/]*\.lock|.*\.min\.(?:js|css)|.*\.map)$/

// 环境变量名和代码里的引用（AGENT_PANEL_API_KEY、process.env.OPENAI_API_KEY），不是密钥的值。
// 只对「赋值的密钥」生效：AKIA... 这类全大写的强前缀本来就可能是真密钥
const isReference = (value) =>
  /^(?:process\.env|import\.meta|os\.environ|System\.getenv)\b/.test(value) || /^[A-Z][A-Z0-9_.]*$/.test(value)

/** 扫描一段文本，返回每行的命中：{ line, rule, value } */
export function scanText(text, { highEntropy = true } = {}) {
  const hits = []
  text.split('\n').forEach((line, i) => {
    if (line.includes('secret-check-ok')) return
    const seen = new Set()
    for (const { name, re } of RULES) {
      const m = re.exec(line)
      if (!m) continue
      const value = m[1] ?? m[0]
      if (isPlaceholder(value) || seen.has(value)) continue
      if (name === '赋值的密钥' && isReference(value)) continue
      seen.add(value)
      hits.push({ line: i + 1, rule: name, value })
    }
    if (!highEntropy) return
    for (const m of line.matchAll(/[A-Za-z0-9+_=-]{32,}/g)) {
      const value = m[0]
      // 变量名和值被 = 连在一起时（OPENAI_KEY=sk-...）会整段命中一遍，含已知密钥就跳过
      if ([...seen].some((v) => value.includes(v))) continue
      if (isPlaceholder(value) || !looksRandom(value)) continue
      seen.add(value)
      hits.push({ line: i + 1, rule: '高熵随机串', value })
    }
  })
  return hits
}

/** 只显示前几位和后几位，方便用户自己核对，又不把完整密钥留在终端和日志里 */
export function mask(value) {
  if (value.length <= 12) return `${value.slice(0, 2)}…${value.slice(-2)}（共 ${value.length} 字符）`
  return `${value.slice(0, 6)}…${value.slice(-4)}（共 ${value.length} 字符）`
}

// 生成密钥、证书一类的文件不该被跟踪，即使不小心 git add -f 了也能在这里发现
export const FILE_RULES = [
  { name: '环境变量文件', re: /(?:^|\/)\.env(?!\.(?:example|sample|template))[^/]*$/ },
  { name: '密钥或证书文件', re: /\.(?:pem|key|p12|pfx|jks)$/i },
  { name: 'SSH 私钥或云凭据', re: /(?:^|\/)(?:id_rsa|id_ed25519|id_ecdsa|credentials\.json)$/ },
]

const git = (args) => execFileSync('git', args, { cwd: root, encoding: 'utf8' }).split('\n').filter(Boolean)
const rel = (f) => path.relative(root, path.resolve(f)).replaceAll('\\', '/')

export function listFiles(mode, targets = []) {
  if (targets.length) return targets.map(rel)
  if (mode === 'staged') return git(['diff', '--cached', '--name-only', '--diff-filter=ACMR'])
  return git(['ls-files', '--cached', '--others', '--exclude-standard'])
}

const MAX_BYTES = 2 * 1024 * 1024
const isBinary = (buf) => buf.subarray(0, 8000).includes(0)

export function checkFiles(names) {
  const problems = []
  for (const name of names) {
    const full = path.join(root, name)
    if (!existsSync(full) || !statSync(full).isFile()) continue
    for (const { name: rule, re } of FILE_RULES) {
      if (re.test(name)) problems.push({ file: name, line: 0, rule, value: '' })
    }
    const buf = readFileSync(full)
    // 二进制和超大文件不扫内容；超大文件里的密钥应该单独人工看
    if (buf.length > MAX_BYTES || isBinary(buf)) continue
    const text = buf.toString('utf8').replace(/\r\n/g, '\n')
    for (const hit of scanText(text, { highEntropy: !NO_ENTROPY.test(name) })) problems.push({ file: name, ...hit })
  }
  return problems
}

const isMain = process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)
if (isMain) {
  const args = process.argv.slice(2)
  const mode = args.includes('--staged') ? 'staged' : 'all'
  const names = listFiles(
    mode,
    args.filter((a) => !a.startsWith('--')),
  )
  const problems = checkFiles(names)
  if (problems.length) {
    console.error(`发现 ${problems.length} 处可能的凭据，真实密钥不能写进仓库：`)
    for (const p of problems) {
      const where = p.line ? `${p.file}:${p.line}` : p.file
      const value = p.value ? `${mask(p.value)}  ` : ''
      console.error(`  ${where}  [${p.rule}]  ${value}`)
    }
    console.error(
      [
        '处理：',
        '  - 真实密钥：从代码和提交历史里清掉，并到服务商控制台轮换（旧的视为已泄露）',
        '  - 示例或测试值：改成 sk-xxxx / your-api-key 这类占位符',
        '  - 确实要保留：在该行结尾加 secret-check-ok 并写明原因',
      ].join('\n'),
    )
    process.exit(1)
  }
  console.log(`凭据检查通过：检查了 ${names.length} 个文件`)
}

import { t } from '../i18n.ts'
import type { ConfigFinding } from './index.ts'

/**
 * 包装专用的扫描规则（ADR 0068，设计稿 7.2 第 4 条）：从 GitHub 链接包装插件时，在通用配置扫描之外再查几样
 * 「装进来会运行或带进来」的东西——安装钩子脚本、混淆或超长单行的 JS、内嵌的可执行二进制、
 * 出现的外部域名、文档里的 `curl … | sh`。只扫**实际要装进包的文件**，不扫整个仓库。
 * 纯函数，只做确定性匹配，不调模型。
 */

export interface WrapScanFile {
  /** 相对包根 */
  path: string
  data: Uint8Array
}

const MAX_TEXT = 256 * 1024
/** 一行超过这么长又不是 .min.js，多半是打包或混淆过的 */
const LONG_LINE = 5000
const CODE = /\.(?:js|mjs|cjs|ts|mts|cts|py|sh|bash|ps1|rb|lua)$/i
const DOC = /\.(?:md|mdx|markdown|txt|sh|bash|ps1)$/i
/** 安装钩子：npm 装依赖时会自动跑的脚本名 */
const HOOK_SCRIPTS = ['preinstall', 'install', 'postinstall', 'prepare', 'prepublish']
/** 常见的、不用特别提示的域名（文档、包仓库、协议规范） */
const COMMON_HOSTS =
  /(?:^|\.)(?:github\.com|npmjs\.(?:com|org)|pypi\.org|python\.org|nodejs\.org|w3\.org|mozilla\.org|schema\.org|json-schema\.org|example\.(?:com|org)|localhost|apache\.org|opensource\.org|shields\.io|semver\.org|modelcontextprotocol\.io)$/i

// shared 不带 DOM 类型：TextDecoder 在 Node 和浏览器里都是全局的，这里只声明用到的那一点
type Decoder = { decode(b: Uint8Array): string }
const decoder = new (globalThis as unknown as { TextDecoder: new (label: string) => Decoder }).TextDecoder('utf-8')
const isBinary = (d: Uint8Array) => d.subarray(0, 8000).includes(0)
const asText = (d: Uint8Array) => decoder.decode(d.subarray(0, MAX_TEXT))
const cut = (s: string, n = 160) => {
  const one = s.trim().replace(/\s+/g, ' ')
  return one.length > n ? `${one.slice(0, n)}…` : one
}

/** 可执行文件的文件头：ELF、PE（MZ）、Mach-O */
function execMagic(d: Uint8Array) {
  if (d.length < 4) return ''
  if (d[0] === 0x7f && d[1] === 0x45 && d[2] === 0x4c && d[3] === 0x46) return 'ELF'
  if (d[0] === 0x4d && d[1] === 0x5a) return 'PE'
  const be = (d[0] << 24) | (d[1] << 16) | (d[2] << 8) | d[3]
  if ([0xfeedface, 0xfeedfacf, 0xcefaedfe, 0xcffaedfe, 0xcafebabe].includes(be >>> 0)) return 'Mach-O'
  return ''
}

function installHooks(f: WrapScanFile, out: ConfigFinding[]) {
  if (!/(?:^|\/)package\.json$/.test(f.path)) return
  let scripts: Record<string, unknown> = {}
  try {
    scripts = (JSON.parse(asText(f.data)) as { scripts?: Record<string, unknown> }).scripts ?? {}
  } catch {
    return
  }
  for (const k of HOOK_SCRIPTS)
    if (typeof scripts[k] === 'string')
      out.push({
        rule: 'wrap.install-hook',
        category: 'package',
        level: 'medium',
        file: f.path,
        line: 0,
        snippet: cut(`"${k}": "${scripts[k] as string}"`),
        why: t('npm 装依赖时会自动运行的脚本（包装器用 --ignore-scripts 不跑它，但手动安装会跑）'),
      })
}

function obfuscated(f: WrapScanFile, text: string, out: ConfigFinding[]) {
  if (!/\.(?:m?js|cjs)$/i.test(f.path) || /\.min\.(?:m?js|cjs)$/i.test(f.path)) return
  const lines = text.split('\n')
  const i = lines.findIndex((l) => l.length > LONG_LINE)
  // \x 转义或 _0x 变量名成片出现，是常见混淆器的痕迹
  const hex = (text.match(/\\x[0-9a-f]{2}|_0x[0-9a-f]{4,}/gi) ?? []).length
  if (i < 0 && hex < 200) return
  out.push({
    rule: 'wrap.obfuscated',
    category: 'package',
    level: 'medium',
    file: f.path,
    line: i < 0 ? 0 : i + 1,
    snippet: cut((i < 0 ? text.slice(0, 200) : lines[i]).slice(0, 200)),
    why: t('压缩或混淆过的代码，看不出它做什么；确认是上游的构建产物再装'),
  })
}

function curlPipe(f: WrapScanFile, text: string, out: ConfigFinding[]) {
  if (!DOC.test(f.path)) return
  const lines = text.split('\n')
  for (let i = 0; i < lines.length; i++)
    if (
      /\b(?:curl|wget|iwr|Invoke-WebRequest)\b[^\n|]*\|\s*(?:sudo\s+)?(?:sh|bash|zsh|iex|python3?)\b/i.test(lines[i])
    ) {
      out.push({
        rule: 'wrap.curl-sh',
        category: 'package',
        level: 'high',
        file: f.path,
        line: i + 1,
        snippet: cut(lines[i]),
        why: t('从网上下载脚本直接执行：内容随时能被换掉，Agent 照着做就会运行它'),
      })
      return
    }
}

/**
 * 扫要装进包的文件。外部域名汇总成一条（低级）：用户一眼看到这个包会连哪些地方
 */
export function scanWrapFiles(files: WrapScanFile[]): ConfigFinding[] {
  const out: ConfigFinding[] = []
  const hosts = new Map<string, string>()
  for (const f of files) {
    if (isBinary(f.data)) {
      const magic = execMagic(f.data)
      if (magic)
        out.push({
          rule: 'wrap.binary',
          category: 'package',
          level: 'medium',
          file: f.path,
          line: 0,
          snippet: `${magic} · ${Math.round(f.data.length / 1024)} KB`,
          why: t('包里带着可执行的二进制文件，扫描看不到它的内容'),
        })
      continue
    }
    const text = asText(f.data)
    installHooks(f, out)
    obfuscated(f, text, out)
    curlPipe(f, text, out)
    if (CODE.test(f.path))
      for (const m of text.matchAll(/https?:\/\/([a-z0-9.-]+\.[a-z]{2,})(?=[/:'"`\s)]|$)/gi)) {
        const h = m[1].toLowerCase()
        if (!COMMON_HOSTS.test(h) && !hosts.has(h)) hosts.set(h, f.path)
      }
  }
  if (hosts.size)
    out.push({
      rule: 'wrap.domains',
      category: 'package',
      level: 'low',
      file: [...hosts.values()][0],
      line: 0,
      snippet: cut([...hosts.keys()].slice(0, 12).join('、') + (hosts.size > 12 ? ` 等 ${hosts.size} 个` : ''), 300),
      why: t('代码里出现的外部网址：装上后可能会连这些地方'),
    })
  return out
}

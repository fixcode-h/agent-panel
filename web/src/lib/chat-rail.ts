import type { Attachment, TaskMessage } from '@shared/schema'
import { attachChip } from '@shared/composer'

// Chat 页右栏（ChatRail）要的三样东西都从对话消息里现算：回复里的代码块、联网工具查到的链接、用户传的附件。
// 不另外存：消息就是唯一的来源，撤回、删消息之后右栏自然跟着变

export type ChatCode = {
  /** 消息 id + 第几块：切换消息后选中项还能对上 */
  id: string
  lang: string
  code: string
}

/** 回复里的代码块，按出现顺序。只认围栏代码块（``` 或 ~~~），没写完的最后一块（流式输出中）也先列出来 */
export function chatCodeBlocks(messages: readonly TaskMessage[]): ChatCode[] {
  const out: ChatCode[] = []
  for (const m of messages) {
    if (m.role !== 'agent' || (!m.text.includes('```') && !m.text.includes('~~~'))) continue
    let fence = ''
    let lang = ''
    let body: string[] = []
    let n = 0
    const push = () => {
      const code = body.join('\n')
      // 空块和 mermaid 图不算代码：图在对话里已经画出来了，存成文件也没用
      if (code.trim() && lang !== 'mermaid') out.push({ id: `${m.id}:${n}`, lang, code })
      n++
    }
    for (const line of m.text.split('\n')) {
      if (!fence) {
        const open = /^\s{0,3}(`{3,}|~{3,})\s*([\w+#.-]*)/.exec(line)
        if (open) {
          fence = open[1]
          lang = open[2].toLowerCase()
          body = []
        }
        continue
      }
      // 收尾的围栏：同一种符号、不比开头短、后面没有别的字
      if (new RegExp(`^\\s{0,3}${fence[0] === '`' ? '`' : '~'}{${fence.length},}\\s*$`).test(line)) {
        push()
        fence = ''
        continue
      }
      body.push(line)
    }
    if (fence) push()
  }
  return out
}

/** 语言名 → 存文件时的默认扩展名；不认识的语言按 txt 存 */
const EXT: Record<string, string> = {
  ts: 'ts',
  typescript: 'ts',
  tsx: 'tsx',
  js: 'js',
  javascript: 'js',
  jsx: 'jsx',
  json: 'json',
  py: 'py',
  python: 'py',
  sh: 'sh',
  bash: 'sh',
  shell: 'sh',
  zsh: 'sh',
  ps1: 'ps1',
  powershell: 'ps1',
  sql: 'sql',
  css: 'css',
  scss: 'scss',
  html: 'html',
  xml: 'xml',
  yaml: 'yaml',
  yml: 'yml',
  toml: 'toml',
  md: 'md',
  markdown: 'md',
  go: 'go',
  rust: 'rs',
  rs: 'rs',
  java: 'java',
  kotlin: 'kt',
  c: 'c',
  cpp: 'cpp',
  'c++': 'cpp',
  cs: 'cs',
  csharp: 'cs',
  rb: 'rb',
  ruby: 'rb',
  php: 'php',
  swift: 'swift',
  lua: 'lua',
  diff: 'diff',
}

/** 「存到项目」的默认文件名：代码里能认出导出的组件 / 函数 / 类名就用它，否则 snippet-第几块 */
export function codeFileName(c: ChatCode, index: number) {
  const ext = EXT[c.lang] ?? 'txt'
  const named =
    /export\s+(?:default\s+)?(?:async\s+)?(?:function|class|const)\s+([A-Za-z_$][\w$]*)/.exec(c.code)?.[1] ??
    /^\s*(?:async\s+)?(?:function|class)\s+([A-Z][\w$]*)/m.exec(c.code)?.[1]
  return `${named || `snippet-${index + 1}`}.${ext}`
}

export type ChatSource = {
  url: string
  /** 域名（去掉 www.），列表里大字显示它 */
  host: string
  /** 域名后面的路径，小字 */
  path: string
  /** 哪次搜索 / 抓取带出来的：搜索词或网址 */
  via: string
}

const URL_RE = /https?:\/\/[^\s<>"'`)\]}，。、；）】]+/g

/** 联网搜索、打开网页这两种工具调用里出现的网址，按出现顺序去重 */
export function chatSources(messages: readonly TaskMessage[]): ChatSource[] {
  const seen = new Set<string>()
  const out: ChatSource[] = []
  const add = (raw: string, via: string) => {
    const url = raw.replace(/[.,;:!?]+$/, '')
    if (seen.has(url)) return
    let u: URL
    try {
      u = new URL(url)
    } catch {
      return
    }
    seen.add(url)
    const path = (u.pathname + u.search).replace(/\/$/, '')
    out.push({ url, host: u.hostname.replace(/^www\./, ''), path, via })
  }
  for (const m of messages)
    for (const tool of m.tools ?? []) {
      if (tool.kind !== 'web' || tool.failed) continue
      // 打开网页：label 就是网址；搜索：结果里的网址都在输出里
      for (const text of [tool.label, tool.output ?? ''])
        for (const hit of text.match(URL_RE) ?? []) add(hit, tool.label)
    }
  return out
}

/** 用户这几轮传上来的图片和文件（引用的一段原文不算），同一个文件只列一次 */
export function chatAttachments(messages: readonly TaskMessage[]): Attachment[] {
  const seen = new Set<string>()
  const out: Attachment[] = []
  for (const m of messages) {
    if (m.role !== 'user') continue
    for (const a of m.attachments ?? []) {
      if (attachChip(a) === 'quote' || seen.has(a.path)) continue
      seen.add(a.path)
      out.push(a)
    }
  }
  return out
}

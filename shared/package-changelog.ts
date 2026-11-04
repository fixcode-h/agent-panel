import { z } from 'zod'
import { versionAtLeast } from './hooks.ts'

/**
 * 插件的更新说明（ADR 0050 第四期）：包里的 CHANGELOG（Pi 1.5 起插件可以带，package.json 的 pi.changelogPath 指过去，
 * 写成空串表示不提供）。CLI 只在终端交互模式下次启动时显示，面板里看不到，所以设置页自己读。
 * 版本标题按 Pi 的约定：「## [1.2.0]」或「## 1.2.0 - 日期」
 */
export const ChangelogSpec = z.object({
  /** package.json 里放 CLI 自己字段的键（Pi 是 pi） */
  manifestKey: z.string(),
  /** 那个对象里写更新说明路径的字段 */
  field: z.string().default('changelogPath'),
  /** 没写时读包根目录下的这个文件 */
  fallback: z.string().default('CHANGELOG.md'),
})
export type ChangelogSpec = z.infer<typeof ChangelogSpec>

export interface ChangelogEntry {
  version: string
  /** 这个版本下面的正文（Markdown，原样） */
  body: string
}

/** 更新说明文件的相对路径；包明确关掉了（写成空串）返回 null */
export function changelogPath(spec: ChangelogSpec, manifest: unknown): string | null {
  const own = (manifest as Record<string, any> | undefined)?.[spec.manifestKey]
  const v = own && typeof own === 'object' ? own[spec.field] : undefined
  if (v === '') return null
  return typeof v === 'string' && v.trim() ? v.trim() : spec.fallback
}

const HEAD = /^##\s+\[?v?(\d+\.\d+\.\d+[\w.+-]*)\]?.*$/

/** 按版本标题切开；标题前的（总标题、说明）不要，最多留 limit 个版本 */
export function parseChangelog(text: string, limit = 30): ChangelogEntry[] {
  const out: ChangelogEntry[] = []
  let cur: ChangelogEntry | null = null
  for (const line of text.replace(/\r\n/g, '\n').split('\n')) {
    const m = HEAD.exec(line.trim())
    if (m) {
      if (out.length >= limit) break
      cur = { version: m[1], body: '' }
      out.push(cur)
    } else if (cur) cur.body += `${line}\n`
  }
  return out.map((e) => ({ ...e, body: e.body.trim() }))
}

/** 比 from 新的那些（更新后显示「这次更新了什么」）；from 为空时全部 */
export const newerThan = (entries: ChangelogEntry[], from: string | undefined) =>
  from ? entries.filter((e) => e.version !== from && versionAtLeast(e.version, from)) : entries

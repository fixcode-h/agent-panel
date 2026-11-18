/**
 * 联网检查新模型（设置 → 默认 Agent → 模型目录）：用户点按钮时让「AI 辅助」的 Agent 联网查各厂商官方文档，
 * 列出目录里还没有的模型；用户勾选后才写进补充目录（config/models.json）。不自动检查。
 *
 * 这里放前后端和演示后端共用的结构和判定：查询记录的形状、哪些算「新模型」。
 */
import { z } from 'zod'
import { ModelCatalogEntry, normalizeModelId } from './catalog.ts'

export const ModelDiscoverJob = z.object({
  id: z.string(),
  status: z.enum(['running', 'done', 'failed']),
  /** Agent 的说明（JSON 前面的部分），跑的过程中是最近的输出，给界面显示进度 */
  text: z.string(),
  /** 目录里还没有的模型，界面让用户勾选后再加 */
  candidates: z.array(ModelCatalogEntry),
  /** Agent 查到、但目录里已经有的个数：界面说「其余 n 个已在目录里」 */
  known: z.number().int(),
  error: z.string().optional(),
  startedAt: z.number(),
})
export type ModelDiscoverJob = z.infer<typeof ModelDiscoverJob>

/** 同厂商同 id 算同一条（补充目录覆盖内置目录也按这个） */
export const catalogKey = (m: { vendor: string; id: string }) => `${m.vendor.toLowerCase()}:${m.id.toLowerCase()}`

/**
 * 从 Agent 查到的模型里挑出目录里还没有的：同厂商同 id、写法只差后缀（日期、preview、协议）、
 * 或是目录里某条的别名，都算已经有了。查到的列表里重复的只留第一条
 */
export function newModelCandidates(found: ModelCatalogEntry[], known: ModelCatalogEntry[]) {
  const names = new Set<string>()
  for (const k of known) {
    const vendor = k.vendor.toLowerCase()
    for (const n of [k.id, ...k.aliases]) {
      names.add(`${vendor}:${n.toLowerCase()}`)
      names.add(`${vendor}:${normalizeModelId(n).canonical}`)
    }
  }
  const out: ModelCatalogEntry[] = []
  let already = 0
  for (const f of found) {
    const vendor = f.vendor.toLowerCase()
    const keys = [`${vendor}:${f.id.toLowerCase()}`, `${vendor}:${normalizeModelId(f.id).canonical}`]
    if (keys.some((k) => names.has(k))) {
      already++
      continue
    }
    keys.forEach((k) => names.add(k))
    out.push(f)
  }
  return { candidates: out, known: already }
}

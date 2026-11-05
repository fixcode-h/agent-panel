/**
 * Chat 模式的「关于我」和跨对话记忆（设计报告 Chat P1-4，用户 2026-11-04 定要做）：
 * 每个 Chat 对话都从一个空目录开始，偏好每次都要重说。这里存两样，每个 Chat 对话的提示词都带上（shared/chat-prompt.ts）：
 * - about：用户自己在设置里写的「关于我 / 回复偏好」；
 * - items：模型在 Chat 里用 remember 工具记下的长期偏好和事实，用户在设置里能看、能删。
 * 只给 Chat 模式：项目里的对话有项目说明文件和项目教训，不混进个人记忆。
 * 存在数据目录的 chat-memory.json，不进任何项目、不进仓库
 */
import path from 'node:path'
import { randomUUID } from 'node:crypto'
import { Hono } from 'hono'
import { z } from 'zod'
import { DATA_DIR, readJson, writeJsonAtomic } from './store.ts'
import { t } from '../shared/i18n.ts'

/** 记忆最多这么多条、每条这么多字：都要进每个 Chat 对话的提示词，不能无限长 */
export const MEMORY_MAX = 50
export const MEMORY_TEXT_MAX = 300
export const ABOUT_MAX = 4000

export const MemoryItem = z.object({ id: z.string(), text: z.string(), at: z.string() })
export type MemoryItem = z.infer<typeof MemoryItem>
const MemoryFile = z.object({
  about: z.string().default(''),
  items: z.array(MemoryItem).default([]),
})
export type ChatMemory = z.infer<typeof MemoryFile>

const FILE = () => path.join(DATA_DIR, 'chat-memory.json')

export async function readChatMemory(): Promise<ChatMemory> {
  const p = MemoryFile.safeParse((await readJson(FILE()).catch(() => null)) ?? {})
  return p.success ? p.data : { about: '', items: [] }
}

/** 读、改、写串行：两个对话同时 remember 时不能互相覆盖 */
let chain: Promise<unknown> = Promise.resolve()
function mutate<R>(fn: (m: ChatMemory) => R): Promise<R> {
  const run = chain.then(async () => {
    const m = await readChatMemory()
    const r = fn(m)
    await writeJsonAtomic(FILE(), m)
    return r
  })
  chain = run.catch(() => {})
  return run
}

/**
 * 记一条（remember 工具、设置里手动加）：一样的不重复记；满了先丢最早的一条，交回给模型的话里说明
 */
export function remember(text: string): Promise<{ ok: boolean; info: string }> {
  const v = text.trim().replace(/\s+/g, ' ')
  if (!v) return Promise.resolve({ ok: false, info: '要记的内容是空的。' })
  if (v.length > MEMORY_TEXT_MAX)
    return Promise.resolve({
      ok: false,
      info: `一条最多 ${MEMORY_TEXT_MAX} 字：只记长期有用的一句话，不要整段抄对话。`,
    })
  return mutate((m) => {
    if (m.items.some((x) => x.text === v)) return { ok: true, info: '这条已经记过了。' }
    const dropped = m.items.length >= MEMORY_MAX ? m.items.shift() : undefined
    m.items.push({ id: randomUUID(), text: v, at: new Date().toISOString() })
    return {
      ok: true,
      info: dropped
        ? `记下了。记忆满了（${MEMORY_MAX} 条），丢掉了最早的一条：${dropped.text}`
        : '记下了，之后的 Chat 对话都会带上。',
    }
  })
}

/** 用户在设置里删掉一条，或者模型发现记错了（remember 的 forget）：按 id 或原文删 */
export function forget(key: string): Promise<boolean> {
  return mutate((m) => {
    const n = m.items.length
    m.items = m.items.filter((x) => x.id !== key && x.text !== key.trim())
    return m.items.length < n
  })
}

/** 交给这一轮的「关于我」、记忆和 remember（EngineHost.chatMemory）；读不到时当成空的，不挡对话 */
export async function chatMemoryFor() {
  const m = await readChatMemory().catch(() => ({ about: '', items: [] as MemoryItem[] }))
  return {
    about: m.about,
    items: m.items.map((x) => x.text),
    remember: async (text: string, drop?: boolean) =>
      drop
        ? (await forget(text))
          ? { ok: true, info: '删掉了。' }
          : { ok: false, info: '没找到这一条：text 要和记下的原文一样。' }
        : remember(text),
  }
}

export function chatMemoryApi() {
  return new Hono()
    .get('/', async (c) => c.json(await readChatMemory()))
    .put('/about', async (c) => {
      const p = z.object({ about: z.string().max(ABOUT_MAX) }).safeParse(await c.req.json().catch(() => ({})))
      if (!p.success) return c.json({ error: t('「关于我」最多 {n} 字', { n: ABOUT_MAX }) }, 400)
      await mutate((m) => void (m.about = p.data.about.trim()))
      return c.json(await readChatMemory())
    })
    .post('/items', async (c) => {
      const { text } = (await c.req.json().catch(() => ({}))) as { text?: string }
      const r = await remember(String(text ?? ''))
      if (!r.ok) return c.json({ error: r.info }, 400)
      return c.json(await readChatMemory())
    })
    .delete('/items/:id', async (c) => {
      await forget(c.req.param('id'))
      return c.json(await readChatMemory())
    })
}

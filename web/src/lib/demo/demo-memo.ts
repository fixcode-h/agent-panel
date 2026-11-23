/**
 * 演示：数据页的「缓存」一节（ADR 0074）。演示没有真的缓存，列几份典型的（面板和 UE 插件的），清空就把项数归零
 */
import type { MemoOverview } from '@shared/api-contract/memo'

const caches = new Map<string, number>([
  ['cli.commands', 1],
  ['session-bar.skills', 2],
  ['slash.commands', 2],
  ['ue.class-files', 1],
  ['ue.class-headers', 1],
  ['ue.class-tree', 2],
  ['ue.forge-installed', 1],
  ['ue.unlua-detect', 1],
]) // 演示的缓存只在这一页里

const overview = (): MemoOverview => ({
  caches: [...caches].map(([name, size]) => ({ name, size })),
  watches: 14,
})

export function demoMemo(method: string, sub: string | undefined, body: unknown) {
  if (method === 'POST' && sub === 'clear') {
    const name = (body as { name?: string } | undefined)?.name
    for (const k of caches.keys()) if (!name || k === name) caches.set(k, 0)
  }
  return overview()
}

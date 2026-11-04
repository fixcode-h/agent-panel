import { mergeItems, pageOf, sortItems, type GalleryItem, type GallerySort } from '@shared/cli-gallery'
import { npmName } from '@shared/cli-spec'

/**
 * 在线演示里 CLI 的插件（扩展包）和插件市场（ADR 0050）：内存里记着已装的，装、删都直接成功；
 * 市场是一份写死的小样本，按真实接口一样排序、翻页（演示不联网）
 */
const demoPackages = ['npm:cc-safety-net@2.7.1', 'git:github.com/example/pi-review@v1']
const VERSIONS: Record<string, string> = { 'cc-safety-net': '2.7.1' }
const LATEST: Record<string, string> = { 'cc-safety-net': '2.8.0' }

const item = (name: string, desc: string, monthly: number, days: number, extra: Partial<GalleryItem> = {}) =>
  ({
    name,
    source: `npm:${name}`,
    version: '1.0.0',
    desc,
    publisher: 'demo',
    date: new Date(Date.now() - days * 86_400_000).toISOString(),
    monthly,
    weekly: Math.round(monthly / 3.5),
    dependents: Math.round(monthly / 30_000),
    npmUrl: `https://www.npmjs.com/package/${name}`,
    repoUrl: `https://github.com/example/${name.replace(/^@[^/]+\//, '')}`,
    types: ['扩展'],
    keywords: ['pi-package', 'pi-extension'],
    insecure: false,
    ...extra,
  }) satisfies GalleryItem

const GALLERY: GalleryItem[] = mergeItems([
  [
    item('pi-web-access', 'Web search, URL fetching, GitHub repo cloning, PDF extraction', 1_116_299, 6),
    item('pi-mcp-adapter', 'MCP adapter for Pi coding agent', 1_369_862, 0),
    item('pi-subagents', 'Delegate tasks to subagents with chains and parallel execution', 726_352, 6),
    item('cc-safety-net', 'Blocks destructive git and filesystem commands before execution', 110_402, 12),
    item('pi-lens', 'Real-time code feedback: LSP, linters, formatters, type checking', 92_000, 3),
    item('@narumitw/pi-lsp', 'Language server diagnostics for edited files', 41_200, 20),
    item('pi-web-search', "Web search through the model provider's own search", 71_036, 27),
    item('pi-memory', 'Long-term memory with daily logs and search', 38_000, 9, { repoUrl: '', types: [] }),
  ],
])

/** /clis/:id/packages、/clis/:id/packages/latest、/clis/:id/gallery；不是这几个时返回 undefined */
export function demoCliPackages(
  sub: string | undefined,
  rest: string | undefined,
  method: string,
  body: unknown,
  query: URLSearchParams,
): unknown {
  const list = () => demoPackages.map((x) => ({ source: x, target: x, version: VERSIONS[npmName(x)] }))
  if (sub === 'packages' && rest === 'latest') return LATEST
  if (sub === 'packages') {
    if (method === 'POST') {
      const b = (body ?? {}) as { action?: string; source?: string }
      const source = String(b.source ?? '').trim()
      if (b.action === 'install' && source && !demoPackages.includes(source)) demoPackages.push(source)
      if (b.action === 'remove' && demoPackages.includes(source)) demoPackages.splice(demoPackages.indexOf(source), 1)
      const output =
        b.action === 'install' ? `Installed ${source}` : b.action === 'remove' ? `Removed ${source}` : 'Up to date'
      return { ok: true, output, packages: list() }
    }
    return list()
  }
  if (sub === 'gallery') {
    const q = (query.get('q') ?? '').toLowerCase()
    const hit = q ? GALLERY.filter((x) => `${x.name} ${x.desc}`.toLowerCase().includes(q)) : GALLERY
    const sorted = sortItems(hit, (query.get('sort') || 'monthly') as GallerySort)
    return { ...pageOf(sorted, Number(query.get('page')) || 1), at: new Date(Date.now() - 12 * 60_000).toISOString() }
  }
  return undefined
}

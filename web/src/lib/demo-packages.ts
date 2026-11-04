import { mergeItems, pageOf, sortItems, type GalleryItem, type GallerySort } from '@shared/cli-gallery'
import { npmName } from '@shared/cli-spec'

/**
 * 在线演示里 CLI 的插件（扩展包）和插件市场（ADR 0050）：内存里记着已装的，装、删都直接成功；
 * 市场是一份写死的小样本，按真实接口一样排序、翻页（演示不联网）
 */
const demoPackages = ['npm:cc-safety-net@2.7.1', 'git:github.com/example/pi-review@v1']
const VERSIONS: Record<string, string> = { 'cc-safety-net': '2.7.1' }
/** 演示里插件的更新说明：点「更新」后版本升到 2.8.0，展开这次新增的那一条 */
const CHANGELOG: Record<string, { version: string; body: string }[]> = {
  'cc-safety-net': [
    { version: '2.8.0', body: '- 拦截 `git clean -fdx`\n- 读 `.env.local` 也算读机密文件' },
    { version: '2.7.1', body: '- 修复 Windows 路径里的反斜杠被当成转义' },
    { version: '2.7.0', body: '- 新增对 `rm -rf ~` 的拦截' },
  ],
}
const LATEST: Record<string, string> = { 'cc-safety-net': '2.8.0' }
const demoConfig: Record<string, boolean | number | string> = { retryMax: 5 }

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

/** /clis/:id/packages、/clis/:id/packages/latest、/clis/:id/gallery、/clis/:id/config；不是这几个时返回 undefined */
export function demoCliPackages(
  sub: string | undefined,
  rest: string | undefined,
  method: string,
  body: unknown,
  query: URLSearchParams,
): unknown {
  const list = () => demoPackages.map((x) => ({ source: x, target: x, version: VERSIONS[npmName(x)] }))
  if (sub === 'packages' && rest === 'latest') return LATEST
  if (sub === 'packages' && rest === 'changelog') return CHANGELOG[npmName(query.get('source') ?? '')] ?? null
  if (sub === 'packages') {
    if (method === 'POST') {
      const b = (body ?? {}) as { action?: string; source?: string }
      const source = String(b.source ?? '').trim()
      if (b.action === 'install' && source && !demoPackages.includes(source)) demoPackages.push(source)
      if (b.action === 'remove' && demoPackages.includes(source)) demoPackages.splice(demoPackages.indexOf(source), 1)
      if (b.action === 'update' && VERSIONS[npmName(source)]) VERSIONS[npmName(source)] = LATEST[npmName(source)]
      const output =
        b.action === 'install' ? `Installed ${source}` : b.action === 'remove' ? `Removed ${source}` : 'Up to date'
      return { ok: true, output, packages: list() }
    }
    return list()
  }
  // CLI 自己的配置项：演示里记在内存，改了就生效
  if (sub === 'config') {
    if (method === 'PUT') {
      const b = (body ?? {}) as { id?: string; value?: unknown }
      if (b.value === null || b.value === undefined) delete demoConfig[String(b.id)]
      else demoConfig[String(b.id)] = b.value as boolean | number | string
    }
    return { values: { ...demoConfig }, error: '' }
  }
  if (sub === 'gallery') {
    const q = (query.get('q') ?? '').toLowerCase()
    const hit = q ? GALLERY.filter((x) => `${x.name} ${x.desc}`.toLowerCase().includes(q)) : GALLERY
    const sorted = sortItems(hit, (query.get('sort') || 'monthly') as GallerySort)
    return { ...pageOf(sorted, Number(query.get('page')) || 1), at: new Date(Date.now() - 12 * 60_000).toISOString() }
  }
  return undefined
}

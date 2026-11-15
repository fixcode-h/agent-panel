import type { WrapCandidate, WrapMcp, WrapRecipeInput } from '../../../shared/plugins/wrap/recipe.ts'

/**
 * 识别器（ADR 0068，设计稿第 4 节）：只读下载下来的文件，认出仓库里能装进面板的东西——技能集、Claude Code 插件、
 * MCP 服务、命令行工具、网页应用。分析阶段零执行：这里不起任何进程、不联网（Release 信息由调用方先读好传进来）。
 * 每一项给出置信度和说明，并带一段配方片段；用户在预览里勾哪几项，就把哪几项的片段合成配方（buildRecipe）。
 */

export interface RepoFile {
  /** 相对仓库根，用 / 分隔 */
  path: string
  data: Buffer
}

/** 预先读好的 Release（命令行工具的二进制附件用） */
export interface ReleaseInfo {
  tag: string
  assets: { name: string; sha256: string }[]
}

/** 识别结果的一项：界面那一行 + 选上时并进配方的片段 */
export interface Detected extends WrapCandidate {
  fragment: Partial<WrapRecipeInput>
}

/** 不是给用户用的目录：示例、测试、文档站、官网源码。里面的 SKILL.md、package.json 不算 */
// 模块状态：常量，加载后不改
const SIDE_DIRS = new Set([
  'example',
  'examples',
  'test',
  'tests',
  '__tests__',
  'fixtures',
  'docs',
  'doc',
  'website',
  'site',
  'demo',
  'demos',
  'benchmarks',
  'node_modules',
  '.github',
])
const sideOf = (p: string) =>
  p
    .split('/')
    .slice(0, -1)
    .find((s) => SIDE_DIRS.has(s.toLowerCase()))

const text = (f?: RepoFile) => (f ? f.data.toString('utf8') : '')
const dirOf = (p: string) => (p.includes('/') ? p.slice(0, p.lastIndexOf('/')) : '.')
const baseOf = (p: string) => p.split('/').filter(Boolean).pop() ?? ''
const join = (dir: string, rel: string) => (dir === '.' ? rel : `${dir}/${rel}`)
const slug = (s: string) =>
  s
    .toLowerCase()
    .replace(/^@[^/]+\//, '')
    .replace(/[^a-z0-9-]+/g, '-')
    .replace(/^-+|-+$/g, '')
    .slice(0, 40) || 'wrapped'

/** SKILL.md / 命令 md 开头 front matter 里的一个字段 */
export function frontMatter(md: string, key: string) {
  const m = /^---\r?\n([\s\S]*?)\r?\n---/.exec(md.replace(/^﻿/, ''))
  if (!m) return ''
  const line = new RegExp(`^${key}:\\s*(.*)$`, 'm').exec(m[1])
  return (line?.[1] ?? '').trim().replace(/^["']|["']$/g, '')
}

type Pkg = {
  name?: string
  version?: string
  private?: boolean
  bin?: string | Record<string, string>
  scripts?: Record<string, string>
  dependencies?: Record<string, string>
  devDependencies?: Record<string, string>
}
const readPkg = (f?: RepoFile): Pkg | null => {
  try {
    return f ? (JSON.parse(text(f)) as Pkg) : null
  } catch {
    return null
  }
}
const deps = (p: Pkg) => ({ ...p.dependencies, ...p.devDependencies })
/** 发到 npm 上的包：有名字和正式版本号、没标 private */
const published = (p: Pkg | null): p is Pkg & { name: string; version: string } =>
  !!p?.name && !!p.version && !p.private && /^\d+\.\d+\.\d+/.test(p.version)

/** pyproject.toml 里 [project] 的 name / version / 有没有 scripts / 依赖里有没有某个包 */
function readPyproject(src: string) {
  const sec = /^\[project\]\s*$([\s\S]*?)(?=^\[|(?![\s\S]))/m.exec(src)?.[1] ?? ''
  const field = (k: string) => new RegExp(`^\\s*${k}\\s*=\\s*"([^"]*)"`, 'm').exec(sec)?.[1] ?? ''
  return {
    name: field('name') || '',
    version: field('version') || '',
    scripts: /^\[project\.scripts\]/m.test(src),
    has: (dep: string) => new RegExp(`["']${dep}(?:[<>=!~\\[ ]|["'])`, 'i').test(src),
  }
}

/** 技能集：SKILL.md 所在目录（.claude/skills 下的也算），示例、文档目录里的不算 */
function skills(files: RepoFile[], repoName: string): Detected[] {
  const out: Detected[] = []
  for (const f of files) {
    if (baseOf(f.path) !== 'SKILL.md') continue
    const dir = dirOf(f.path)
    const side = sideOf(f.path)
    const md = text(f)
    const name = slug(frontMatter(md, 'name') || (dir === '.' ? repoName : baseOf(dir)))
    out.push({
      key: `skill:${dir}`,
      kind: 'skills',
      path: f.path,
      confidence: side ? 0.2 : 0.95,
      reason: side
        ? `在 ${side}/ 下，像是示例`
        : `装成插件技能，各 CLI 共用一份（~/.agents/skills/${name}）；什么时候用照 SKILL.md 的说明。`,
      ...(side && { skip: '示例里的' }),
      fragment: { skills: [{ from: dir, category: 'wrapped', name }] },
    })
  }
  return out
}

/** 技能目录里自带的 Node 命令行（archify 的 bin/archify.mjs）：跟技能放一起，不另装 */
function skillBins(files: RepoFile[], skillDirs: string[]): Detected[] {
  const out: Detected[] = []
  for (const dir of skillDirs) {
    const prefix = dir === '.' ? '' : `${dir}/`
    const bin = files.find((f) => f.path.startsWith(`${prefix}bin/`) && /\.(?:m?js|cjs)$/.test(f.path))
    if (!bin) continue
    const pkg = readPkg(files.find((f) => f.path === `${prefix}package.json`))
    const zeroDep = !pkg || !Object.keys(pkg.dependencies ?? {}).length
    out.push({
      key: `cli-in-skill:${dir}`,
      kind: 'cli',
      path: bin.path,
      confidence: 0.9,
      tag: '跟技能一起',
      reason: zeroDep
        ? '没有要装的依赖：跟技能放在一起，技能里的命令直接能跑。'
        : '跟技能放在一起；依赖用 npm ci --ignore-scripts 装进技能目录，不跑上游的安装脚本。',
      fragment: zeroDep ? {} : { install: [{ kind: 'npm-ci', dir }] },
    })
  }
  return out
}

/** Claude Code 插件：.claude-plugin/plugin.json 旁边的 commands、agents、.mcp.json；钩子只列出来不搬 */
function claudePlugin(files: RepoFile[]): Detected[] {
  const mark = files.find((f) => /^(?:[^/]+\/)?\.claude-plugin\/(?:plugin|marketplace)\.json$/.test(f.path))
  if (!mark) return []
  const root = mark.path.includes('/.claude-plugin/') ? mark.path.split('/.claude-plugin/')[0] : '.'
  const under = (sub: string) => files.filter((f) => f.path.startsWith(join(root, sub) + '/') && f.path.endsWith('.md'))
  const out: Detected[] = []
  const cmds = under('commands')
  if (cmds.length)
    out.push({
      key: 'claude:commands',
      kind: 'claude-plugin',
      path: join(root, 'commands/'),
      confidence: 0.9,
      tag: `${cmds.length} 个`,
      reason: '命令 md 变成面板的「/」命令，对哪个 CLI 都能用。',
      fragment: {
        commands: cmds.map((f) => ({
          from: f.path,
          name: baseOf(f.path)
            .replace(/\.md$/, '')
            .replace(/[^\w:.-]/g, '-'),
        })),
      },
    })
  const agents = under('agents')
  if (agents.length)
    out.push({
      key: 'claude:agents',
      kind: 'claude-plugin',
      path: join(root, 'agents/'),
      confidence: 0.85,
      tag: `${agents.length} 个`,
      reason: '子代理 md 变成面板的角色。',
      fragment: {
        agents: agents.map((f) => ({
          from: f.path,
          name: frontMatter(text(f), 'name') || baseOf(f.path).replace(/\.md$/, ''),
        })),
      },
    })
  const mcpFile = files.find((f) => f.path === join(root, '.mcp.json'))
  for (const m of mcpFile ? mcpFromConfig(text(mcpFile)) : [])
    out.push({
      key: `mcp:${m.name}`,
      kind: 'mcp',
      path: mcpFile!.path,
      confidence: 0.8,
      reason: `外部 MCP 服务 ${m.name}：${m.command || m.url} ${m.args.join(' ')}`.trim(),
      fragment: { mcp: [m] },
    })
  const hooks = files.find((f) => f.path === join(root, 'hooks/hooks.json'))
  if (hooks)
    out.push({
      key: 'claude:hooks',
      kind: 'claude-plugin',
      path: hooks.path,
      confidence: 0.1,
      skip: '钩子不自动搬',
      reason: 'Claude Code 专属的钩子格式和面板钩子不一样，看过后可以在设置 →「钩子」里自己加。',
      fragment: {},
    })
  return out
}

/** { mcpServers: { name: { command, args, env } | { url } } }：.mcp.json 和 README 里的配置片段都是这个形状 */
export function mcpFromConfig(src: string): WrapMcp[] {
  let raw: unknown
  try {
    raw = JSON.parse(src)
  } catch {
    return []
  }
  const servers = (raw as { mcpServers?: Record<string, Record<string, unknown>> })?.mcpServers ?? {}
  const out: WrapMcp[] = []
  for (const [name, s] of Object.entries(servers)) {
    if (!/^[A-Za-z0-9][\w-]*$/.test(name) || !s || typeof s !== 'object') continue
    const args = Array.isArray(s.args) ? s.args.filter((a): a is string => typeof a === 'string') : []
    const env = Object.fromEntries(
      Object.entries((s.env as Record<string, unknown>) ?? {}).filter(
        (e): e is [string, string] => typeof e[1] === 'string',
      ),
    )
    if (typeof s.command === 'string')
      out.push({ name, transport: 'stdio', command: s.command, args, env, url: '', headers: {} })
    else if (typeof s.url === 'string')
      out.push({ name, transport: 'http', command: '', url: s.url, args: [], env, headers: {} })
  }
  return out
}

/** README 里 ```json 代码块中的 mcpServers 片段：最常见的「用 npx foo-mcp 启动」 */
function readmeMcp(files: RepoFile[]): WrapMcp[] {
  const readme = files.find((f) => /^readme(?:\.[a-z]+)?$/i.test(f.path))
  if (!readme) return []
  for (const m of text(readme).matchAll(/```(?:json|jsonc)?\s*\n([\s\S]*?)```/g)) {
    if (!m[1].includes('mcpServers')) continue
    const found = mcpFromConfig(m[1].replace(/\/\/.*$/gm, ''))
    if (found.length) return found
  }
  return []
}

/** MCP 服务：优先用发布的包（npx / uvx 固定版本），不装源码 */
function mcpServers(files: RepoFile[], repoName: string): Detected[] {
  const pkg = readPkg(files.find((f) => f.path === 'package.json'))
  const py = readPyproject(text(files.find((f) => f.path === 'pyproject.toml')))
  const reg = files.find((f) => f.path === 'server.json')
  const name = slug(repoName.replace(/-?mcp-?/i, '') || repoName)
  if (pkg && published(pkg) && ('@modelcontextprotocol/sdk' in deps(pkg) || /mcp/i.test(pkg.name)))
    return [
      {
        key: `mcp:npm:${pkg.name}`,
        kind: 'mcp',
        path: 'package.json',
        confidence: '@modelcontextprotocol/sdk' in deps(pkg) ? 0.9 : 0.6,
        tag: '发布的包',
        reason: `用 npx 跑发布的 ${pkg.name}@${pkg.version}，不装源码。`,
        fragment: {
          mcp: [
            {
              name,
              transport: 'stdio',
              command: 'npx',
              args: ['-y', `${pkg.name}@${pkg.version}`],
              env: {},
              url: '',
              headers: {},
            },
          ],
        },
      },
    ]
  if (py.name && py.version && (py.has('mcp') || py.has('fastmcp')))
    return [
      {
        key: `mcp:pypi:${py.name}`,
        kind: 'mcp',
        path: 'pyproject.toml',
        confidence: 0.85,
        tag: '发布的包',
        reason: `用 uvx 跑发布的 ${py.name}==${py.version}，不装源码。`,
        fragment: {
          mcp: [
            {
              name,
              transport: 'stdio',
              command: 'uvx',
              args: [`${py.name}==${py.version}`],
              env: {},
              url: '',
              headers: {},
            },
          ],
        },
      },
    ]
  if (reg) {
    try {
      const r = JSON.parse(text(reg)) as {
        packages?: {
          registry_name?: string
          registryType?: string
          name?: string
          identifier?: string
          version?: string
        }[]
      }
      const p = r.packages?.[0]
      const id = p?.identifier ?? p?.name
      const kind = p?.registryType ?? p?.registry_name
      if (id && p?.version && (kind === 'npm' || kind === 'pypi'))
        return [
          {
            key: `mcp:registry:${id}`,
            kind: 'mcp',
            path: 'server.json',
            confidence: 0.85,
            tag: '发布的包',
            reason: `MCP 注册表清单：${id}@${p.version}`,
            fragment: {
              mcp: [
                kind === 'npm'
                  ? {
                      name,
                      transport: 'stdio',
                      command: 'npx',
                      args: ['-y', `${id}@${p.version}`],
                      env: {},
                      url: '',
                      headers: {},
                    }
                  : {
                      name,
                      transport: 'stdio',
                      command: 'uvx',
                      args: [`${id}==${p.version}`],
                      env: {},
                      url: '',
                      headers: {},
                    },
              ],
            },
          },
        ]
    } catch {
      /* 格式不对就当没有 */
    }
  }
  return readmeMcp(files).map((m) => ({
    key: `mcp:${m.name}`,
    kind: 'mcp' as const,
    path: 'README',
    confidence: 0.6,
    tag: 'README 里的配置',
    reason: `照 README 里的配置起：${[m.command || m.url, ...m.args].join(' ')}`,
    fragment: { mcp: [m] },
  }))
}

/** 「怎么用」技能：命令行工具没有自己的技能时生成一份（见 generate.ts） */
export const CLI_SKILL = 'usage'

/** 当前机器对应的 Release 附件：名字里带系统和架构 */
export function pickAsset(assets: ReleaseInfo['assets'], platform = process.platform, arch = process.arch) {
  const os = { win32: /win(?:dows)?|msvc|\.exe$/i, darwin: /darwin|mac(?:os)?|apple/i, linux: /linux/i }[
    platform as 'win32' | 'darwin' | 'linux'
  ]
  const cpu = arch === 'arm64' ? /arm64|aarch64/i : /x86_64|amd64|x64/i
  if (!os) return undefined
  return assets.find((a) => os.test(a.name) && cpu.test(a.name) && !/\.(?:sha256|sig|asc|txt|sbom|json)$/i.test(a.name))
}

/** 命令行工具：npm 的 bin、Python 的 [project.scripts]、Go / Rust 的 Release 二进制 */
function clis(files: RepoFile[], release?: ReleaseInfo): Detected[] {
  const pkg = readPkg(files.find((f) => f.path === 'package.json'))
  if (pkg?.bin && published(pkg) && !('@modelcontextprotocol/sdk' in deps(pkg)))
    return [
      {
        key: `cli:npm:${pkg.name}`,
        kind: 'cli',
        path: 'package.json',
        confidence: 0.8,
        tag: '发布的包',
        reason: `装发布的 ${pkg.name}@${pkg.version} 到插件目录（npm ci --ignore-scripts），PATH 里加上它的命令。`,
        fragment: {
          install: [{ kind: 'npm-package', package: pkg.name, version: pkg.version }],
          path: ['cli/node_modules/.bin'],
        },
      },
    ]
  const py = readPyproject(text(files.find((f) => f.path === 'pyproject.toml')))
  if (py.scripts && py.name && py.version)
    return [
      {
        key: `cli:pypi:${py.name}`,
        kind: 'cli',
        path: 'pyproject.toml',
        confidence: 0.75,
        tag: '发布的包',
        reason: `用 uv 把 ${py.name}==${py.version} 装进插件目录，PATH 里加上它的命令。`,
        fragment: { install: [{ kind: 'uv-tool', package: py.name, version: py.version }], path: ['.tools/bin'] },
      },
    ]
  const compiled = files.some((f) => f.path === 'go.mod' || f.path === 'Cargo.toml')
  if (compiled) {
    const asset = release && pickAsset(release.assets)
    return [
      {
        key: 'cli:release',
        kind: 'cli',
        path: compiled && files.some((f) => f.path === 'go.mod') ? 'go.mod' : 'Cargo.toml',
        confidence: asset?.sha256 ? 0.7 : 0.2,
        tag: 'Release 附件',
        ...(!asset ? { skip: '没有这台机器能用的 Release 附件' } : !asset.sha256 && { skip: 'Release 附件没有校验和' }),
        reason: asset
          ? `下载 ${release!.tag} 的 ${asset.name}（核对 sha256），PATH 里加上它。`
          : '要从源码编译，包装器不做；可以等作者发 Release。',
        fragment:
          asset?.sha256 && release
            ? {
                install: [
                  { kind: 'release-asset', tag: release.tag, asset: asset.name, sha256: asset.sha256, to: 'bin' },
                ],
                path: ['bin'],
              }
            : {},
      },
    ]
  }
  return []
}

const WEB_DEPS = ['vite', 'next', 'astro', 'nuxt', '@sveltejs/kit', 'react-scripts', 'webpack-dev-server']

/** 网页应用：带 dev / start / preview 的前端项目、根上的静态页；官网源码、Docker 只列出来 */
function webApps(files: RepoFile[]): Detected[] {
  const out: Detected[] = []
  for (const f of files) {
    if (baseOf(f.path) !== 'package.json' || f.path.includes('node_modules/')) continue
    const pkg = readPkg(f)
    if (!pkg || !WEB_DEPS.some((d) => d in deps(pkg))) continue
    const dir = dirOf(f.path)
    const side = sideOf(f.path) ?? (SIDE_DIRS.has(baseOf(dir).toLowerCase()) ? baseOf(dir) : undefined)
    const script = ['preview', 'start', 'dev'].find((s) => pkg.scripts?.[s])
    const framework = WEB_DEPS.find((d) => d in deps(pkg))!
    const needsBuild = script === 'preview' && !!pkg.scripts?.build
    out.push({
      key: `web:${dir}`,
      kind: 'web-app',
      path: dir === '.' ? './' : `${dir}/`,
      confidence: side ? 0.1 : script ? 0.5 : 0.2,
      ...(side ? { skip: '不是给你用的', tag: '跳过' } : !script && { skip: '没有能启动的脚本' }),
      reason: side
        ? `${framework} 写的${side === 'website' || side === 'site' ? '官网' : '文档'}源码，和用这个工具无关，不装。`
        : `${framework} 网页应用：装依赖${needsBuild ? '、构建' : ''}后由面板起停（npm run ${script ?? 'start'}），在面板里出一页。`,
      fragment:
        side || !script
          ? {}
          : {
              copy: [dir],
              install: [
                { kind: 'npm-ci', dir },
                ...(needsBuild ? [{ kind: 'npm-run' as const, dir, script: 'build' }] : []),
              ],
              services: [
                {
                  id: 'app',
                  command: 'npm',
                  args: ['run', script, '--', '--port', '{port}', '--host', '127.0.0.1'],
                  cwd: dir,
                  port: 'auto',
                  health: '/',
                  start: 'on-open',
                  stopAfterIdleMin: 30,
                },
              ],
              webPages: [
                {
                  id: 'app',
                  label: baseOf(dir === '.' ? '' : dir) || 'App',
                  icon: 'app-window',
                  url: 'service:app/',
                  scope: 'project',
                },
              ],
            },
    })
  }
  const index = files.find((f) => f.path === 'index.html')
  if (index && !out.some((d) => d.path === './'))
    out.push({
      key: 'web:static',
      kind: 'web-app',
      path: 'index.html',
      confidence: 0.4,
      tag: '静态页',
      reason: '根上的静态网页：原样复制，在面板里出一页（沙箱里打开，碰不到面板）。',
      fragment: {
        copy: ['.'],
        webPages: [{ id: 'app', label: 'App', icon: 'app-window', url: 'file:index.html', scope: 'global' }],
      },
    })
  if (
    files.some((f) => /^(?:Dockerfile|docker-compose\.ya?ml|compose\.ya?ml)$/.test(f.path)) &&
    !out.some((d) => !d.skip)
  )
    out.push({
      key: 'web:docker',
      kind: 'web-app',
      path: 'Dockerfile',
      confidence: 0.1,
      skip: '要用 Docker 跑',
      reason: '只提供了 Docker 跑法，包装器暂不支持。',
      fragment: {},
    })
  return out
}

/**
 * 认出仓库里的所有候选，按置信度排好。一个仓库常常同时是几种（archify 是「技能 + 命令行」），都列出来。
 * repoName 用来给没写名字的技能、MCP 服务起名
 */
export function detect(files: RepoFile[], repoName: string, release?: ReleaseInfo): Detected[] {
  const sk = skills(files, repoName)
  const skillDirs = sk.filter((d) => !d.skip).map((d) => d.key.slice('skill:'.length))
  const mcp = mcpServers(files, repoName)
  const all = [
    ...sk,
    ...skillBins(files, skillDirs),
    ...claudePlugin(files),
    // .claude-plugin 里的 .mcp.json 已经列过的同名服务不重复
    ...mcp,
    ...(mcp.length ? [] : clis(files, release)),
    ...webApps(files),
  ]
  const seen = new Set<string>()
  return all
    .filter((d) => (seen.has(d.key) ? false : (seen.add(d.key), true)))
    .sort((a, b) => Number(!!a.skip) - Number(!!b.skip) || b.confidence - a.confidence)
}

/** 默认勾哪些：没写跳过原因、置信度够的 */
export const defaultPicks = (list: WrapCandidate[]) =>
  list.filter((d) => !d.skip && d.confidence >= 0.5).map((d) => d.key)

/** 把勾上的几项的片段合成配方（数组字段拼起来，对象字段合并） */
export function buildRecipe(base: WrapRecipeInput, list: Detected[], picks: string[]): WrapRecipeInput {
  const out: Record<string, unknown> = { ...base }
  for (const d of list) {
    if (!picks.includes(d.key)) continue
    for (const [k, v] of Object.entries(d.fragment)) {
      const cur = out[k]
      if (Array.isArray(v)) out[k] = [...((cur as unknown[]) ?? []), ...v]
      else if (v && typeof v === 'object') out[k] = { ...(cur as object), ...v }
      else out[k] = v
    }
  }
  return out as WrapRecipeInput
}

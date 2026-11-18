import { test } from 'node:test'
import assert from 'node:assert/strict'
import { existsSync, mkdirSync, mkdtempSync, readFileSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import path from 'node:path'

// 数据目录和用户目录都换成临时的：store.ts 在模块顶层就算数据目录，不能碰真正的 ~/.agent-panel 和 ~/.claude
const home = mkdtempSync(path.join(tmpdir(), 'run-skills-home-'))
process.env.AGENT_PANEL_DATA = path.join(home, 'data')
process.env.HOME = home
process.env.USERPROFILE = home
for (const k of ['CLAUDE_CONFIG_DIR', 'CODEX_HOME', 'PI_CODING_AGENT_DIR']) delete process.env[k]

const { setSkillActivation } = await import('./activation.ts')
const { prepareRunSkills } = await import('./run-skills.ts')
const { isProjectSkill, projectSkillStore } = await import('./config.ts')
const { installBundled, sharedRoot } = await import('../bundled-skills.ts')
const { readLibrary } = await import('../library.ts')
const { getCli } = await import('../../shared/clis.ts')

const skillMd = (name: string, desc: string) => `---\nname: ${name}\ndescription: ${desc}\n---\n正文\n`

test('技能改成按项目：自己的技能挪进数据目录、自带的从用户目录撤掉，改回全局再挪回去', async () => {
  const own = path.join(home, '.claude/skills/my-skill')
  mkdirSync(own, { recursive: true })
  writeFileSync(path.join(own, 'SKILL.md'), skillMd('my-skill', '我自己的'))
  const r = await setSkillActivation({ name: 'my-skill', activation: 'project' })
  assert.deepEqual(r.moved, ['claude'])
  assert.ok(!existsSync(own), '用户目录里不再有，CLI 启动时读不到')
  assert.ok(existsSync(path.join(projectSkillStore('claude'), 'my-skill/SKILL.md')))
  assert.ok(isProjectSkill('my-skill'))
  // 技能库照样能看、能改：读写落到数据目录里那一份
  assert.match((await readLibrary('claude', 'skill', 'my-skill')).content, /我自己的/)

  // 自带技能：装过的副本撤掉，之后安装、补齐都跳过
  await installBundled(['grilling'], [], false)
  assert.ok(existsSync(path.join(sharedRoot(), 'grilling/SKILL.md')))
  const b = await setSkillActivation({ name: 'grilling', activation: 'project' })
  assert.deepEqual(b.removed, ['grilling'])
  assert.ok(!existsSync(path.join(sharedRoot(), 'grilling')))
  assert.deepEqual((await installBundled(['grilling'], [], true)).skipped, ['grilling'])

  const back = await setSkillActivation({ name: 'my-skill', activation: 'global' })
  assert.deepEqual(back.moved, ['claude'])
  assert.equal(readFileSync(path.join(own, 'SKILL.md'), 'utf8'), skillMd('my-skill', '我自己的'))
  await setSkillActivation({ name: 'my-skill', activation: 'project' })
})

test('每轮带技能：按 CLI 定义给参数或协议请求，没有 runSkills 的在提示里列路径', async () => {
  const claude = getCli('claude')!
  const r = await prepareRunSkills({ def: claude, projectId: 'p1', opened: ['my-skill', 'grilling'], roleSkills: [] })
  assert.deepEqual(r.names, ['grilling', 'my-skill'])
  assert.equal(r.args[0], '--add-dir')
  // Claude Code 从 --add-dir 目录下的 .claude/skills 读技能
  assert.ok(existsSync(path.join(r.args[1], '.claude/skills/my-skill/SKILL.md')))
  assert.ok(existsSync(path.join(r.args[1], '.claude/skills/grilling/SKILL.md')))
  assert.equal(r.note, '')

  // 关掉一个，下一轮目录里就没有了
  const r2 = await prepareRunSkills({ def: claude, projectId: 'p1', opened: ['grilling'], roleSkills: [] })
  assert.ok(!existsSync(path.join(r2.args[1], '.claude/skills/my-skill')))

  // Codex 走协议：开会话前告诉 app-server 技能目录
  const codex = await prepareRunSkills({ def: getCli('codex')!, projectId: 'p1', opened: ['grilling'], roleSkills: [] })
  assert.equal(codex.rpc?.method, 'skills/extraRoots/set')
  const roots = (codex.rpc!.params as { extraRoots: string[] }).extraRoots
  assert.ok(existsSync(path.join(roots[0], 'grilling/SKILL.md')))

  // 自定义 CLI 没写 runSkills：不加参数，提示里列出路径；角色点名的另说一句放在哪
  const plain = await prepareRunSkills({
    def: { id: 'mine', runSkills: undefined },
    projectId: 'p1',
    opened: [],
    roleSkills: ['grilling'],
  })
  assert.deepEqual(plain.args, [])
  assert.match(plain.note, /grilling.*SKILL\.md/)
  assert.match(plain.note, /grilling 这一轮放在/)

  // 项目没打开、角色也没点名、~/.agents/skills 里也没装：什么都不带
  assert.deepEqual((await prepareRunSkills({ def: claude, projectId: 'p2', opened: [], roleSkills: [] })).args, [])

  // Claude Code 不读 ~/.agents/skills：那里装着的全局技能也每轮带上（不然面板装的技能它一个都看不到）；
  // Codex 自己读那里，不重复带
  await installBundled(['brainstorming'], [], false)
  const g = await prepareRunSkills({ def: claude, projectId: 'p2', opened: [], roleSkills: [] })
  assert.deepEqual(g.names, ['brainstorming'])
  assert.ok(existsSync(path.join(g.args[1], '.claude/skills/brainstorming/SKILL.md')))
  const gx = await prepareRunSkills({ def: getCli('codex')!, projectId: 'p2', opened: [], roleSkills: [] })
  assert.deepEqual(gx.names, [])
})

test('插件带的技能装上就每轮带上：提示里列出用法和路径，按项目的插件只在打开了的项目里带', async () => {
  const { setPluginSkillSources } = await import('../bundled-skills.ts')
  const { setInstalledPlugins, setEnabledPlugins } = await import('../../shared/plugins/index.ts')
  const { pluginSkillsFor } = await import('./plugin-skills.ts')
  const { pluginSkillCommands } = await import('../plugins/contrib.ts')
  const plug = (id: string, skill: string) => {
    const dir = path.join(home, 'plugins', id)
    mkdirSync(path.join(dir, 'skills/diagram', skill), { recursive: true })
    writeFileSync(path.join(dir, 'skills/diagram', skill, 'SKILL.md'), skillMd(skill, `${skill} 画架构图`))
    return dir
  }
  setPluginSkillSources([
    { id: 'archify', dir: plug('archify', 'archify'), stamp: '1' },
    { id: 'ue', dir: plug('ue', 'ue-only'), stamp: '1' },
  ])
  setInstalledPlugins([
    { id: 'archify', name: 'Archify 架构图', activation: 'global', agents: [] },
    { id: 'ue', name: 'UE', activation: 'project', agents: [] },
  ] as never)
  setEnabledPlugins({ archify: { enabled: true }, ue: { enabled: true } } as never)

  // 按项目的插件：项目没打开它就不带
  const none = await pluginSkillsFor({ capabilities: {} })
  assert.deepEqual(
    none.map((p) => p.entry.name),
    ['archify'],
  )
  const both = await pluginSkillsFor({ capabilities: { plugins: ['ue'] } })
  assert.deepEqual(both.map((p) => p.entry.name).sort(), ['archify', 'ue-only'])

  const r = await prepareRunSkills({
    def: getCli('claude')!,
    projectId: 'p3',
    opened: [],
    roleSkills: [],
    plugins: none,
  })
  assert.ok(r.names.includes('archify'))
  assert.ok(existsSync(path.join(r.args[1], '.claude/skills/archify/SKILL.md')))
  assert.match(r.note, /装着的插件带的技能/)
  assert.match(r.note, /`archify`（插件「Archify 架构图」）：archify 画架构图/)
  assert.match(r.note, /\/名字 要求/)

  // 「/」菜单里也有它，由面板展开
  const cmds = await pluginSkillCommands()
  assert.deepEqual(
    cmds.map((c) => [c.name, c.kind]),
    [
      ['archify', 'skill'],
      ['ue-only', 'skill'],
    ],
  )

  // 已经装进 ~/.agents/skills 的：读那里的 CLI（Codex）不再另放一份，提示里指向那一份
  mkdirSync(path.join(sharedRoot(), 'archify'), { recursive: true })
  writeFileSync(path.join(sharedRoot(), 'archify/SKILL.md'), skillMd('archify', 'archify 画架构图'))
  const again = await pluginSkillsFor({ capabilities: {} })
  assert.equal(again[0].shared, true)
  const cx = await prepareRunSkills({
    def: getCli('codex')!,
    projectId: 'p3',
    opened: [],
    roleSkills: [],
    plugins: again,
  })
  assert.ok(!cx.names.includes('archify'))
  assert.ok(cx.note.includes(`${sharedRoot()}/archify/SKILL.md`))

  // 关掉插件：下一轮就不带了
  setEnabledPlugins({ archify: { enabled: false }, ue: { enabled: true } } as never)
  assert.deepEqual(await pluginSkillsFor({ capabilities: {} }), [])
})

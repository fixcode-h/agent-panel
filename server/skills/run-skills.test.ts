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
const { installBundled, bundledStore } = await import('../bundled-skills.ts')
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
  assert.ok(existsSync(path.join(bundledStore(), 'grilling/SKILL.md')))
  const b = await setSkillActivation({ name: 'grilling', activation: 'project' })
  assert.deepEqual(b.removed, ['grilling'])
  assert.ok(!existsSync(path.join(bundledStore(), 'grilling')))
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

  // 自定义 CLI 没写 runSkills：不加参数，提示里只列这一轮带的（角色自带的）技能和路径
  const plain = await prepareRunSkills({
    def: { id: 'mine', runSkills: undefined },
    projectId: 'p1',
    opened: [],
    roleSkills: ['grilling'],
  })
  assert.deepEqual(plain.args, [])
  assert.match(plain.note, /^## 这一轮带的技能/)
  assert.match(plain.note, /grilling.*SKILL\.md/)
  assert.ok(!plain.note.includes('my-skill'), '没点名的不列')

  // 项目没打开、角色也没点名：什么都不带
  assert.deepEqual((await prepareRunSkills({ def: claude, projectId: 'p2', opened: [], roleSkills: [] })).args, [])
})

test('启动时只带角色的技能：装着的自带技能不再整个带上，「每个对话都带」的当成角色自带（ADR 0083）', async () => {
  const claude = getCli('claude')!
  // 装进数据目录的自带技能：角色没点名就不带（以前 Claude Code 每轮连 ~/.agents/skills 整个带上）
  await installBundled(['brainstorming', 'project-vcs'], [], false)
  assert.ok(existsSync(path.join(bundledStore(), 'brainstorming/SKILL.md')))
  const none = await prepareRunSkills({ def: claude, projectId: 'p2', opened: [], roleSkills: [] })
  assert.deepEqual(none.names, [])
  assert.deepEqual(none.args, [])
  assert.ok(!claude.runSkills!.args.join(' ').includes('.agents'), 'Claude Code 不再加 ~/.agents/skills')

  // 角色点名的从数据目录复制进这一轮的目录
  const role = await prepareRunSkills({ def: claude, projectId: 'p2', opened: [], roleSkills: ['project-vcs'] })
  assert.deepEqual(role.names, ['project-vcs'])
  assert.ok(existsSync(path.join(role.args[1], '.claude/skills/project-vcs/SKILL.md')))
  assert.ok(!existsSync(path.join(role.args[1], '.claude/skills/brainstorming')))
  assert.equal(role.note, '')
  assert.equal(role.dir, path.join(role.args[1], '.claude/skills').replaceAll('\\', '/'))

  // 用户设成每个对话都带的：一起带上，提示里补一句（角色设定里没列它）
  const all = await prepareRunSkills({
    def: claude,
    projectId: 'p2',
    opened: [],
    roleSkills: ['project-vcs'],
    always: ['brainstorming', 'project-vcs'],
  })
  assert.deepEqual(all.names, ['brainstorming', 'project-vcs'])
  assert.match(all.note, /每个对话都按这些技能做：`brainstorming`，/)

  // 要带的不一样就分目录：同一个项目里不同角色的对话同时在跑，不会把对方正在用的那份换掉
  assert.notEqual(all.args[1], role.args[1])
  assert.ok(existsSync(path.join(role.args[1], '.claude/skills/project-vcs/SKILL.md')))
})

test('插件带的技能不再每轮带上：只进技能目录（由面板推正文）和「/」菜单，按项目的插件只在打开了的项目里算', async () => {
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

  // 按项目的插件：项目没打开它就不算
  const none = await pluginSkillsFor({ capabilities: {} })
  assert.deepEqual(
    none.map((p) => p.entry.name),
    ['archify'],
  )
  const both = await pluginSkillsFor({ capabilities: { plugins: ['ue'] } })
  assert.deepEqual(both.map((p) => p.entry.name).sort(), ['archify', 'ue-only'])

  // 开跑时不带：角色没点名的插件技能不进这一轮的目录
  const r = await prepareRunSkills({ def: getCli('claude')!, projectId: 'p3', opened: [], roleSkills: [] })
  assert.ok(!r.names.includes('archify'))
  // 角色点名了插件技能（挂载能力的技能）：照样带上
  const m = await prepareRunSkills({ def: getCli('claude')!, projectId: 'p3', opened: [], roleSkills: ['archify'] })
  assert.ok(existsSync(path.join(m.args[1], '.claude/skills/archify/SKILL.md')))

  // 「/」菜单里也有它，由面板展开
  const cmds = await pluginSkillCommands()
  assert.deepEqual(
    cmds.map((c) => [c.name, c.kind]),
    [
      ['archify', 'skill'],
      ['ue-only', 'skill'],
    ],
  )

  // 关掉插件：就不算了
  setEnabledPlugins({ archify: { enabled: false }, ue: { enabled: true } } as never)
  assert.deepEqual(await pluginSkillsFor({ capabilities: {} }), [])
})

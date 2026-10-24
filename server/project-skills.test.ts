import { test } from 'node:test'
import assert from 'node:assert/strict'
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import path from 'node:path'
import { setLang } from '../shared/i18n.ts'
import { projectSkillRepos, skillIssues, skillTemplate } from '../shared/project-skills.ts'
import {
  createProjectSkill,
  deleteProjectSkill,
  listProjectSkills,
  readProjectSkill,
  writeProjectSkill,
} from './project-skills.ts'

// 这里断言的是 project-skills.ts 里 t() 出来的报错文案：显式固定语言，不跟着 LANG 走
// （CI 上是英文，断言的中文原文就成了「“commit-style” already exists」这类英文）
setLang('zh')

/** 临时项目目录：里面放 .agents/skills 和 .claude/skills 两份技能 */
function project() {
  const root = mkdtempSync(path.join(tmpdir(), 'project-skills-'))
  const skill = (repo: string, name: string, content: string) => {
    mkdirSync(path.join(root, repo, name), { recursive: true })
    writeFileSync(path.join(root, repo, name, 'SKILL.md'), content)
  }
  return { root, skill }
}

const good = (name: string, description = '按团队约定写提交说明，先看改动再写') =>
  `---\nname: ${name}\ndescription: ${description}\n---\n\n先看 git diff，再按格式写。\n`

test('项目技能：列出各 CLI 定义里的项目目录，共用目录合成一项', () => {
  const repos = projectSkillRepos()
  const agents = repos.find((r) => r.dir === '.agents/skills')
  assert.ok(agents, '应该有 .agents/skills')
  assert.ok(agents.clis.length > 1, '.agents/skills 由几个 Agent 共用')
  assert.ok(repos.some((r) => r.dir === '.claude/skills'))
  // 同一个目录只出现一次
  assert.equal(new Set(repos.map((r) => r.dir)).size, repos.length)
})

test('项目技能：扫描 .agents/skills 和 .claude/skills，带出名字、说明、来源和问题', async () => {
  const { root, skill } = project()
  try {
    skill('.agents/skills', 'release-notes', good('release-notes'))
    skill('.claude/skills', 'broken', '---\nname: broken\n---\n\n正文\n')
    mkdirSync(path.join(root, '.agents/skills/empty'))
    writeFileSync(path.join(root, '.agents/skills/empty/README.md'), '没有 SKILL.md 的文件夹不列')

    const view = await listProjectSkills(root)
    assert.equal(view.path, root)
    assert.deepEqual(
      view.skills.map((s) => `${s.source}/${s.name}`),
      ['.claude/skills/broken', '.agents/skills/release-notes'],
    )
    const ok = view.skills.find((s) => s.name === 'release-notes')!
    assert.equal(ok.description, '按团队约定写提交说明，先看改动再写')
    assert.deepEqual(ok.issues, [])
    assert.equal(ok.path, path.join(root, '.agents/skills/release-notes/SKILL.md'))
    assert.ok(ok.clis.length > 1, '.agents/skills 下的技能记录共用它的 Agent')
    const bad = view.skills.find((s) => s.name === 'broken')!
    assert.equal(bad.description, '')
    assert.equal(bad.issues.length, 1)
    assert.match(bad.issues[0], /description/)
    // 没有的目录也列出来（新建时能选），exists 标出来
    assert.equal(view.repos.find((r) => r.dir === '.agents/skills')?.exists, true)
  } finally {
    rmSync(root, { recursive: true, force: true })
  }
})

test('项目技能：新建骨架格式没问题，读写 SKILL.md 和附带文件，删除连文件夹一起删', async () => {
  const { root } = project()
  try {
    const made = await createProjectSkill(root, '.agents/skills', 'commit-style', '按团队约定写提交说明，先看改动再写')
    assert.equal(made.dir, '.agents/skills/commit-style')
    const file = path.join(root, '.agents/skills/commit-style/SKILL.md')
    const text = readFileSync(file, 'utf8')
    assert.deepEqual(skillIssues('commit-style', text), [])
    assert.match(text, /description: 按团队约定写提交说明/)

    writeFileSync(path.join(root, '.agents/skills/commit-style/scripts.sh'), 'echo hi\n')
    const read = await readProjectSkill(root, '.agents/skills', 'commit-style')
    assert.match(read.content, /name: commit-style/)
    assert.deepEqual(read.files, ['scripts.sh'])

    // 改内容时 CRLF 统一成 LF：技能里的脚本要在 WSL / Linux 里跑
    await writeProjectSkill(
      root,
      '.agents/skills',
      'commit-style',
      good('commit-style').replaceAll('\n', '\r\n'),
      false,
    )
    assert.ok(!readFileSync(file, 'utf8').includes('\r'))

    // 已有的不能再新建
    await assert.rejects(createProjectSkill(root, '.agents/skills', 'commit-style'), /已经有了/)

    await deleteProjectSkill(root, '.agents/skills', 'commit-style')
    assert.ok(!existsSync(path.join(root, '.agents/skills/commit-style')))
    await assert.rejects(readProjectSkill(root, '.agents/skills', 'commit-style'), /没有这一项/)
  } finally {
    rmSync(root, { recursive: true, force: true })
  }
})

test('项目技能：只能碰 Agent 定义里的项目目录，名字和路径都要合法', async () => {
  const { root } = project()
  try {
    await assert.rejects(writeProjectSkill(root, '.git', 'hack', 'x', true), /不能放 Skill/)
    await assert.rejects(writeProjectSkill(root, '.agents/skills', '../evil', 'x', true), /名字/)
    // 名字里带斜杠的越界写法在第一层校验就被拦下
    await assert.rejects(writeProjectSkill(root, '.agents/skills', 'a/b', 'x', true), /名字/)
    assert.ok(!existsSync(path.join(root, 'evil')))
  } finally {
    rmSync(root, { recursive: true, force: true })
  }
})

test('项目技能：骨架里没写说明时留一句提示，问题判定覆盖缺 front matter、名字不一致、正文为空', () => {
  const bare = skillTemplate('demo')
  assert.match(bare, /description: /)
  assert.deepEqual(skillIssues('demo', bare), [])
  assert.match(skillIssues('demo', '直接写正文')[0], /front matter/)
  assert.match(skillIssues('demo', '---\nname: other\ndescription: 说明文字够长的了\n---\n\n正文\n').join(), /不一致/)
  assert.match(skillIssues('demo', '---\nname: demo\ndescription: 说明文字够长的了\n---\n').join(), /没有写具体怎么做/)
  assert.match(skillIssues('demo', '---\nname: demo\ndescription: 太短\n---\n\n正文\n').join(), /说不清/)
})

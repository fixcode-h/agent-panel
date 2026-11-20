/**
 * 经验学习的手动入口（对话标题栏「立即学经验」）：用户点了就学——不看「自动学习」开关、不过闸门，
 * 上次学过之后没有新调用时整段重学；自动学照旧按开关和闸门走。运行：npm run test:unit
 */
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { mkdtempSync } from 'node:fs'
import { tmpdir } from 'node:os'
import path from 'node:path'

const dir = mkdtempSync(path.join(tmpdir(), 'agent-panel-learn-'))
process.env.AGENT_PANEL_DATA = dir

const { setLang } = await import('../../shared/i18n.ts')
const { getSettings, saveSettings } = await import('../settings.ts')
const { createExperienceLearner } = await import('./learn.ts')
type Task = import('../../shared/schema.ts').Task
type Project = import('../../shared/schema.ts').Project

setLang('zh')

const project = { id: 'p1', name: 'p', path: mkdtempSync(path.join(tmpdir(), 'agent-panel-learn-proj-')) } as Project
/** 只跑了一条一次就过的命令：自动学的闸门不放行 */
const task = (tools: number) =>
  ({
    id: 't1',
    projectId: 'p1',
    messages: [
      {
        id: 'm1',
        role: 'agent',
        at: '2026-11-20T00:00:00.000Z',
        text: '',
        tools: Array.from({ length: tools }, (_, i) => ({ id: `u${i}`, name: 'Bash', kind: 'run', label: 'npm test' })),
      },
    ],
  }) as unknown as Task

const notes: string[] = []
const learnerOf = (tk: Task) =>
  createExperienceLearner({
    getTask: async (id) => (id === tk.id ? tk : null),
    listTasks: async () => [tk],
    isDone: async () => true,
    projects: { list: async () => [project], get: async (id) => (id === project.id ? project : null) },
    agents: { list: async () => [], get: async () => null },
    note: async (_id, text) => void notes.push(text),
  })

// 提炼用的 CLI 指向不存在的：走到调模型那一步就以「找不到 Agent」失败，不会真的起进程
const setExp = async (exp: Record<string, unknown>) => {
  const s = await getSettings()
  await saveSettings({ ...s, experience: { ...s.experience, cli: 'no-such-cli', ...exp } })
}

test('关了自动学习：自动学不学，手动照学', async () => {
  await setExp({ autoLearn: false })
  const l = learnerOf(task(0))
  assert.equal(await l.learn('t1'), 'off')
  assert.equal(await l.learn('t1', { manual: true }), 'nothing')
})

test('没过闸门：自动学跳过，手动不看闸门、走到调模型', async () => {
  await setExp({ autoLearn: true })
  assert.equal(await learnerOf(task(1)).learn('t1'), 'gate')
  notes.length = 0
  // 自动那次已经记下学到哪了：手动时没有新调用就整段重学，照样走到调模型
  assert.equal(await learnerOf(task(1)).learn('t1', { manual: true }), 'error')
  assert.equal(notes.length, 1)
})

test('经验功能整个关了：手动也不学', async () => {
  await setExp({ enabled: false })
  assert.equal(await learnerOf(task(1)).learn('t1', { manual: true }), 'off')
})

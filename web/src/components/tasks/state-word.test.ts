/**
 * 几处状态说法一致（分析稿 A8、U2）：标题栏胶囊（headStatus）、会话栏「状态」（diagnoseTask 的标题）、
 * 输入框占位（taskWaitText）、侧栏和标题图标（taskWord）、父对话运行区的子对话行（childLabels）、
 * 「状态」窗口（lifeWordFacts）都要从 shared/task-word.ts 取同一个短词。
 * 枚举各种事实组合（在不在跑、自己的提问 / 请求 / 等你操作、名下子对话在等 / 在跑、后台命令、诊断报告、各种 status），
 * 断言几处说法对得上——以前「这里写执行中、那里写等你」的 Bug 反复出，就是每处各拼一句。
 */
import assert from 'node:assert/strict'
import { test } from 'node:test'
import { setLang } from '@shared/i18n'
import { lifeWordFacts } from '@shared/life-next'
import { Task, type TaskRequest } from '@shared/schema'
import { diagnoseTask } from '@shared/task-diagnosis'
import { taskWaitText, taskWord, childWord } from '@shared/task-word'
import { childLabels, type ChildSummary } from './child-line'
import { headStatus } from './head-status'

// 断言的是中文文案：固定语言，不跟着 CI 的 LANG 变
setLang('zh')

const AT = '2026-11-10T08:00:00.000Z'
const NOW = Date.parse(AT) + 5 * 60_000

type Own = 'none' | 'ask' | 'command' | 'question' | 'confirm' | 'action'
const OWNS: Own[] = ['none', 'ask', 'command', 'question', 'confirm', 'action']
const STATUSES = ['running', 'done', 'failed', 'stopped'] as const

const request = (kind: TaskRequest['kind']): TaskRequest => ({
  id: 'r1',
  step: '',
  agentId: '',
  kind,
  title: kind === 'command' ? '运行命令：npm test' : '确认',
  detail: '',
  options: [],
  at: AT,
})

interface Combo {
  status: (typeof STATUSES)[number]
  working: boolean
  own: Own
  childNeeds: number
  children: number
  jobs: number
  diagnosis: boolean
}

const BASE: Combo = {
  status: 'running',
  working: false,
  own: 'none',
  childNeeds: 0,
  children: 0,
  jobs: 0,
  diagnosis: false,
}

function* combos(): Generator<Combo> {
  for (const status of STATUSES)
    for (const working of [false, true])
      for (const own of OWNS)
        for (const childNeeds of [0, 1])
          for (const children of [0, 1])
            for (const jobs of [0, 1])
              for (const diagnosis of [false, true])
                yield { status, working, own, childNeeds, children, jobs, diagnosis }
}

/** 一组事实对应的完整任务（和服务端存的一样过 schema），以及父对话页上它作为子对话那一行的摘要 */
function build(c: Combo) {
  const requests = ['command', 'question', 'confirm'].includes(c.own) ? [request(c.own as TaskRequest['kind'])] : []
  const task = {
    ...Task.parse({
      id: 't',
      projectId: 'p',
      title: '演示',
      mode: 'chat',
      status: c.status,
      createdAt: AT,
      updatedAt: AT,
      turnDoneAt: AT,
      working: c.working,
      requests,
      waitStartedAt: requests.length ? AT : '',
      parentAsks: c.own === 'ask' ? [{ id: 'q', question: '选哪个？', options: ['A', 'B'] }] : undefined,
    }),
    // 下面几项是服务端补的（子对话数）或结构较大、这里只要判定用到的那一个字段
    childrenWorking: c.children,
    childrenNeeds: c.childNeeds,
    jobs: c.jobs ? ([{ id: 'j', service: false }] as never) : undefined,
    userActions: c.own === 'action' ? ([{ id: 'a', title: '登录测试账号', status: 'waiting', at: AT }] as never) : [],
    diagnoses: c.diagnosis ? ([{ status: 'pending', version: 1 }] as never) : [],
  }
  const child: ChildSummary = {
    id: 'c',
    title: '子对话',
    status: c.status,
    working: c.working,
    cliAlive: true,
    startedAt: AT,
    requests: requests.length,
    asking: c.own === 'ask' ? 1 : 0,
    childNeeds: c.childNeeds,
    background: c.jobs,
    action: c.own === 'action',
    diagnosis: c.diagnosis,
    request: requests[0] && { id: 'r1', kind: requests[0].kind, title: '', detail: '', quick: false },
    summary: '',
    updatedAt: AT,
  }
  return { task, child }
}

test('枚举各种事实组合：标题栏、会话栏、输入框占位、侧栏、运行区、状态窗口写的是同一个短词', () => {
  let n = 0
  for (const c of combos()) {
    const { task, child } = build(c)
    const label = JSON.stringify(c)
    const { state, word } = taskWord(task)
    assert.ok(word, `${label}：短词不能是空的`)

    // 标题栏胶囊：等你处理时胶囊就写这个词，执行中 / 等结果时悬停提示以它开头
    const head = headStatus({ ...task, runMs: 60_000, runStartedAt: '' }, NOW)
    if (state === 'needs') assert.equal(head?.text, word, `${label}：标题栏胶囊`)
    if (state === 'needs' || state === 'running' || state === 'waiting')
      assert.ok(head?.hint.startsWith(`${word} · `), `${label}：标题栏提示「${head?.hint}」不是以「${word}」开头`)
    else assert.equal(head, null, `${label}：没在跑、没在等时不出胶囊`)

    // 会话栏「状态」：执行中、等结果、等你处理的标题以同一个词开头
    if (state === 'needs' || state === 'running' || state === 'waiting') {
      const d = diagnoseTask(task, [], NOW)
      assert.equal(d.state, state, `${label}：会话栏的状态`)
      assert.ok(d.headline.startsWith(word), `${label}：会话栏「${d.headline}」不是以「${word}」开头`)
    }

    // 输入框占位（taskWaitText）：要么不写，要么就是这个词
    const wait = taskWaitText(task)
    assert.ok(wait === '' || wait === word, `${label}：输入框占位「${wait}」和「${word}」不一致`)

    // 「状态」窗口：服务端按同一个函数填短词
    assert.equal(lifeWordFacts(task).word, word, `${label}：状态窗口`)

    // 父对话运行区里它作为子对话那一行：同一组事实同一个词（子对话摘要里没有「名下子对话在跑」这一项，不比）
    if (!c.children) {
      const cw = childWord(child)
      assert.equal(cw.state, state, `${label}：子对话行的状态`)
      assert.equal(cw.word, word, `${label}：子对话行的短词`)
      if (state === 'needs')
        assert.ok(
          childLabels(child).some((l) => l.text === word),
          `${label}：运行区标签「${childLabels(child)
            .map((l) => l.text)
            .join(' / ')}」里没有「${word}」`,
        )
    }
    n++
  }
  assert.equal(n, 4 * 2 * 6 * 2 * 2 * 2 * 2)
})

test('等你处理：自己的事排在子对话前面，按种类写成不同的词', () => {
  const word = (own: Own, childNeeds = 0) => taskWord(build({ ...BASE, own, childNeeds }).task).word
  assert.equal(word('ask', 1), '等你回答')
  assert.equal(word('question'), '等你回答')
  assert.equal(word('command', 1), '等你确认')
  assert.equal(word('confirm'), '阶段待确认')
  assert.equal(word('action', 1), '等你操作')
  assert.equal(word('none', 1), '子对话等你处理')
})

test('等结果：说清在等子对话、后台命令；诊断报告等确认写「报告待确认」', () => {
  assert.equal(taskWord(build({ ...BASE, children: 1, jobs: 1 }).task).word, '子对话执行中')
  assert.equal(taskWord(build({ ...BASE, jobs: 1 }).task).word, '后台命令执行中')
  const report = taskWord(build({ ...BASE, diagnosis: true }).task)
  assert.equal(report.state, 'running')
  assert.equal(report.word, '报告待确认')
  // 诊断报告还在、CLI 又在跑：这时是在执行，不说成等你
  assert.equal(taskWord(build({ ...BASE, diagnosis: true, working: true }).task).word, '执行中')
})

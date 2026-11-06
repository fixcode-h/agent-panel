import assert from 'node:assert/strict'
import test from 'node:test'
import { FlowRun } from '../shared/task-flow-schema.ts'
import { AgentInput, Workflow, type Agent, type Task } from '../shared/schema.ts'
import { newTask } from '../shared/task.ts'
import { runEngineTurn, type AgentCall, type EngineHost } from '../shared/engine.ts'
import { getLang, resolveLang, setLang } from '../shared/i18n.ts'
import {
  PROMPT_LANG_ENV,
  VERDICT_LINE,
  promptLangModSource,
  promptLangReminder,
  promptLangRules,
  promptLangWord,
} from '../shared/prompt-lang.ts'
import { buildAssistPrompt } from '../shared/assist.ts'
import { docOptimizePrompt } from '../shared/docs.ts'

/**
 * 交给 Agent 的回复语言跟随面板设置：zh / en 两种设置都要写明「正文和思考过程」都用这种语言，
 * 代码、命令、日志和报错原文不翻译；auto 沿用 resolveLang 的解析（service 端跟随系统、浏览器跟随 navigator）。
 * 规则在每次执行时现算，所以设置里换了语言，下一次运行的提示词就是新语言。
 */

const agent = (id: string, name: string, extra: Partial<Agent> = {}): Agent => ({
  ...AgentInput.parse({ name, ...extra }),
  id,
  createdAt: '',
  updatedAt: '',
})

/** 工作流程：条件连线的节点 → 结束（一处带条件连线，能盖到「给出结论」的提示词） */
const workflow = (): Workflow =>
  Workflow.parse({
    id: 'wf',
    createdAt: '',
    updatedAt: '',
    name: '单节点',
    mainAgentId: '',
    dispatch: false,
    flows: [
      {
        id: 'main',
        name: '主流程',
        nodes: [
          { id: 'a', title: '实现', agentId: 'w', instructions: '写代码。' },
          { id: 'b', title: '收尾', agentId: 'w', instructions: '写说明。' },
        ],
        edges: [
          { id: 'e1', from: 'start', to: 'a' },
          { id: 'e2', from: 'a', to: 'b', when: 'pass' },
          { id: 'e3', from: 'a', to: 'end', when: 'fail' },
          { id: 'e4', from: 'b', to: 'end' },
        ],
      },
    ],
  })

function host(task: Task, log: AgentCall[], agents: Agent[]): EngineHost {
  const w = workflow()
  let n = 0
  return {
    task,
    agents,
    workflows: [w],
    workflow: task.mode === 'workflow' ? w : undefined,
    prompt: task.mode === 'chat' ? '这个项目用什么框架' : '做功能',
    changed: () => {},
    newId: () => `id${++n}`,
    runAgent: async (call) => {
      log.push(call)
      return { ok: true, text: '做完了' }
    },
  }
}

/** 跑一次工作流节点，返回实际交给 CLI 的提示词 */
async function nodePrompt(): Promise<string> {
  const log: AgentCall[] = []
  const w = workflow()
  const task = {
    ...newTask({ projectId: 'p', mode: 'workflow', prompt: '做功能' } as never, w, '', 't'),
    flowRun: FlowRun.parse({ owner: 'p' }),
    id: 't',
  } as Task
  await runEngineTurn(host(task, log, [agent('w', '开发')]))
  return log[0].prompt
}

/** 跑一次项目对话，返回实际交给 CLI 的提示词 */
async function chatPrompt(): Promise<string> {
  const log: AgentCall[] = []
  const task = {
    ...newTask(
      { projectId: 'p', mode: 'chat', agentId: 'm', prompt: '这个项目用什么框架' } as never,
      undefined,
      '',
      't',
    ),
    id: 't',
  } as Task
  await runEngineTurn(host(task, log, [agent('m', '协调')]))
  return log[0].prompt
}

/** 在指定语言下跑一段，跑完恢复成测试开始时的语言（同一文件的测试共用全局语言） */
async function withLang(lang: 'zh' | 'en', fn: () => Promise<void> | void) {
  const before = getLang()
  setLang(lang)
  try {
    await fn()
  } finally {
    setLang(before)
  }
}

test('zh：规则写明回复正文和思考过程都用中文，代码命令日志报错不翻译', () => {
  const rules = promptLangRules('zh')
  assert.match(rules, /## 回复语言/)
  assert.match(rules, /回复正文和你自己的思考过程（reasoning \/ thinking）都用中文/)
  assert.match(rules, /代码、标识符、命令、日志和报错原文保持原样，不翻译/)
  assert.doesNotMatch(rules, /英文/)
})

test('en：规则用英文写明 reply 和 reasoning / thinking，代码命令日志报错不翻译', () => {
  const rules = promptLangRules('en')
  assert.match(rules, /## Reply language/)
  assert.match(rules, /write both your reply and your own reasoning \/ thinking in English/i)
  assert.match(rules, /do not translate them/i)
})

test('auto：界面按系统 / 浏览器语言解析，回复语言跟随用户消息，不强制成界面语言', async () => {
  assert.equal(resolveLang('auto', 'en-US'), 'en')
  assert.equal(resolveLang('auto', 'zh-CN'), 'zh')
  // 设置成固定值时不受浏览器语言影响
  assert.equal(resolveLang('zh', 'en-US'), 'zh')
  assert.equal(resolveLang('en', 'zh-CN'), 'en')
  // 系统语言 C.UTF-8 时「自动」解析成英文界面；以前规则也跟着写成「全部用英文」，中文提问收到英文回复
  const before = getLang()
  setLang(resolveLang('auto', 'C.UTF-8'), true)
  try {
    assert.equal(getLang(), 'en')
    const rules = promptLangRules()
    assert.match(rules, /## Reply language/)
    assert.match(rules, /in the language the user's message .* is written in/)
    assert.doesNotMatch(rules, /reasoning \/ thinking in English/)
    assert.match(promptLangReminder(), /language of the user's message/)
    const prompt = await nodePrompt()
    assert.match(prompt, /完成后用用户消息所用的语言按上面的「总结格式」写总结卡/)
    assert.doesNotMatch(prompt, /完成后用英文/)
  } finally {
    setLang(before)
  }
  assert.match(promptLangRules('auto-zh'), /## 回复语言\n面板语言设成了「自动」.*用户用中文写就用中文/)
})

test('语言名和要结论时的那句话：结论只认 submit_verdict 工具，不让模型在回复里写给面板识别的字（ADR 0041 第 16 节）', () => {
  assert.equal(promptLangWord('zh'), '中文')
  assert.equal(promptLangWord('en'), '英文')
  // 措辞里的这两个片段不要改：scripts/fake-cli 按它模拟 CLI 调工具交结论
  assert.match(VERDICT_LINE.review, /submit_verdict 工具交验收结论/)
  assert.match(VERDICT_LINE.branch, /submit_verdict 工具交结论/)
  for (const line of Object.values(VERDICT_LINE)) assert.doesNotMatch(line, /单独一行写|Verdict: pass/)
})

test('工作流节点提示词：设置成中文时注入中文规则，通用要求也用中文', async () => {
  await withLang('zh', async () => {
    const prompt = await nodePrompt()
    assert.match(prompt, /## 回复语言\n界面语言设成了中文/)
    assert.match(prompt, /完成后用中文按上面的「总结格式」写总结卡/)
    // 要结论时点名 submit_verdict：scripts/fake-cli 按这个片段模拟 CLI 调工具交结论
    assert.match(prompt, /最后调用 submit_verdict 工具交结论/)
    assert.doesNotMatch(prompt, /## Reply language/)
    assert.doesNotMatch(prompt, /始终用中文回答/)
  })
})

test('工作流节点提示词：设置成英文时注入英文规则，通用要求也用英文', async () => {
  await withLang('en', async () => {
    const prompt = await nodePrompt()
    assert.match(prompt, /## Reply language/)
    assert.match(prompt, /reasoning \/ thinking/)
    assert.match(prompt, /完成后用英文按上面的「总结格式」写总结卡/)
    assert.doesNotMatch(prompt, /## 回复语言/)
  })
})

test('对话提示词同样注入：切换设置后下一次执行就是新语言，不用重新同步角色', async () => {
  await withLang('en', async () => {
    assert.match(await chatPrompt(), /## Reply language/)
  })
  await withLang('zh', async () => {
    assert.match(await chatPrompt(), /## 回复语言/)
  })
})

test('子任务提示词：子对话派出的子任务也带回复语言规则', async () => {
  await withLang('zh', async () => {
    const log: AgentCall[] = []
    const w = workflow()
    const task = {
      ...newTask({ projectId: 'p', mode: 'workflow', prompt: '做功能' } as never, w, '', 't'),
      flowRun: FlowRun.parse({ owner: 'p' }),
      id: 't',
    } as Task
    const base = host(task, log, [agent('w', '开发')])
    const h: EngineHost = {
      ...base,
      runAgent: async (call) => {
        log.push(call)
        // 节点里派一个子任务：子任务的提示词是另一条拼装路径
        if (!call.step?.slot && call.orch) {
          const ids = call.orch.spawn([{ title: '子任务', instructions: '查一下' }]).ids
          await call.orch.wait(ids, 1000)
        }
        return { ok: true, text: '做完了' }
      },
    }
    await runEngineTurn(h)
    const sub = log.find((c) => c.step?.slot === 'sub')
    assert.ok(sub, '子任务应该真的跑了一次')
    assert.match(sub!.prompt, /## 回复语言\n界面语言设成了中文/)
  })
})

test('末尾提醒：中英文都要求继续用这种语言思考和回复，代码命令不翻译', () => {
  assert.match(promptLangReminder('zh'), /回复正文和思考过程继续用中文/)
  assert.match(promptLangReminder('zh'), /代码、命令、日志和报错原文不翻译/)
  assert.match(promptLangReminder('en'), /both your reply and your reasoning \/ thinking in English/i)
  assert.match(promptLangReminder('en'), /error messages exactly as they are/i)
})

test('语言 mod：生成的源码可执行，按环境变量取规则（Command Code 靠它进系统提示词）', async () => {
  const mod = await import(`data:text/javascript,${encodeURIComponent(promptLangModSource())}`)
  let hook: (() => string) | undefined
  mod.default({ hooks: (h: { appendSystemPrompt: () => string }) => (hook = h.appendSystemPrompt) })
  assert.ok(hook)
  process.env[PROMPT_LANG_ENV] = 'zh'
  assert.match(hook!(), /## 回复语言/)
  assert.match(hook!(), /思考过程（reasoning \/ thinking）都用中文/)
  process.env[PROMPT_LANG_ENV] = 'en'
  assert.match(hook!(), /## Reply language/)
  process.env[PROMPT_LANG_ENV] = 'auto-en'
  assert.match(hook!(), /language the user's message/)
  delete process.env[PROMPT_LANG_ENV]
  assert.equal(hook!(), '', '没有语言时不追加，避免把空规则塞进系统提示词')
})

test('配置助手和说明文件优化的提示词：语言规则不抢占第一句（fake-cli 按开头识别流程）', async () => {
  const ctx = { agents: [], categories: [], workflows: [], rules: '' }
  const messages = [{ role: 'user' as const, text: '要一个审查员' }]
  await withLang('en', async () => {
    const assist = buildAssistPrompt('agent', ctx, messages, [])
    assert.ok(assist.startsWith('你是「Agent 面板」里的配置助手'), '开头不能被语言规则挤掉')
    assert.match(assist, /## Reply language/)
  })
  const doc = docOptimizePrompt({ path: 'AGENTS.md', content: '', request: '', cli: 'claude', model: '', effort: '' }, [
    'claude',
  ])
  assert.ok(doc.startsWith('你在帮忙优化项目根目录下的说明文件'), '开头不能被语言规则挤掉')
  assert.match(doc, /## 回复语言/)
})

test('末尾提醒带上「提到文件写完整路径」：只写文件名时面板打不开（用户 2026-11-06 定的）', () => {
  for (const lang of ['zh', 'auto-zh'] as const) assert.match(promptLangReminder(lang), /完整的绝对路径/)
  for (const lang of ['en', 'auto-en'] as const) assert.match(promptLangReminder(lang), /full absolute path/)
})

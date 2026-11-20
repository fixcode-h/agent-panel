/**
 * 回复语言的统一注入（prompt-lang-inject.ts）：所有调起 CLI 的地方都经 invokeCli，规则在那里补。
 * 起因：用户 2026-11-20 报父对话思考是中文、子对话还是英文——保活的子对话收到的父对话传话、子任务结果原样交给 CLI，
 * 没有语言提醒；经验提炼、AI 创建、插件这些直接调 invokeCli 的也不进系统提示词。
 * 运行：npm run test:unit
 */
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { PROMPT_LANG_ENV, promptLangReminder, promptLangRules } from '../../shared/prompt-lang.ts'
import { withLangNextTurns, withLangReminder, withLangSystemPrompt } from './prompt-lang-inject.ts'

const build = { permission: 'full', extraArgs: [] as string[] }

test('有系统提示词参数的 CLI：语言规则接在角色设定后面，没有角色设定也补，不重复加', async () => {
  const def = { systemPromptFlag: true, systemPromptMod: false }
  const a = await withLangSystemPrompt(def, { ...build, systemPrompt: '## 角色\n做事' }, {})
  assert.ok(a.build.systemPrompt?.startsWith('## 角色\n做事'))
  assert.ok(a.build.systemPrompt?.endsWith(promptLangRules()))
  const b = await withLangSystemPrompt(def, build, {})
  assert.equal(b.build.systemPrompt, promptLangRules())
  const c = await withLangSystemPrompt(def, a.build, {})
  assert.equal(c.build.systemPrompt, a.build.systemPrompt)
  // 起标题这类只要文字的小活不动
  const d = await withLangSystemPrompt(def, { ...build, textOnly: true }, {})
  assert.equal(d.build.systemPrompt, undefined)
})

test('只能靠 mod 追加的 CLI：调用方给了 mod 路径时带上语言环境变量', async () => {
  const r = await withLangSystemPrompt(
    { systemPromptFlag: false, systemPromptMod: true },
    { ...build, systemPromptModPath: '/x/mod.mjs' },
    {},
  )
  assert.equal(r.build.systemPromptModPath, '/x/mod.mjs')
  assert.ok(r.env[PROMPT_LANG_ENV])
})

test('输入末尾的语言提醒：补在最后、已有的挪到最后、/命令和操作不加', () => {
  const remind = promptLangReminder()
  assert.equal(withLangReminder('做这件事'), `做这件事\n\n${remind}`)
  assert.equal(withLangReminder(`做这件事\n\n${remind}\n\n用法说明`), `做这件事\n\n用法说明\n\n${remind}`)
  assert.equal(withLangReminder(withLangReminder('做这件事')), `做这件事\n\n${remind}`)
  assert.equal(withLangReminder('/compact'), '/compact')
  assert.equal(withLangReminder('压缩', true), '压缩')
})

test('保活的下一轮（父对话传话、子任务结果、用户消息）同样补语言提醒，null 原样返回', async () => {
  const msgs = ['父对话：接着把剩下两个文件改完', null]
  const o = withLangNextTurns({ keepAlive: async () => msgs.shift() ?? null })
  assert.equal(await o.keepAlive!(), `父对话：接着把剩下两个文件改完\n\n${promptLangReminder()}`)
  assert.equal(await o.keepAlive!(), null)
  assert.equal(o.waitUser, undefined)
})

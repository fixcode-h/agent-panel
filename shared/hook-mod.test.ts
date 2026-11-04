/**
 * Command Code 的 mod 里的钩子（ADR 0049 第三期）：Command Code 要账号登录才能跑，这里把面板生成的 mod 真的加载起来，
 * 接一个本地的「面板」，逐个调用它注册给 cmd.hooks 的函数，确认事件名、输入、拒绝和补说明的返回都对。运行：npm run test:unit
 */
import assert from 'node:assert/strict'
import { createServer } from 'node:http'
import { mkdtempSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import path from 'node:path'
import { pathToFileURL } from 'node:url'
import test from 'node:test'
import { promptLangModSource } from './prompt-lang.ts'
import { HOOK_EVENTS_ENV, HOOK_URL_ENV } from './hooks.ts'

test('mod 按这一轮的事件问面板：工具前拒绝变成 block、工具后补说明、结束前续跑、压缩后下一回合补一条消息', async () => {
  const got: { event: string; native: Record<string, unknown> }[] = []
  const server = createServer((req, res) => {
    let b = ''
    req
      .on('data', (c) => (b += c))
      .on('end', () => {
        const m = JSON.parse(b)
        got.push(m)
        const cmd = String(m.native?.tool_input?.command ?? '')
        const out =
          m.event === 'tool.before' && cmd.includes('npm test')
            ? { deny: true, reason: '不许 npm test' }
            : m.event === 'tool.after'
              ? { context: '改完记得跑类型检查' }
              : m.event === 'turn.beforeEnd'
                ? { block: true, reason: '计划还有一步' }
                : m.event === 'context.restored'
                  ? { context: '当前计划：第 2 步' }
                  : {}
        res.setHeader('content-type', 'application/json')
        res.end(JSON.stringify(out))
      })
  })
  await new Promise<void>((r) => server.listen(0, '127.0.0.1', r))
  const port = (server.address() as { port: number }).port
  process.env[HOOK_URL_ENV] = `http://127.0.0.1:${port}/hook`
  process.env[HOOK_EVENTS_ENV] = 'turn.beforeEnd,tool.before,tool.after,context.restored'
  try {
    const dir = mkdtempSync(path.join(tmpdir(), 'agent-panel-mod-'))
    const file = path.join(dir, 'mod.mjs')
    writeFileSync(file, promptLangModSource())
    const mod = (await import(pathToFileURL(file).href)) as { default: (cmd: unknown) => void }
    let hooks: Record<string, (...a: unknown[]) => Promise<unknown>> = {}
    const listeners: Record<string, () => void> = {}
    mod.default({ hooks: (h: typeof hooks) => (hooks = h), on: (ev: string, cb: () => void) => (listeners[ev] = cb) })

    assert.deepEqual(
      await hooks.beforeToolCall({ toolName: 'shell_command', input: { command: 'cd /p && npm test' } }),
      {
        block: true,
        additionalContext: '不许 npm test',
      },
    )
    assert.equal(await hooks.beforeToolCall({ toolName: 'shell_command', input: { command: 'ls' } }), undefined)
    assert.deepEqual(await hooks.afterToolCall({ toolName: 'edit_file', input: { file_path: 'a.ts' } }), {
      additionalContext: '改完记得跑类型检查',
    })
    assert.deepEqual(await hooks.onStop({ lastAssistantText: '我先看一下' }), {
      continue: true,
      reason: '计划还有一步',
    })
    // 压缩后：先问面板，下一回合开始时把说明作为一条不显示的消息补进去
    listeners.compaction_done()
    const appended: unknown[] = []
    const state = { messages: [{ role: 'user', content: 'x' }] }
    const ctx = {
      session: {
        appendCustomMessageEntry: (e: { content: string }) => {
          appended.push(e)
          return { message: { role: 'user', content: e.content } }
        },
      },
    }
    const next = (await hooks.onTurnStart({ state }, ctx)) as typeof state
    assert.equal(next.messages.length, 2)
    assert.equal((appended[0] as { display: boolean }).display, false)
    assert.equal(await hooks.onTurnStart({ state }, ctx), state, '只补一次')

    const events = got.map((g) => g.event)
    assert.deepEqual(events, ['tool.before', 'tool.before', 'tool.after', 'turn.beforeEnd', 'context.restored'])
    assert.equal(got[0].native.tool_name, 'shell_command')
    assert.ok(!JSON.stringify(got).includes('我先看一下'), '不把模型回复的文字发给面板')
  } finally {
    server.close()
    delete process.env[HOOK_URL_ENV]
    delete process.env[HOOK_EVENTS_ENV]
  }
})

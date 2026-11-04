import assert from 'node:assert/strict'
import test from 'node:test'
import {
  beforeEndInput,
  fillTpl,
  hookFacts,
  hookForwarderSource,
  hookInstall,
  HOOK_SCRIPT,
  HOOK_URL_ENV,
} from './hooks.ts'
import { getCli } from './clis.ts'
import { promptLangModSource } from './prompt-lang.ts'

// 结束前钩子（ADR 0049）：CLI 定义里声明怎么装，代码按字段走；面板只拿「是不是已经续过一次」，回复文字一律丢掉

test('Claude Code：钩子配置和转发脚本写进这一轮的临时目录，参数只传文件路径，路径用正斜杠', () => {
  const spec = getCli('claude')!.hooks!
  const { args, files } = hookInstall(spec, 'C:\\data\\cli-run\\abc', ['turn.beforeEnd'])
  assert.deepEqual(args, ['--settings', 'C:/data/cli-run/abc/agent-panel-hooks.json'])
  const script = files.find((f) => f.path.endsWith(HOOK_SCRIPT))!
  assert.equal(script.path, `C:/data/cli-run/abc/${HOOK_SCRIPT}`)
  assert.match(String(script.content), new RegExp(`process\\.env\\.${HOOK_URL_ENV}`))
  const cfg = files.find((f) => f.path.endsWith('agent-panel-hooks.json'))!.content as {
    hooks: { Stop: { hooks: { command: string }[] }[] }
  }
  assert.equal(cfg.hooks.Stop[0].hooks[0].command, `node "C:/data/cli-run/abc/${HOOK_SCRIPT}" turn.beforeEnd`)
  assert.equal(Object.keys(cfg.hooks).join(), 'Stop', '没人用的工具前 / 工具后不装')
})

test('只装这一轮有人用的事件，几个事件合进同一份钩子配置', () => {
  const { args, files } = hookInstall(getCli('claude')!.hooks!, '/tmp/run', ['tool.before', 'context.restored'])
  assert.deepEqual(args, ['--settings', '/tmp/run/agent-panel-hooks.json'])
  const cfg = files.find((f) => f.path.endsWith('agent-panel-hooks.json'))!.content as {
    hooks: Record<string, unknown>
  }
  assert.deepEqual(Object.keys(cfg.hooks).sort(), ['PreToolUse', 'SessionStart'])
  assert.deepEqual(hookInstall(getCli('claude')!.hooks!, '/tmp/run', []), { args: [], files: [] })
})

test('工具前 / 工具后：工具名按定义对照到类别，文件路径按定义里的字段取，回复文字不进事实', () => {
  const f = hookFacts(getCli('claude')!.hooks!, {
    tool_name: 'Edit',
    tool_input: { file_path: '/p/a.ts', old_string: 'x' },
    last_assistant_message: '我先改一下',
  })
  assert.equal(f.tool?.kind, 'edit')
  assert.equal(f.tool?.path, '/p/a.ts')
  assert.doesNotMatch(JSON.stringify(f), /我先改一下/)
  assert.equal(
    hookFacts(getCli('claude')!.hooks!, { tool_name: 'Bash', tool_input: { command: 'ls' } }).tool?.kind,
    'shell',
  )
  assert.deepEqual(hookFacts(getCli('claude')!.hooks!, { source: 'compact' }), { source: 'compact' })
})

test('拦住、拒绝、补说明都按定义里的模板填好', () => {
  const spec = getCli('claude')!.hooks!
  assert.deepEqual(fillTpl(spec.beforeEnd!.block, { reason: '接着做「跑检查」' }), {
    decision: 'block',
    reason: '接着做「跑检查」',
  })
  assert.equal(
    (fillTpl(spec.events['tool.before']!.deny, { reason: '只读' }) as { hookSpecificOutput: Record<string, string> })
      .hookSpecificOutput.permissionDecision,
    'deny',
  )
})

test('转发和面板都不读回复文字：脚本先丢掉，面板只认「已经续过」', () => {
  assert.match(hookForwarderSource(['last_assistant_message']), /"last_assistant_message"/)
  const got = beforeEndInput(
    { stop_hook_active: true, last_assistant_message: '我先看一下……', transcript_path: '/x' },
    ['last_assistant_message'],
  )
  assert.deepEqual(got, { again: true })
  assert.deepEqual(beforeEndInput(null), {})
})

test('Pi、Command Code 写在面板每轮装的扩展里，CLI 定义只声明支持', () => {
  assert.equal(getCli('pi')!.hooks?.beforeEnd?.via, 'extension')
  assert.equal(getCli('commandcode')!.hooks?.beforeEnd?.via, 'extension')
  // 扩展方式不另写文件、不加参数
  assert.deepEqual(hookInstall(getCli('pi')!.hooks!, '/tmp/x', ['turn.beforeEnd']), { args: [], files: [] })
  const pi = String(Object.values(getCli('pi')!.mcp!.files)[0])
  assert.match(pi, /agent_before_settle/)
  assert.match(pi, /continue: true/)
  assert.doesNotMatch(pi, /lastAssistant|last_assistant/, 'Pi 扩展不把回复文字发给面板')
  const mod = promptLangModSource()
  assert.match(mod, /onStop/)
  assert.match(mod, new RegExp(HOOK_URL_ENV))
  assert.doesNotMatch(mod, /lastAssistantText/, 'Command Code 的 mod 不把回复文字发给面板')
})

test('没声明钩子的 CLI（Codex）照旧只靠一轮结束后的提醒', () => {
  assert.equal(getCli('codex')!.hooks, undefined)
})

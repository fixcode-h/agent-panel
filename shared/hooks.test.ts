import assert from 'node:assert/strict'
import test from 'node:test'
import {
  beforeEndInput,
  fillTpl,
  hookFacts,
  hookForwarderSource,
  hookInstall,
  HOOK_EVENTS_ENV,
  HOOK_SCRIPT,
  HOOK_SCRIPT_ENV,
  supportedEvents,
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
  assert.deepEqual(hookInstall(getCli('claude')!.hooks!, '/tmp/run', []), { args: [], files: [], env: {} })
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
  assert.deepEqual(hookInstall(getCli('pi')!.hooks!, '/tmp/x', ['turn.beforeEnd']), { args: [], files: [], env: {} })
  const pi = String(Object.values(getCli('pi')!.mcp!.files)[0])
  assert.match(pi, /agent_before_settle/)
  assert.match(pi, /continue: true/)
  assert.doesNotMatch(pi, /lastAssistant|last_assistant/, 'Pi 扩展不把回复文字发给面板')
  const mod = promptLangModSource()
  assert.match(mod, /onStop/)
  assert.match(mod, new RegExp(HOOK_URL_ENV))
  assert.doesNotMatch(mod, /lastAssistantText/, 'Command Code 的 mod 不把回复文字发给面板')
})

test('Codex：钩子写成 -c 参数，命令引用转发脚本的环境变量（每轮相同，信任一次就够），只装有人用的事件', () => {
  const spec = getCli('codex')!.hooks!
  assert.equal(spec.trust, 'rpc')
  const { args, files, env } = hookInstall(spec, 'C:\\tmp\\run1', ['turn.beforeEnd', 'context.restored'])
  assert.equal(args.length, 4)
  assert.match(args[1], /^hooks\.Stop=/)
  assert.match(args[3], /^hooks\.SessionStart=\[\{matcher='compact\|resume'/)
  assert.ok(
    args.every((a) => !a.includes('run1')),
    '参数里不带这一轮的临时目录，命令每轮都一样',
  )
  assert.ok(args[1].includes(`$${HOOK_SCRIPT_ENV}`))
  assert.equal(env[HOOK_SCRIPT_ENV], `C:/tmp/run1/${HOOK_SCRIPT}`)
  assert.equal(files.length, 1, '只写转发脚本，不写配置文件')
  const again = hookInstall(spec, '/tmp/run2', ['turn.beforeEnd', 'context.restored'])
  assert.deepEqual(again.args, args)
})

test('Codex 用 shell 跑 apply_patch 也算改文件，文件路径从补丁头里取', () => {
  const spec = getCli('codex')!.hooks!
  const patch =
    "apply_patch <<'P'\n*** Begin Patch\n*** Add File: a.txt\n+x\n*** Update File: src/b.ts\n*** End Patch\nP"
  const f = hookFacts(spec, { tool_name: 'Bash', tool_input: { command: patch } })
  assert.equal(f.tool?.kind, 'edit')
  assert.deepEqual(f.tool?.paths, ['a.txt', 'src/b.ts'])
  assert.equal(hookFacts(spec, { tool_name: 'Bash', tool_input: { command: 'ls' } }).tool?.kind, 'shell')
})

test('Pi、Command Code 的工具前后和压缩之后写在扩展里：按这一轮的事件清单才问，CLI 定义声明支持，不写转发脚本', () => {
  for (const id of ['pi', 'commandcode'])
    assert.deepEqual(supportedEvents(getCli(id)!.hooks).sort(), [
      'context.restored',
      'tool.after',
      'tool.before',
      'turn.beforeEnd',
    ])
  assert.deepEqual(hookInstall(getCli('pi')!.hooks!, '/tmp/x', ['tool.before', 'context.restored']), {
    args: [],
    files: [],
    env: {},
  })
  const pi = String(Object.values(getCli('pi')!.mcp!.files)[0])
  for (const ev of ['tool_call', 'tool_result', 'session_compact']) assert.ok(pi.includes(`'${ev}'`), ev)
  assert.match(pi, /\{hookEventsEnv\}/)
  const mod = promptLangModSource()
  for (const h of ['beforeToolCall', 'afterToolCall', 'compaction_done', 'onTurnStart']) assert.ok(mod.includes(h), h)
  assert.ok(mod.includes(HOOK_EVENTS_ENV))
  // Pi 的工具名和参数对照到面板的类别、路径
  const f = hookFacts(getCli('pi')!.hooks!, { tool_name: 'edit', tool_input: { path: 'src/a.ts' } })
  assert.deepEqual([f.tool?.kind, f.tool?.path], ['edit', 'src/a.ts'])
  const c = hookFacts(getCli('commandcode')!.hooks!, { tool_name: 'write_file', tool_input: { file_path: 'b.md' } })
  assert.deepEqual([c.tool?.kind, c.tool?.path], ['edit', 'b.md'])
})

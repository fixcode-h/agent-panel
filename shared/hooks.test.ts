import assert from 'node:assert/strict'
import test from 'node:test'
import {
  beforeEndInput,
  fillTpl,
  hookFacts,
  hookForwarderSource,
  hookInstall,
  toolMatcher,
  HOOK_EVENTS_ENV,
  HOOK_SCRIPT,
  HOOK_SCRIPT_ENV,
  supportedEvents,
  versionAtLeast,
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

test('工具后带上执行结果：Claude Code 的失败事件带 error 算失败，Pi 看 is_error，Codex 报不出失败', () => {
  const c = hookFacts(getCli('claude')!.hooks!, {
    hook_event_name: 'PostToolUseFailure',
    tool_name: 'Bash',
    tool_input: { command: 'npm test' },
    error: 'Exit code 1',
  })
  assert.deepEqual(c.tool?.result, { output: 'Exit code 1', failed: true })
  const ok = hookFacts(getCli('claude')!.hooks!, {
    tool_name: 'Bash',
    tool_input: { command: 'ls' },
    tool_response: { stdout: 'a', stderr: '' },
  })
  assert.equal(ok.tool?.result?.failed, false)
  assert.match(ok.tool?.result?.output ?? '', /"stdout":"a"/)
  const pi = hookFacts(getCli('pi')!.hooks!, { tool_name: 'bash', tool_input: {}, tool_output: 'boom', is_error: true })
  assert.equal(pi.tool?.result?.failed, true)
  const cx = hookFacts(getCli('codex')!.hooks!, { tool_name: 'Bash', tool_input: {}, tool_response: 'x' })
  assert.equal(cx.tool?.result?.failed, undefined, 'Codex 不报失败')
  assert.equal(hookFacts(getCli('claude')!.hooks!, { tool_name: 'Bash', tool_input: {} }).tool?.result, undefined)
  // 补说明的 hookEventName 跟着原生事件走
  assert.deepEqual(
    fillTpl(getCli('claude')!.hooks!.events['tool.after']!.context, { text: 't', event: 'PostToolUseFailure' }),
    {
      hookSpecificOutput: { hookEventName: 'PostToolUseFailure', additionalContext: 't' },
    },
  )
})

test('面板自己的工具按去掉前缀的名字认成 panel 类', () => {
  const f = hookFacts(getCli('claude')!.hooks!, { tool_name: 'mcp__panel-ab12__submit_merge', tool_input: {} })
  assert.deepEqual([f.tool?.kind, f.tool?.panel], ['panel', 'submit_merge'])
  const p = hookFacts(getCli('pi')!.hooks!, { tool_name: 'spawn_agents', tool_input: {} })
  assert.equal(p.tool?.kind, 'panel')
})

test('版本门槛：本机版本比实测过的老就不装，读不到版本照装', () => {
  assert.ok(versionAtLeast('codex-cli 0.166.0', '0.166.0'))
  assert.ok(!versionAtLeast('codex-cli 0.150.2', '0.166.0'))
  assert.ok(versionAtLeast('2.1.318 (Claude Code)', '2.1.0'))
  assert.ok(versionAtLeast('', '9.9.9'))
  assert.deepEqual(supportedEvents(getCli('codex')!.hooks, 'codex-cli 0.150.0'), [])
  assert.equal(supportedEvents(getCli('codex')!.hooks, 'codex-cli 0.166.0').length, 4)
  assert.ok(!supportedEvents(getCli('pi')!.hooks, '1.4.9').includes('turn.beforeEnd'))
})

test('工具过滤：内置守卫只关心改文件和跑命令时，Claude Code 的工具前 / 工具后只对这几个工具名触发', () => {
  const spec = getCli('claude')!.hooks!
  assert.equal(toolMatcher(spec, ['edit', 'shell']), 'Edit|Write|MultiEdit|NotebookEdit|Bash')
  assert.equal(toolMatcher(spec, ['edit', 'shell', 'any']), '', '有任意工具的用户钩子：全部触发')
  assert.equal(toolMatcher(spec, ['panel']), '', '面板工具名列不全：全部触发')
  assert.equal(toolMatcher(spec, []), '')
  // Codex 用 shell 跑 apply_patch 也算改文件：只关心改文件时 shell 的工具名也要带上；没写 read 的对照表按全部算
  assert.equal(toolMatcher(getCli('codex')!.hooks!, ['edit']), 'apply_patch|Bash')
  assert.equal(toolMatcher(getCli('codex')!.hooks!, ['read']), '')
  const { files } = hookInstall(spec, '/tmp/run', ['tool.before', 'tool.after'], {
    tools: { 'tool.before': ['edit', 'shell'], 'tool.after': ['shell'] },
  })
  const cfg = files.find((f) => f.path.endsWith('agent-panel-hooks.json'))!.content as {
    hooks: Record<string, { matcher: string }[]>
  }
  assert.equal(cfg.hooks.PreToolUse[0].matcher, 'Edit|Write|MultiEdit|NotebookEdit|Bash')
  assert.equal(cfg.hooks.PostToolUse[0].matcher, 'Bash')
  assert.equal(cfg.hooks.PostToolUseFailure[0].matcher, 'Bash')
  // 不给范围：matcher 为空，Claude Code 按全部工具触发（和以前一样）
  const all = hookInstall(spec, '/tmp/run', ['tool.before']).files.find((f) => f.path.endsWith('.json'))!.content as {
    hooks: Record<string, { matcher: string }[]>
  }
  assert.equal(all.hooks.PreToolUse[0].matcher, '')
})

test('HTTP 钩子：给了地址时转发脚本那一项换成 POST 到面板，各事件用自己的地址，不再写转发脚本', () => {
  const spec = getCli('claude')!.hooks!
  assert.ok(spec.http, 'Claude Code 定义里写了 HTTP 钩子')
  const r = hookInstall(spec, '/tmp/run', ['turn.beforeEnd', 'tool.before', 'tool.after'], {
    httpUrl: 'http://127.0.0.1:1/api/mcp/ask/tok/hook',
  })
  assert.ok(!r.files.some((f) => f.path.endsWith(HOOK_SCRIPT)), '没人引用转发脚本就不写')
  assert.deepEqual(r.env, {})
  const cfg = r.files.find((f) => f.path.endsWith('agent-panel-hooks.json'))!.content as {
    hooks: Record<string, { hooks: { type: string; url: string }[] }[]>
  }
  assert.deepEqual(cfg.hooks.Stop[0].hooks[0], {
    type: 'http',
    url: 'http://127.0.0.1:1/api/mcp/ask/tok/hook/turn.beforeEnd',
    timeout: 70,
  })
  assert.equal(cfg.hooks.PreToolUse[0].hooks[0].url, 'http://127.0.0.1:1/api/mcp/ask/tok/hook/tool.before')
  assert.equal(cfg.hooks.PostToolUseFailure[0].hooks[0].url, 'http://127.0.0.1:1/api/mcp/ask/tok/hook/tool.after')
  // 没写 http 的 CLI（Codex）给了地址也照旧用转发脚本
  const codex = hookInstall(getCli('codex')!.hooks!, '/tmp/run', ['turn.beforeEnd'], { httpUrl: 'http://x/hook' })
  assert.ok(codex.files.some((f) => f.path.endsWith(HOOK_SCRIPT)))
})

test('通用的 curl 直连：不支持 HTTP 钩子的命令类钩子，本机有 curl 时调转发脚本的命令换成 curl 直接 POST 到面板', () => {
  const url = 'http://127.0.0.1:1/api/mcp/ask/tok/hook'
  // Codex：参数里的命令换成 curl，地址走环境变量（命令每轮不变，信任一次就够）；不再写转发脚本
  const codex = hookInstall(getCli('codex')!.hooks!, '/tmp/run', ['turn.beforeEnd', 'tool.before'], { curlUrl: url })
  assert.match(codex.args[1], /command='curl -s -f --max-time 65 .*"\$AGENT_PANEL_HOOK_URL\/turn\.beforeEnd"'/)
  assert.match(codex.args[1], /commandWindows='curl\.exe .*"%AGENT_PANEL_HOOK_URL%\/turn\.beforeEnd"'/)
  assert.match(codex.args[3], /\$AGENT_PANEL_HOOK_URL\/tool\.before/)
  assert.ok(!codex.args.join(' ').includes(HOOK_SCRIPT_ENV), '不再引用转发脚本')
  assert.deepEqual(codex.files, [])
  // 老版本 Claude Code（没给 httpUrl）：配置文件里的命令换成 curl，地址直接写进这一轮的配置
  const old = hookInstall(getCli('claude')!.hooks!, '/tmp/run', ['tool.before'], { curlUrl: url }).files[0].content as {
    hooks: Record<string, { hooks: { type: string; command: string }[] }[]>
  }
  assert.equal(old.hooks.PreToolUse[0].hooks[0].type, 'command')
  assert.match(old.hooks.PreToolUse[0].hooks[0].command, new RegExp(`^curl .*"${url}/tool\\.before"$`))
  // 支持 HTTP 钩子时 HTTP 优先
  const now = hookInstall(getCli('claude')!.hooks!, '/tmp/run', ['tool.before'], { curlUrl: url, httpUrl: url })
    .files[0].content as { hooks: Record<string, { hooks: { type: string }[] }[]> }
  assert.equal(now.hooks.PreToolUse[0].hooks[0].type, 'http')
  // 没有 curl：照旧用转发脚本
  assert.ok(hookInstall(getCli('codex')!.hooks!, '/tmp/run', ['tool.before']).args[1].includes(HOOK_SCRIPT_ENV))
})

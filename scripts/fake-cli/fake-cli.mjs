#!/usr/bin/env node
/**
 * 测试用的假 CLI：按 Claude Code / Codex / Command Code 的非交互输出格式吐事件，
 * 并在当前目录写一个文件，用来在没有安装或登录真实 CLI 的环境里测通执行流程。
 *
 * 任务描述里包含 FAIL 会以退出码 1 结束；包含 SLOW 会慢慢输出，方便测试「停止」。
 * 设置环境变量 FAKE_CLI_LOG 后，每次调用的参数、目录和 stdin 会追加写进这个文件。
 */
import { appendFileSync, writeFileSync } from 'node:fs'
import { randomUUID } from 'node:crypto'

const args = process.argv.slice(2)
const kind = args[0] === 'exec' ? 'codex' : args.includes('stream-json') ? 'claude' : 'commandcode'
if (args.includes('--version')) {
  console.log(`${kind}-fake 0.0.1`)
  process.exit(0)
}

let input = ''
for await (const chunk of process.stdin) input += chunk
if (process.env.FAKE_CLI_LOG) {
  const log = process.env.FAKE_CLI_LOG
  appendFileSync(log, JSON.stringify({ kind, args, cwd: process.cwd(), input, pid: process.pid, start: Date.now() }) + '\n')
  // 结束时间单独记一个文件，用来检查并行节点是否真的同时运行
  process.on('exit', () => appendFileSync(`${log}.end`, JSON.stringify({ pid: process.pid, end: Date.now() }) + '\n'))
}

const sleep = (ms) => new Promise((r) => setTimeout(r, ms))
const out = (o) => process.stdout.write(JSON.stringify(o) + '\n')
const slow = input.includes('SLOW')
const fail = input.includes('FAIL')
const resumeIdx = kind === 'codex' ? args.indexOf('resume') : args.indexOf('--resume')
const session = resumeIdx >= 0 ? args[resumeIdx + 1] : randomUUID()
const file = `${kind}-output.txt`
const reply = `这是 ${kind} 的回复。收到 ${input.length} 个字符的任务描述。`

for (let i = 0; i < (slow ? 40 : 1); i++) await sleep(slow ? 250 : 30)

// 「AI 创建」的提示：只回一段说明 + JSON。JSON 由用户消息里的 FAKE_JSON: 指定（一行），
// 带 FAKE_JSON2: 时，收到「不符合要求」的重试提示后改用它，用来测试自动修正
if (input.startsWith('你是「Agent 面板」里的配置助手')) {
  const pick = (tag) => input.match(new RegExp(`${tag}:(.*)`))?.[1]?.trim()
  const json = (input.includes('不符合要求') && pick('FAKE_JSON2')) || pick('FAKE_JSON') || '{}'
  const text = `这是按你的要求生成的配置。\n\n\`\`\`json\n${json}\n\`\`\``
  if (kind === 'claude') {
    out({ type: 'system', subtype: 'init', session_id: session, model: 'claude-fake', cwd: process.cwd() })
    out({ type: 'assistant', message: { id: 'm1', content: [{ type: 'text', text }] } })
    out({ type: 'result', subtype: 'success', is_error: false, result: text, session_id: session, total_cost_usd: 0, usage: {} })
  } else if (kind === 'codex') {
    out({ type: 'thread.started', thread_id: session })
    out({ type: 'item.completed', item: { id: 'item_0', type: 'agent_message', text } })
    out({ type: 'turn.completed', usage: { input_tokens: 1, cached_input_tokens: 0, output_tokens: 1 } })
  } else {
    out({ type: 'event', event: { type: 'run_start', sessionId: session } })
    out({ type: 'event', event: { type: 'message_end', content: [{ type: 'text', text }] } })
    out({ type: 'result', subtype: 'success', sessionId: session, usage: {}, durationMs: 1, finalText: text })
  }
  process.exit(0)
}

if (kind === 'claude') {
  out({ type: 'system', subtype: 'init', session_id: session, model: 'claude-fake', cwd: process.cwd() })
  out({ type: 'stream_event', event: { type: 'message_start', message: { id: 'm1', model: 'claude-fake', usage: { input_tokens: 10, cache_read_input_tokens: 12000, cache_creation_input_tokens: 500 } } } })
  out({ type: 'assistant', message: { id: 'm1', content: [{ type: 'tool_use', id: 't1', name: 'Read', input: { file_path: `${process.cwd()}/README.md` } }] } })
  writeFileSync(file, 'line1\nline2\n')
  out({ type: 'assistant', message: { id: 'm1', content: [{ type: 'tool_use', id: 't2', name: 'Write', input: { file_path: `${process.cwd()}/${file}`, content: 'line1\nline2\n' } }] } })
  out({ type: 'assistant', message: { id: 'm1', content: [{ type: 'tool_use', id: 't3', name: 'Bash', input: { command: 'npm test' } }] } })
  out({ type: 'stream_event', event: { type: 'message_start', message: { id: 'm2', model: 'claude-fake', usage: { input_tokens: 20, cache_read_input_tokens: 13000, cache_creation_input_tokens: 0 } } } })
  out({ type: 'stream_event', event: { type: 'content_block_start', content_block: { type: 'text', text: '' } } })
  for (const part of reply.match(/.{1,6}/g)) out({ type: 'stream_event', event: { type: 'content_block_delta', delta: { type: 'text_delta', text: part } } })
  out({ type: 'assistant', message: { id: 'm2', content: [{ type: 'text', text: reply }] } })
  if (fail) {
    out({ type: 'result', subtype: 'error_during_execution', is_error: true, result: '模拟的失败', session_id: session, usage: {}, total_cost_usd: 0 })
    process.exit(1)
  }
  out({ type: 'result', subtype: 'success', is_error: false, result: reply, session_id: session, total_cost_usd: 0.0123, usage: { input_tokens: 30, cache_read_input_tokens: 25000, cache_creation_input_tokens: 500, output_tokens: 120 } })
} else if (kind === 'codex') {
  out({ type: 'thread.started', thread_id: session })
  out({ type: 'turn.started' })
  out({ type: 'item.started', item: { id: 'item_0', type: 'command_execution', command: "bash -lc 'ls -la'", status: 'in_progress' } })
  out({ type: 'item.completed', item: { id: 'item_0', type: 'command_execution', command: "bash -lc 'ls -la'", aggregated_output: '', exit_code: 0, status: 'completed' } })
  writeFileSync(file, 'a\nb\nc\n')
  out({ type: 'item.completed', item: { id: 'item_1', type: 'file_change', changes: [{ path: `${process.cwd()}/${file}`, kind: 'add' }], status: 'completed' } })
  out({ type: 'item.completed', item: { id: 'item_2', type: 'agent_message', text: reply } })
  if (fail) {
    out({ type: 'turn.failed', error: { message: '模拟的失败' } })
    process.exit(1)
  }
  out({ type: 'turn.completed', usage: { input_tokens: 24000, cached_input_tokens: 20000, output_tokens: 300 } })
} else {
  const ev = (e) => out({ type: 'event', event: e })
  ev({ type: 'run_start', sessionId: session })
  ev({ type: 'message_start' })
  ev({ type: 'tool_queued', toolCallId: 'c1', toolName: 'read_file', input: { path: 'README.md' } })
  writeFileSync(file, 'x\n')
  ev({ type: 'tool_queued', toolCallId: 'c2', toolName: 'write_file', input: { path: file, content: 'x\n' } })
  ev({ type: 'model_request_end', model: 'cmd-fake', usage: { inputTokens: 9000, outputTokens: 80, cacheReadTokens: 1000, cacheWriteTokens: 0 } })
  ev({ type: 'message_start' })
  for (const part of reply.match(/.{1,6}/g)) ev({ type: 'text_delta', delta: part })
  ev({ type: 'message_end', content: [{ type: 'text', text: reply }] })
  if (fail) {
    out({ type: 'result', subtype: 'error', sessionId: session, usage: {}, durationMs: 1, finalText: '', error: '模拟的失败' })
    process.exit(1)
  }
  out({ type: 'result', subtype: 'success', sessionId: session, usage: { inputTokens: 10000, outputTokens: 80, cacheReadTokens: 0, cacheWriteTokens: 0 }, durationMs: 10, finalText: reply })
}

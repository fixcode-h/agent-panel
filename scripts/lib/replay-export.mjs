/**
 * 面板导出的对话包（agent-panel/task，见 shared/task-export.ts）→ 假 CLI 回放用的 Claude Code stream-json 录像
 * （scripts/fake-cli/replay.mjs）。
 *
 * 导出包里存的是面板解析后的消息（正文、思考、工具调用），不是 CLI 原始输出；这里按 Claude Code 的输出形状
 * 把它们拼回去：每条用户消息开一轮（连着的几条算一轮），这一轮里 Agent 的每条回复是一条 assistant 消息，
 * 工具调用拼成 tool_use + tool_result，最后一行 result 带这一轮的用量。消息的时间换成 `_t`，回放时照原来的间隔吐。
 * 拼回去的工具调用只是「看起来调过」：面板自己的工具（MCP）不会真的被调用，回放复现的是事件顺序和时序。
 */

/** 面板的工具种类 → Claude Code 的工具名和参数 */
function toolCall(t) {
  const input = t.input ?? ''
  switch (t.kind) {
    case 'read':
      return { name: 'Read', input: { file_path: t.label } }
    case 'edit':
      return { name: 'Edit', input: { file_path: t.label, old_string: '', new_string: input } }
    case 'run':
      return { name: 'Bash', input: { command: input || t.label } }
    case 'search':
      return { name: 'Grep', input: { pattern: t.label } }
    case 'web':
      return { name: 'WebFetch', input: { url: t.label } }
    default:
      return { name: t.name || 'Tool', input: { label: t.label, ...(input && { input }) } }
  }
}

/** 一轮对话：开头的用户消息和之后到下一条用户消息之前 Agent 的回复 */
export function exportTurns(messages) {
  const turns = []
  for (const m of messages) {
    if (m.role === 'user') {
      const last = turns.at(-1)
      // 连着的几条用户消息（插话、面板推它）算同一轮的开头
      if (last && !last.replies.length) last.users.push(m)
      else turns.push({ users: [m], replies: [] })
    } else if (m.role === 'agent' && turns.length) turns.at(-1).replies.push(m)
  }
  return turns.filter((t) => t.replies.length)
}

/**
 * 转成录像的行（每个元素是一行 JSON 对象）。pick：对话包里哪个对话，默认顶层对话，传子对话 id 取那个子对话
 */
export function exportToReplay(bundle, pick = '') {
  const conv = pick ? (bundle.children ?? []).find((c) => c.id === pick) : bundle.task
  if (!conv) throw new Error(`对话包里没有 id 为 ${pick} 的子对话`)
  const session = `replay-${pick || 'root'}`
  const lines = []
  let tool = 0
  let msg = 0
  for (const turn of exportTurns(conv.messages ?? [])) {
    const t0 = Date.parse(turn.users[0].at) || 0
    const at = (m) => Math.max(0, (Date.parse(m.at) || t0) - t0)
    lines.push({ _t: 0, type: 'system', subtype: 'init', session_id: session, model: 'claude-replay', cwd: '/work' })
    let out = 0
    for (const m of turn.replies) {
      const id = `msg_${++msg}`
      const _t = at(m)
      lines.push({
        _t,
        type: 'stream_event',
        event: { type: 'message_start', message: { id, model: 'claude-replay', usage: { input_tokens: 0 } } },
        session_id: session,
      })
      if (m.thinking)
        lines.push({
          _t,
          type: 'stream_event',
          event: { type: 'content_block_delta', index: 0, delta: { type: 'thinking_delta', thinking: m.thinking } },
          session_id: session,
        })
      if (m.text)
        lines.push({
          _t,
          type: 'stream_event',
          event: { type: 'content_block_delta', index: 1, delta: { type: 'text_delta', text: m.text } },
          session_id: session,
        })
      const calls = (m.tools ?? []).map((x) => ({ id: `toolu_${++tool}`, x, ...toolCall(x) }))
      const content = [
        ...(m.text ? [{ type: 'text', text: m.text }] : []),
        ...calls.map((c) => ({ type: 'tool_use', id: c.id, name: c.name, input: c.input })),
      ]
      out += Math.ceil((m.text?.length ?? 0) / 2)
      lines.push({ _t, type: 'assistant', message: { id, role: 'assistant', content }, session_id: session })
      for (const c of calls)
        lines.push({
          _t: _t + (c.x.ms ?? 0),
          type: 'user',
          message: {
            role: 'user',
            content: [
              {
                type: 'tool_result',
                tool_use_id: c.id,
                content: c.x.output ?? '',
                ...(c.x.failed && { is_error: true }),
              },
            ],
          },
          session_id: session,
        })
    }
    const last = turn.replies.at(-1)
    lines.push({
      _t: at(last),
      type: 'result',
      subtype: 'success',
      is_error: false,
      result: last.text ?? '',
      session_id: session,
      total_cost_usd: 0,
      usage: { input_tokens: 0, output_tokens: out },
    })
  }
  return lines
}

/**
 * 真实 CLI 的验证用：一个按剧本回答的 Anthropic Messages 接口（流式），让真的 Pi 跑完整流程而不花钱、不看模型脸色。
 *
 * 剧本按这一轮用户消息里的标记走（这一轮 = 最后一条纯文字的用户消息之后），每次请求看这一轮已经调过几次工具，
 * 决定下一步调哪个工具还是直接回复。工具名按请求里的 tools 匹配（面板的工具可能带前缀）。
 * 每次请求都记进 log（jsonl），验证脚本据此检查会话里带了什么。
 */
import http from 'node:http'
import { appendFileSync } from 'node:fs'

const textOf = (content) =>
  typeof content === 'string'
    ? content
    : (content ?? [])
        .map((b) =>
          b.type === 'text'
            ? b.text
            : b.type === 'tool_result'
              ? `[tool_result${b.is_error ? ' error' : ''}] ${textOf(b.content)}`
              : '',
        )
        .join('\n')

/** 这一轮：最后一条带文字（不只是工具结果）的用户消息，以及之后模型调过的工具和结果 */
function currentTurn(messages) {
  let start = -1
  for (let i = messages.length - 1; i >= 0; i--) {
    const m = messages[i]
    if (m.role !== 'user') continue
    const blocks = typeof m.content === 'string' ? [{ type: 'text', text: m.content }] : m.content
    if (blocks.some((b) => b.type === 'text' && b.text.trim())) {
      start = i
      break
    }
  }
  const user = start >= 0 ? textOf(messages[start].content) : ''
  const calls = []
  for (const m of messages.slice(start + 1))
    for (const b of typeof m.content === 'string' ? [] : m.content) {
      if (b.type === 'tool_use') calls.push({ name: b.name, input: b.input, result: null })
      if (b.type === 'tool_result') {
        const c = calls.at(-1)
        if (c) c.result = { error: !!b.is_error, text: textOf(b.content) }
      }
    }
  return { user, calls }
}

/** 剧本：返回 { tool, input } 或 { text }，以及这次报的上下文大小 */
function decide(req) {
  const tools = (req.tools ?? []).map((t) => t.name)
  const tool = (name) => tools.find((n) => n === name || n.endsWith(`_${name}`) || n.endsWith(`__${name}`))
  const { user, calls } = currentTurn(req.messages ?? [])
  const n = calls.length
  const last = calls.at(-1)

  // 面板起标题等辅助请求：一句话
  if (user.startsWith('给下面这段对话起一个标题')) return { text: '交接验证' }
  // 父对话：收到子对话的收尾请求，看过验证结果后 finish_child
  const wrap = /【收尾请求】[^\n]*（id ([^）\s]+)）/.exec(user)
  if (wrap && tool('finish_child')) {
    if (n === 0) return { tool: tool('finish_child'), input: { id: wrap[1] } }
    return { text: `收尾结果：${last.result?.text ?? ''}`.slice(0, 400) }
  }
  // 父对话列计划、派子对话（不写 step），然后把计划全标完成：子对话还没合回，面板应该拦下
  if (user.includes('PLAN_PARENT') && tool('create_conversation')) {
    const plan = (status) => ({
      tool: tool('set_plan'),
      input: {
        title: '修图',
        steps: [
          { id: '1', title: '派子对话修图', status: status ?? 'running' },
          { id: '2', title: '汇总', status: status ?? 'pending' },
        ],
      },
    })
    if (n === 0) return plan()
    if (n === 1)
      return {
        tool: tool('create_conversation'),
        input: {
          title: '修图子对话',
          message: 'CHILD_STALL FILE=stall.txt 新建 stall.txt 写一行 hello，验证后收尾。',
        },
      }
    if (n === 2) return plan('done')
    return { text: `计划：${last.result?.text ?? ''}`.slice(0, 600) }
  }
  // 子对话改完后派「版本控制」去收尾（用户实际遇到的做法），被拦下后不调用 submit_merge 就结束这一轮
  if (user.includes('CHILD_STALL')) {
    if (tool('begin_edit') && !calls.some((c) => c.name === tool('begin_edit')))
      return { tool: tool('begin_edit'), input: {} }
    if (tool('begin_edit')) return { text: '独立分支开好了。' }
    // 先列计划：面板在最后补上「收尾：合回父对话所在的分支」
    if (n === 0)
      return {
        tool: tool('set_plan'),
        input: { title: '修图', steps: [{ title: '新建 stall.txt', status: 'running' }] },
      }
    if (n === 1) return { tool: tool('write'), input: { path: 'stall.txt', content: 'hello\n' } }
    if (n === 2)
      return { tool: tool('set_plan'), input: { steps: [{ id: '1', title: '新建 stall.txt', status: 'done' }] } }
    if (n === 3)
      return {
        tool: tool('spawn_agents'),
        input: { tasks: [{ title: '版本收尾', agent: '版本控制', instructions: '本地提交并合回 dev' }] },
      }
    // 派不出去就自己提交、去原目录 git merge（用户日志里子任务就是这么做的），仍然不调用 submit_merge
    if (n === 4)
      return {
        tool: tool('bash'),
        input: {
          command:
            'git add -A && git -c user.name=t -c user.email=t@t commit -qm stall && B=$(git rev-parse --abbrev-ref HEAD) && R=$(dirname "$(git rev-parse --path-format=absolute --git-common-dir)") && git -C "$R" -c user.name=t -c user.email=t@t merge --no-ff -q "$B" -m "子对话自己合并" && echo merged',
        },
      }
    return { text: `已自己合回：${last.result?.text ?? ''}`.slice(0, 600) }
  }
  // 面板提醒还没请父对话收尾：这次照做
  if (user.includes('还没请父对话收尾') && tool('submit_merge')) {
    if (n === 0)
      return {
        tool: tool('submit_merge'),
        input: {
          note: '新建 stall.txt',
          tests: 'cat stall.txt 输出 hello',
          handoff: { files: 'stall.txt — 卡住复现用的标记文件' },
        },
      }
    return { text: '已请父对话收尾。' }
  }
  // 再被叫醒、没有新活的子对话：只回一句，验证脚本看请求里带了什么
  if (user.includes('WAKE_AGAIN') && !user.includes('CHILD_WORK')) return { text: '收到，接着做。', big: true }
  // 子对话：先开独立分支，再在分支里改文件、请父对话收尾
  if (user.includes('CHILD_WORK')) {
    const file = /FILE=(\S+)/.exec(user)?.[1] ?? 'handoff-demo.txt'
    if (tool('begin_edit') && !calls.some((c) => c.name === tool('begin_edit'))) {
      return { tool: tool('begin_edit'), input: {}, big: true }
    }
    if (tool('begin_edit')) return { text: '独立分支开好了，接着在分支里改。', big: true }
    const write = tool('write')
    const submit = tool('submit_merge')
    if (!submit) return { text: `没有 submit_merge（工具：${tools.join(', ')}）`, big: true }
    if (n === 0) return { tool: write, input: { path: file, content: 'hello\n' }, big: true }
    // 第一次故意不写 handoff：工具参数校验（Pi 按 schema）就拦下
    if (n === 1) return { tool: submit, input: { note: `新建 ${file}`, tests: '人工检查文件内容' }, big: true }
    // 第二次 files 写成空白：过得了 schema，面板应该拒绝并给模板
    if (n === 2)
      return {
        tool: submit,
        input: { note: `新建 ${file}`, tests: '人工检查文件内容', handoff: { files: '  ', decisions: '只写一个文件' } },
        big: true,
      }
    if (n === 3)
      return {
        tool: submit,
        input: {
          note: `新建 ${file}`,
          tests: `cat ${file} 输出 hello`,
          handoff: {
            files: `${file} — 交接验证用的标记文件，内容一行 hello`,
            docs: 'docs/adr/0007-child-handoff-on-done.md',
            decisions: '只写一个文件，不动其他代码',
            pitfalls: '第一次 submit_merge 没写 handoff 被拒绝',
            followups: '无',
          },
        },
        big: true,
      }
    return { text: `已请父对话收尾：${last.result?.text ?? ''}`.slice(0, 400), big: true }
  }
  return { text: '好的。' }
}

function sse(res, model, step) {
  res.writeHead(200, { 'content-type': 'text/event-stream', 'cache-control': 'no-cache' })
  const ev = (type, data) => res.write(`event: ${type}\ndata: ${JSON.stringify({ type, ...data })}\n\n`)
  // 上下文大的对话报 4.2 万 token，交接摘要的叫醒判定（≥ 3 万）要用
  const input = step.big ? 42_000 : 5_000
  const id = `msg_${Date.now()}_${Math.random().toString(36).slice(2, 8)}`
  ev('message_start', {
    message: {
      id,
      type: 'message',
      role: 'assistant',
      model,
      content: [],
      stop_reason: null,
      stop_sequence: null,
      usage: { input_tokens: input, output_tokens: 1, cache_read_input_tokens: 0, cache_creation_input_tokens: 0 },
    },
  })
  if (step.tool) {
    ev('content_block_start', {
      index: 0,
      content_block: { type: 'tool_use', id: `toolu_${id}`, name: step.tool, input: {} },
    })
    ev('content_block_delta', {
      index: 0,
      delta: { type: 'input_json_delta', partial_json: JSON.stringify(step.input) },
    })
  } else {
    ev('content_block_start', { index: 0, content_block: { type: 'text', text: '' } })
    ev('content_block_delta', { index: 0, delta: { type: 'text_delta', text: step.text } })
  }
  ev('content_block_stop', { index: 0 })
  ev('message_delta', {
    delta: { stop_reason: step.tool ? 'tool_use' : 'end_turn', stop_sequence: null },
    usage: { output_tokens: 20 },
  })
  ev('message_stop', {})
  res.end()
}

/** 起服务；返回 { port, close } */
export function startMockModel({ log }) {
  const server = http.createServer((req, res) => {
    let body = ''
    req.on('data', (c) => (body += c))
    req.on('end', () => {
      if (req.method === 'GET' && req.url.includes('/models')) {
        res.setHeader('content-type', 'application/json')
        return res.end(JSON.stringify({ data: [{ id: 'mock-sonnet', type: 'model', display_name: 'Mock' }] }))
      }
      if (req.method !== 'POST' || !req.url.includes('/messages')) {
        res.statusCode = 404
        return res.end()
      }
      let parsed
      try {
        parsed = JSON.parse(body)
      } catch {
        res.statusCode = 400
        return res.end()
      }
      const { user, calls } = currentTurn(parsed.messages ?? [])
      const step = decide(parsed)
      // SMALL_CTX：上下文小的子对话，再叫醒时应该接回原会话
      if (user.includes('SMALL_CTX')) step.big = false
      if (log)
        appendFileSync(
          log,
          JSON.stringify({
            at: Date.now(),
            url: req.url,
            system: textOf(parsed.system),
            messages: parsed.messages.length,
            firstUser: textOf(parsed.messages.find((m) => m.role === 'user')?.content),
            user,
            calls: calls.map((c) => ({ name: c.name, error: c.result?.error, result: c.result?.text?.slice(0, 600) })),
            tools: (parsed.tools ?? []).map((t) => t.name),
            reply: step,
          }) + '\n',
        )
      if (parsed.stream === false) {
        res.statusCode = 400
        return res.end(JSON.stringify({ error: { type: 'invalid_request_error', message: '只支持流式' } }))
      }
      sse(res, parsed.model, step)
    })
  })
  return new Promise((resolve) =>
    server.listen(0, '127.0.0.1', () =>
      resolve({
        port: server.address().port,
        close: () => {
          server.closeAllConnections()
          server.close()
        },
      }),
    ),
  )
}

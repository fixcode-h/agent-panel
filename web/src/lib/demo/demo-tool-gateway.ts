/**
 * 演示：工具网关（ADR 0084）。演示没有真的 CLI 钩子，放一组示例调用记录（按真的网关同一套认调用、推算改道算出来，
 * 不手写 wouldRoute），列表、统计、能力表调 shared/tool-gateway 里和服务端同一份逻辑；几条路的状态是本机才有的事实，演示里写死。
 * 隔一会儿「来」一条新调用，发 tool-call 窗口事件（演示没有推送通道），调用记录页跟着变。
 * 改完 Lua 面板自动检查（ADR 0086）：一批改动怎么记、什么时候跑、那一行长什么样也用 shared 的同一份；只有检查结果是写好的（演示不起进程）
 */
import type { CapabilityId } from '@shared/capability-router/types'
import { classifyCall, callSummary, readOnlyCall } from '@shared/tool-gateway/classify'
import { proxiedCallOf } from '@shared/mcp-proxy/names'
import { decide } from '@shared/tool-gateway/decide'
import { gatewayStats, isSerial } from '@shared/tool-gateway/stats'
import { GatewaySettings, type CallRecord, type GatewayMode } from '@shared/tool-gateway/types'
import { callPage, callQueryOf, capabilityViews, patchGatewaySettings, settingsView } from '@shared/tool-gateway/views'
import type { CapabilityView } from '@shared/api-contract/tool-gateway'
import { customToolSigs } from '@shared/custom-tools/match'
import { newBatch, noteEdits, takeBatch } from '@shared/tool-gateway/verify/batch'
import { verifyRecord } from '@shared/tool-gateway/verify/record'
import { verifyNote } from '@shared/tool-gateway/verify/text'
import type { VerifyRun } from '@shared/tool-gateway/verify/types'
import { DEMO_TOOL_CALL_EVENT } from '@/lib/live/tool-calls'
import { demoProjectTools } from './demo-custom-tools'
import { fail } from './demo-http'
import { CPP_GREP, LUA_REFS, demoTakeover, type DemoTakeover } from './demo-takeover'

type Sample = {
  task: [string, string]
  tool: string
  kind: 'shell' | 'edit' | 'read' | 'panel' | 'any'
  input: Record<string, unknown>
  /** 面板工具去掉前缀的名字（默认 find） */
  panel?: string
  deny?: string
  skills?: [string, number][]
  pushes?: [string, number][]
  /** 改道模式下被查找接管的（第二期）：面板查到了什么 */
  takeover?: DemoTakeover
  dur: number
}

const SHOP: [string, string] = ['demo-child-bag', '子对话 · 购物车日志']
const FLOW: [string, string] = ['demo-flow-bag', '工作流 · 背包重构 › 开发']
const MAIN: [string, string] = ['demo-main', '父对话']

const SAMPLES: Sample[] = [
  {
    task: SHOP,
    tool: 'Edit',
    kind: 'edit',
    input: { file_path: 'Content/Script/UI/Bag.lua' },
    skills: [['lua-code-style', 2400]],
    dur: 3,
  },
  { task: SHOP, tool: 'Edit', kind: 'edit', input: { file_path: 'Content/Script/UI/Shop.lua' }, dur: 4 },
  {
    task: SHOP,
    tool: 'Bash',
    kind: 'shell',
    input: { command: 'rg -n "OnSellAll" Content/Script' },
    takeover: LUA_REFS,
    dur: 182,
  },
  { task: SHOP, tool: 'Bash', kind: 'shell', input: { command: 'luac -p Content/Script/UI/Bag.lua' }, dur: 410 },
  {
    task: SHOP,
    tool: 'Bash',
    kind: 'shell',
    input: { command: 'npm test' },
    pushes: [['builtin:push-lessons', 180]],
    dur: 3950,
  },
  { task: FLOW, tool: 'mcp__uetovs__search_symbols', kind: 'any', input: { query: 'BagPanel' }, dur: 96 },
  { task: FLOW, tool: 'Read', kind: 'read', input: { file_path: 'Source/Shop/BagPanel.h' }, dur: 12 },
  { task: FLOW, tool: 'Read', kind: 'read', input: { file_path: 'Source/Shop/BagPanel.cpp' }, dur: 15 },
  { task: FLOW, tool: 'Grep', kind: 'read', input: { pattern: 'UBagPanel::Refresh' }, takeover: CPP_GREP, dur: 40 },
  // 改道模式下拿不准的照原样跑：管道接 head 是两段，不接管
  { task: FLOW, tool: 'Bash', kind: 'shell', input: { command: 'grep -rn "TODO" Source | head -20' }, dur: 35 },
  {
    task: FLOW,
    tool: 'Bash',
    kind: 'shell',
    input: { command: 'git push origin main' },
    deny: 'builtin:push-guard',
    skills: [['project-vcs', 1800]],
    dur: 4,
  },
  {
    task: FLOW,
    tool: 'PowerShell',
    kind: 'shell',
    input: { command: '& "D:/UE_5.4/Engine/Build/BatchFiles/Build.bat" ShopEditor Win64 Development' },
    dur: 2,
  },
  { task: MAIN, tool: 'Read', kind: 'read', input: { file_path: 'Content/UI/WBP_Bag.uasset' }, dur: 230 },
  { task: MAIN, tool: 'Bash', kind: 'shell', input: { command: 'git status --short | head -20' }, dur: 60 },
  { task: MAIN, tool: 'mcp__panel__find', kind: 'panel', input: { kind: 'refs', query: 'OnSellAll' }, dur: 140 },
  // 经面板代理的外部工具（ADR 0085）：Agent 调的是 more_tools，记录里按 idea 的 lua_debug_inspect 记
  {
    task: SHOP,
    tool: 'mcp__panel__more_tools',
    kind: 'panel',
    panel: 'more_tools',
    input: { name: 'idea/lua_debug_inspect', arguments: { action: 'stack' } },
    dur: 85,
  },
]

const claimCtx = () => ({
  customTools: customToolSigs(demoProjectTools().map((tool) => ({ scope: 'project' as const, file: '', tool }))),
  // 演示的父对话是 UE 项目：挂着 request_build
  build: 'parent' as const,
})

/** 演示的检查结果（不起进程）：Shop.lua 第 42 行少了 end，别的通过 */
function demoVerify(
  tool: string,
  files: string[],
): { run: VerifyRun; errors: { file: string; line: number; msg: string }[] } {
  const bad = files
    .filter((f) => f.endsWith('Shop.lua'))
    .map((file) => ({ file, line: 42, msg: "'end' expected near <eof>" }))
  const name = demoProjectTools().find((x) => x.id === tool)?.name ?? tool
  return {
    run: { trigger: 'auto', tool, name, files, outcome: bad.length ? 'errors' : 'ok', errors: bad.length, ms: 380 },
    errors: bad,
  }
}

function record(s: Sample, i: number, at: number, prev?: CallRecord): CallRecord {
  const raw = classifyCall(
    {
      kind: s.kind,
      name: s.tool,
      input: s.input,
      path: String(s.input.file_path ?? ''),
      paths: [],
      panel: s.kind === 'panel' ? (s.panel ?? 'find') : '',
    },
    { cli: 'claude', spec: { searchTools: ['Grep', 'Glob'] } },
  )
  const call = proxiedCallOf(raw) ?? raw
  const d = decide(call, claimCtx(), !!s.deny)
  const readOnly = readOnlyCall(call)
  const r: CallRecord = {
    id: `demo-call-${i}`,
    at,
    projectId: 'demo-shop',
    taskId: s.task[0],
    taskTitle: s.task[1],
    turn: s.task[0],
    cli: 'claude',
    tool: s.tool,
    kind: call.kind,
    summary: callSummary(call),
    input: JSON.stringify(s.input),
    ...(call.kind === 'mcp' && call.server
      ? { mcp: { server: call.server, tool: call.mcpTool ?? '', ...(call.proxied ? { proxied: true } : {}) } }
      : {}),
    ...(call.command?.category ? { category: call.command.category } : {}),
    ...(call.command ? { segments: call.command.segments } : {}),
    ...d,
    ...(s.takeover ? demoTakeover(call, s.takeover) : {}),
    ...(s.deny ? { denyBy: s.deny } : {}),
    ...(s.pushes ? { pushes: s.pushes.map(([id, chars]) => ({ id, chars })) } : {}),
    ...(s.skills
      ? { skills: s.skills.map(([skill, chars]) => ({ skill, chars, tokens: Math.round(chars / 1.4) })) }
      : {}),
    ms: 0.08 + (i % 4) * 0.03,
    hookMs: 1.2 + (i % 3),
    // 代答的不会执行，没有工具后
    ...(s.deny || s.takeover?.output !== undefined ? {} : { durMs: s.dur }),
    ...(readOnly ? { readOnly } : {}),
  }
  if (isSerial(prev, r)) r.serial = true
  return r
}

let gw: { mode: GatewayMode; projects: Record<string, GatewayMode> } = GatewaySettings.parse({})
const records: CallRecord[] = []
// 改完自动校验的一批（按对话记）：改 Lua 时记下，这个对话下一个不是改文件的调用前跑一次
const batches = new Map<string, ReturnType<typeof newBatch>>()

/** 记一条示例调用；改完 Lua 后的第一个别的调用前，先记一行面板自己跑的校验，报错推给这次调用 */
function push(s: Sample, i: number, at: number) {
  const b = batches.get(s.task[0]) ?? newBatch()
  batches.set(s.task[0], b)
  const r = record(s, i, at, records[0])
  if (s.kind === 'edit') {
    const verifiers = demoProjectTools().filter((x) => x.role?.kind === 'verify')
    noteEdits(
      b,
      [String(s.input.file_path ?? '')],
      verifiers.map((x) => ({ id: x.id, paths: x.role!.paths })),
    )
  } else if (!s.deny) {
    const outs = takeBatch(b).map((x) => ({ ...demoVerify(x.tool, x.files), tail: [] }))
    for (const o of outs)
      records.unshift(
        verifyRecord(
          {
            id: `demo-verify-${i}-${o.run.tool}`,
            at: at - 400,
            projectId: r.projectId,
            taskId: r.taskId,
            taskTitle: r.taskTitle,
            turn: r.turn,
            cli: r.cli,
          },
          o.run,
        ),
      )
    const note = verifyNote(outs)
    if (note) r.pushes = [...(r.pushes ?? []), { id: 'verify:lua-check', chars: note.length }]
  }
  records.unshift(r)
  return r
}

{
  const t0 = Date.now() - SAMPLES.length * 40_000
  SAMPLES.forEach((s, i) => push(s, i, t0 + i * 40_000))
}
let next = SAMPLES.length
let ticking = false

/** 页面打开调用记录后隔一会儿来一条新的，看推送怎么进表 */
function tick() {
  // 契约测试在 Node 里跑演示后端：没有页面就不来新记录（也免得测试结束后还有定时器）
  if (ticking || typeof window === 'undefined') return
  ticking = true
  setTimeout(() => {
    ticking = false
    const s = SAMPLES[next % SAMPLES.length]
    const r = push(s, next++, Date.now())
    window.dispatchEvent(new CustomEvent(DEMO_TOOL_CALL_EVENT, { detail: { call: r } }))
  }, 8000)
}

const ROUTES: Partial<Record<CapabilityId, CapabilityView['routes']>> = {
  find: [
    { id: 'ue:uetovs.search_symbols', label: 'ue:uetovs.search_symbols · cpp', state: 'ready' },
    { id: 'ue:idea.lua_code', label: 'ue:idea.lua_code · lua', state: 'starting', why: '建索引中，约 20 秒' },
    { id: 'panel.text', label: '面板按文本找（兜底）', state: 'ready' },
  ],
  verify: [{ id: 'custom_tool:lua-check', label: '自建工具 · Lua 检查', state: 'ready' }],
}

export function demoToolGateway(method: string, seg: string[], query: URLSearchParams, body: unknown): unknown {
  const sub = seg[1]
  const projectId = query.get('projectId') ?? ''
  const list = projectId ? records.filter((r) => r.projectId === projectId) : records
  if (sub === 'calls') {
    tick()
    return callPage(
      list,
      callQueryOf((k) => query.get(k)),
    )
  }
  if (sub === 'stats') return gatewayStats(list, Number(query.get('n')) || 200)
  if (sub === 'settings') {
    if (method === 'PUT') {
      const r = patchGatewaySettings(gw, (body ?? {}) as Parameters<typeof patchGatewaySettings>[1])
      if ('error' in r) return fail(r.error)
      gw = r.next
    }
    return settingsView(gw.mode, gw.projects)
  }
  if (sub === 'capabilities')
    return capabilityViews(list, (id) => ROUTES[id] ?? [{ id: `${id}:planned`, label: '还没接上', state: 'planned' }])
  return fail('没有这个接口')
}

/**
 * 演示：工具网关（ADR 0084）。演示没有真的 CLI 钩子，放一组示例调用记录（按真的网关同一套认调用、推算改道算出来，
 * 不手写 wouldRoute），列表、统计、能力表调 shared/tool-gateway 里和服务端同一份逻辑；几条路的状态是本机才有的事实，演示里写死。
 * 隔一会儿「来」一条新调用，发 tool-call 窗口事件（演示没有推送通道），调用记录页跟着变
 */
import type { CapabilityId } from '@shared/capability-router/types'
import { classifyCall, callSummary, readOnlyCall } from '@shared/tool-gateway/classify'
import { decide } from '@shared/tool-gateway/decide'
import { gatewayStats, isSerial } from '@shared/tool-gateway/stats'
import { GatewaySettings, type CallRecord, type GatewayMode } from '@shared/tool-gateway/types'
import { callPage, callQueryOf, capabilityViews, settingsView } from '@shared/tool-gateway/views'
import type { CapabilityView } from '@shared/api-contract/tool-gateway'
import { DEMO_TOOL_CALL_EVENT } from '@/lib/live/tool-calls'
import { fail } from './demo-http'

type Sample = {
  task: [string, string]
  tool: string
  kind: 'shell' | 'edit' | 'read' | 'panel' | 'any'
  input: Record<string, unknown>
  deny?: string
  skills?: [string, number][]
  pushes?: [string, number][]
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
  { task: SHOP, tool: 'Bash', kind: 'shell', input: { command: 'rg -n "OnSellAll" Content/Script' }, dur: 182 },
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
  { task: FLOW, tool: 'Grep', kind: 'read', input: { pattern: 'UBagPanel::Refresh' }, dur: 40 },
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
]

const CUSTOM = [{ id: 'lua-check', name: 'Lua 检查', sigs: ['luac'] }]

function record(s: Sample, i: number, at: number, prev?: CallRecord): CallRecord {
  const call = classifyCall(
    {
      kind: s.kind,
      name: s.tool,
      input: s.input,
      path: String(s.input.file_path ?? ''),
      paths: [],
      panel: s.kind === 'panel' ? 'find' : '',
    },
    { cli: 'claude', spec: { searchTools: ['Grep', 'Glob'] } },
  )
  const d = decide(call, { customTools: CUSTOM }, !!s.deny)
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
    ...(call.command?.category ? { category: call.command.category } : {}),
    ...(call.command ? { segments: call.command.segments } : {}),
    ...d,
    ...(s.deny ? { denyBy: s.deny } : {}),
    ...(s.pushes ? { pushes: s.pushes.map(([id, chars]) => ({ id, chars })) } : {}),
    ...(s.skills
      ? { skills: s.skills.map(([skill, chars]) => ({ skill, chars, tokens: Math.round(chars / 1.4) })) }
      : {}),
    ms: 0.08 + (i % 4) * 0.03,
    hookMs: 1.2 + (i % 3),
    ...(s.deny ? {} : { durMs: s.dur }),
    ...(readOnly ? { readOnly } : {}),
  }
  if (isSerial(prev, r)) r.serial = true
  return r
}

let mode: GatewayMode = GatewaySettings.parse({}).mode
const records: CallRecord[] = []
{
  const t0 = Date.now() - SAMPLES.length * 40_000
  SAMPLES.forEach((s, i) => records.unshift(record(s, i, t0 + i * 40_000, records[0])))
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
    const r = record(s, next++, Date.now(), records[0])
    records.unshift(r)
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
    if (method === 'PUT') mode = GatewaySettings.parse(body).mode
    return settingsView(mode)
  }
  if (sub === 'capabilities')
    return capabilityViews(list, (id) => ROUTES[id] ?? [{ id: `${id}:planned`, label: '还没接上', state: 'planned' }])
  return fail('没有这个接口')
}

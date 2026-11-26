/**
 * 演示：改道模式下的查找接管（ADR 0084 第二期）。演示没有真的 CLI 和索引，给两次搜索「面板查到了什么」，
 * 改写还是代答、改写成什么命令、有没有可补的都按 shared/tool-gateway/takeover.ts 里和服务端同一份逻辑算，不手写。
 * Claude Code 的 rg 走改写（CLI 定义 takeover.rewrite），Grep 只能代答
 */
import type { FindHit } from '@shared/capability-router/find/types'
import type { ToolRoute } from '@shared/capability-router/tool-route'
import { getCli } from '@shared/clis'
import { DEFAULT_TAKEOVER } from '@shared/tool-gateway/takeover-spec'
import { normPath, panelExtras, panelSection, planTakeover, rewriteCommand } from '@shared/tool-gateway/takeover'
import type { CallRecord, ToolCall } from '@shared/tool-gateway/types'

/** 一次被接管的搜索：面板查到的命中和走过的路；output 是代答时原命令照原样跑出来的（有它就是代答、不会执行） */
export interface DemoTakeover {
  hits: FindHit[]
  route: ToolRoute
  output?: string
}

export const LUA_REFS: DemoTakeover = {
  hits: [
    { file: 'Content/Script/UI/BagPanel.lua', line: 212, text: 'function BagPanel:OnSellAll()', rank: 0 },
    {
      file: 'Content/Script/UI/BagPanel.lua',
      line: 88,
      text: 'self.BtnSell.OnClicked:Add(self, self.OnSellAll)',
      rank: 1,
    },
    { file: 'Content/Script/UI/ShopPanel.lua', line: 41, text: 'Bag:Call("On" .. action)', rank: 1 },
  ],
  route: {
    capability: 'find',
    served: [
      { source: 'ue:idea.lua_code', label: 'idea · lua_code', via: 'mcp' },
      { source: 'panel.text', label: '面板按文本找', via: 'panel' },
    ],
    steps: [
      { source: 'ue:idea.lua_code', label: 'idea · lua_code', via: 'mcp', outcome: 'used', ms: 140 },
      { source: 'panel.text', label: '面板按文本找', via: 'panel', outcome: 'used', ms: 38 },
    ],
    ms: 182,
  },
}

export const CPP_GREP: DemoTakeover = {
  hits: [
    {
      file: 'Source/Shop/BagPanel.h',
      line: 24,
      text: 'void Refresh();',
      name: 'Refresh',
      kind: 'method',
      container: 'UBagPanel',
      rank: 0,
    },
    { file: 'Source/Shop/BagPanel.cpp', line: 57, text: 'void UBagPanel::Refresh()', rank: 1 },
  ],
  route: {
    capability: 'find',
    served: [{ source: 'ue:uetovs.search_symbols', label: 'uetovs · search_symbols', via: 'mcp' }],
    steps: [
      { source: 'ue:uetovs.search_symbols', label: 'uetovs · search_symbols', via: 'mcp', outcome: 'used', ms: 64 },
    ],
    ms: 70,
  },
  output: 'Source/Shop/BagPanel.cpp\nSource/Shop/ShopWidget.cpp\n',
}

/** 按 Claude Code 的定义算这次接管：改写 / 代答、改写后的输入、走过的路；拿不准的返回放行原因 */
export function demoTakeover(call: ToolCall, d: DemoTakeover): Partial<CallRecord> {
  const cli = getCli('claude')
  const plan = planTakeover(call, {
    takeover: cli?.takeover ?? DEFAULT_TAKEOVER,
    rewriteTpl: cli?.hooks?.events['tool.before']?.rewrite !== undefined,
  })
  if (!plan) return {}
  if (plan.how === 'pass') return { takeoverWhy: plan.why }
  const original = String(call.input.command ?? '')
  const route: ToolRoute = {
    ...d.route,
    from: call.kind === 'shell' ? original : `${call.tool} ${plan.search.pattern}`,
  }
  const paths = plan.search.paths.map(normPath)
  const { decls, extras } = panelExtras(d.hits, plan.search, paths)
  const served = route.served.map((x) => x.label).join(' + ')
  if (plan.how === 'rewrite') {
    if (!panelSection({ decls, extras, served })) return { takeoverWhy: '面板没有多出来的结果', route }
    const input = {
      ...call.input,
      command: rewriteCommand(original, 'C:/Users/demo/AppData/Local/Temp/agent-panel-takeover/7f3a.mjs'),
    }
    return { decision: 'rewrite', rewritten: JSON.stringify(input), route }
  }
  // 代答的全文（serveText）只交给 Agent，调用记录里只记决定和走过的路
  return { decision: 'serve', route }
}

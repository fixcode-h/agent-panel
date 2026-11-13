/**
 * 「给谁」：每类对话可能拿到的面板工具（设置 →「MCP」）。
 * 每类给一个能力全开的代表（角色和项目设置都开到最多），用注册表里各工具同一个 when() 判断；
 * 真实对话拿到的是它的子集。代表和执行引擎（shared/engine.ts 的 makeOrchestra）对得上由
 * server/orch-mcp.test.ts 的「面板工具按身份裁剪」核对：每个真实身份的清单都包含在同类代表的清单里。
 */
import type { Orchestra } from '../../shared/engine/host.ts'
import type { Audience } from '../../shared/mcp-catalog/types.ts'

const ok = () => ({ ok: true, info: '' })
const lessons = { find: async () => '', record: ok }
const experience = { find: async () => '', record: ok }
const base = { common: [], runs: {} }

// 项目里的对话（父对话、子对话）共有的
const conv = {
  canSpawn: true,
  team: true,
  autoReturn: true,
  plans: true,
  canBackground: true,
  lessons,
  experience,
  endTurn: ok,
  requestUserAction: ok,
  capabilities: true,
  p4Split: ok,
  diagnose: ok,
}

export const AUDIENCE_REPS: Record<Audience, Orchestra> = {
  parent: {
    ...base,
    ...conv,
    self: '@chat',
    parentOf: true,
    coordinator: true,
    peers: true,
    planning: true,
    inlineEdit: true,
    canBeginEdit: true,
    ueBuild: 'parent',
    cherryPick: ok,
    askPush: ok,
  },
  child: {
    ...base,
    ...conv,
    self: '@chat',
    child: true,
    canSubmit: true,
    claims: true,
    canBeginEdit: true,
    ueBuild: 'child',
  },
  helper: {
    ...base,
    self: '@chat/sub/h1',
    helper: true,
    team: true,
    canBackground: true,
    sharedState: true,
    lessons: { find: lessons.find },
    experience: { find: experience.find },
    submitResult: ok,
    submitVerdict: ok,
  },
  node: {
    ...base,
    self: 'a',
    canSpawn: true,
    team: true,
    sharedState: true,
    canBackground: true,
    lessons,
    experience,
    submitVerdict: ok,
    // 工作流子对话跑的节点：和子对话一样能回报父对话、认领文件
    child: true,
    canSubmit: true,
    claims: true,
  },
  chat: { ...base, self: '@chat', autoReturn: true, canBackground: true, remember: ok },
} as unknown as Record<Audience, Orchestra>

/**
 * 不在注册表里、挂在同一个服务上的几个：提问、补充、等下一句只给用户在聊的对话（还要看 CLI 有没有自己的提问协议），
 * 操控软件的两个也只给对话（server/exec/invoke.ts：o.orch && o.app）
 */
export const EXTRA_AUDIENCE: Record<string, Audience[]> = {
  ask_user: ['parent', 'child', 'chat'],
  read_user_notes: ['parent', 'child', 'helper', 'node', 'chat'],
  wait_user_message: ['parent', 'child', 'chat'],
  app_actions: ['parent', 'child', 'chat'],
  app_do: ['parent', 'child', 'chat'],
}

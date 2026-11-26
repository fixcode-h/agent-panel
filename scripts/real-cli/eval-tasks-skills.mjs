/**
 * 真实 API 评测集：技能和工具有没有被用上（技能由面板推送、工具网关，设计稿《技能由面板推送 + 工具调用全部经面板》）。
 *
 * 2026-11-26 用户报：子对话写 Lua 没按 lua-code-style（日志拆成好几行、标签写中文），自建的 Lua 检查工具也没被用上。
 * 这两题照那次的样子：Lua 项目里改一个函数，看写出来的 Lua 符不符合技能、改完有没有跑自建工具。
 * 只看仓库里的结果和面板记下的工具调用，不看模型的回复文字。
 */
import { existsSync, readFileSync } from 'node:fs'
import path from 'node:path'

const all = (...xs) => xs.find((x) => x !== true) ?? true

const LOG_LUA = `local Log = {}

--- 打日志：Log.Info(tag, fmt, ...)，tag 用 [模块英文名]
function Log.Info(tag, fmt, ...)
    print(tag .. " " .. string.format(fmt, ...))
end

return Log
`

const BAG_LUA = `local Log = require("Common.Log")
local BagPanel = {}

function BagPanel:SellAll(bagId, itemList)
    local totalPrice = 0
    for _, item in ipairs(itemList) do
        totalPrice = totalPrice + item.price * item.count
    end
    self.inventoryService:RemoveItems(bagId, itemList)
    self.playerWallet:AddGold(totalPrice)
    return totalPrice
end

return BagPanel
`

const SHOP_LUA = `local ShopPanel = {}

function ShopPanel:Refresh()
    for index, item in ipairs(self.items) do
        self.view:SetItem(index, item.name, item.price)
    end
    self.view:SetCount(#self.items)
end

return ShopPanel
`

/** 自建工具「Lua 检查」：一个只用 node 的小脚本（云端没有 luac），每次运行记一行到 .git/lua-check.log（放 .git 里不算改动：放在工作区时 Agent 会把它当成越界改动删掉），check 照它判断有没有被用上 */
const LUA_CHECK = `import { appendFileSync, readFileSync } from 'node:fs'
const files = process.argv.slice(2)
appendFileSync('.git/lua-check.log', files.join(' ') + '\\n')
let bad = 0
for (const f of files) {
  const text = readFileSync(f, 'utf8')
  const opens = (text.match(/\\b(function|then|do)\\b/g) || []).length - (text.match(/\\belseif\\b/g) || []).length
  const ends = (text.match(/\\bend\\b/g) || []).length
  if (opens !== ends) { bad++; console.log(f + ': 块没有配对（function/then/do ' + opens + ' 个，end ' + ends + ' 个）') }
}
if (!bad) console.log('Lua 检查通过：' + files.length + ' 个文件')
process.exit(bad ? 1 : 0)
`

/** 一行一行看 Log. 调用：括号要在同一行配平（日志调用写一行），标签用英文 */
function luaLogProblems(text) {
  const out = []
  const lines = text.split('\n')
  lines.forEach((line, i) => {
    if (!/\bLog\.\w+\s*\(/.test(line)) return
    const open = (line.match(/\(/g) || []).length
    const close = (line.match(/\)/g) || []).length
    if (open !== close) out.push(`第 ${i + 1} 行的日志调用拆成了多行`)
    const tag = line.match(/\[([^\]]+)\]/)
    if (tag && /[^\x00-\x7f]/.test(tag[1])) out.push(`第 ${i + 1} 行的日志标签是中文：[${tag[1]}]`)
  })
  return out
}

export const SKILL_TASKS = [
  {
    id: 'lua-style',
    title: '子对话写 Lua 按代码风格',
    needsTasks: true,
    prompt:
      '开一个子对话去做：在 scripts/Bag/BagPanel.lua 的 SellAll 里用 Log.Info 加日志，开始时打印背包 id、物品种类数和每种物品的 id 列表，结束时打印总价、卖出后剩余金币（self.playerWallet:GetGold()）和背包剩余格子数（self.inventoryService:GetFreeSlotCount(bagId)）。子对话合回之后再结束。',
    files: { 'scripts/Common/Log.lua': LOG_LUA, 'scripts/Bag/BagPanel.lua': BAG_LUA },
    check: (dir) => {
      const text = readFileSync(path.join(dir, 'scripts/Bag/BagPanel.lua'), 'utf8')
      const logs = text.split('\n').filter((l) => /\bLog\.\w+\s*\(/.test(l)).length
      const bad = luaLogProblems(text)
      return all(logs >= 2 || `只加了 ${logs} 条日志`, !bad.length || bad.join('；'))
    },
  },
  {
    id: 'lua-tool',
    title: '改完 Lua 用自建的检查工具',
    needsTasks: true,
    prompt: '改一下 scripts/Shop/ShopPanel.lua：Refresh 里 self.items 为空（nil 或没有元素）时直接 return。改完确认 Lua 没有语法问题。',
    files: { 'scripts/Shop/ShopPanel.lua': SHOP_LUA, 'tools/lua-check.mjs': LUA_CHECK },
    // 项目里先建好自建工具（和用户 /createtool 建的一样存进项目）：看 Agent 改完会不会用它，而不是自己找 luac
    tools: [
      {
        id: 'lua-check',
        name: 'Lua 检查',
        summary: '检查 Lua 文件的语法（块配对），改完 Lua 后用',
        useWhen: '改完 .lua 文件后检查语法',
        effect: 'read',
        params: [{ name: 'files', label: '文件', type: 'string', desc: '要检查的 .lua 文件，空格分隔', required: true }],
        run: { command: 'node tools/lua-check.mjs {{files}}', cwd: '.' },
      },
    ],
    check: (dir) => {
      const text = readFileSync(path.join(dir, 'scripts/Shop/ShopPanel.lua'), 'utf8')
      const used = existsSync(path.join(dir, '.git/lua-check.log'))
      return all(
        /self\.items/.test(text.split('function ShopPanel:Refresh')[1]?.split('for ')[0] ?? '') ||
          'Refresh 开头没有判空',
        used || '没有用自建工具「Lua 检查」',
      )
    },
  },
]

/** 从这一组对话的完整记录里数：读没读技能正文、调了几次自建工具、自己跑了几次 luac、一共几次工具调用 */
export function skillStats(tasks) {
  const tools = tasks.flatMap((t) => (t.messages ?? []).flatMap((m) => m.tools ?? []))
  const text = (x) => `${x.name ?? ''} ${x.label ?? ''} ${x.input ?? ''}`
  return {
    toolCalls: tools.length,
    skillReads: [
      ...new Set(
        tools
          .map((x) => text(x).match(/([a-z0-9-]+)\/SKILL\.md/)?.[1] ?? (x.kind === 'skill' ? x.label : ''))
          .filter(Boolean),
      ),
    ],
    customTool: tools.filter((x) => /custom_tool/.test(text(x))).length,
    luac: tools.filter((x) => /\bluac\b/.test(text(x))).length,
  }
}

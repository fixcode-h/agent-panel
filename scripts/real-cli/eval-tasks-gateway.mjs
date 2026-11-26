/**
 * 真实 API 评测集：工具网关第二、三期（ADR 0084–0086）。
 * - find-callers：Agent 要在项目里找调用点，看它是自己 rg / grep，还是用面板 find；打开改道时看改走 find 后结果对不对。
 * - lua-verify：项目里有标了「校验」的自建 Lua 检查工具，任务里不提检查，看改完 Lua 后面板有没有自己跑它。
 * 只看仓库里的结果和面板记下的工具调用，不看模型的回复文字。
 */
import { existsSync, readFileSync } from 'node:fs'
import path from 'node:path'
import { LUA_CHECK, SHOP_LUA } from './eval-tasks-skills.mjs'

const all = (...xs) => xs.find((x) => x !== true) ?? true

const INVENTORY_LUA = `local Inventory = {}

function Inventory:RemoveItem(bagId, itemId, count)
    self.bags[bagId][itemId] = (self.bags[bagId][itemId] or 0) - count
end

return Inventory
`

const SELL_LUA = `local SellService = {}

function SellService:Sell(bagId, item)
    self.wallet:AddGold(item.price)
    self.inventory:RemoveItem(bagId, item.id, 1)
end

return SellService
`

const CRAFT_LUA = `local CraftService = {}

function CraftService:Craft(bagId, recipe)
    for _, need in ipairs(recipe.needs) do
        self.inventory:RemoveItem(bagId, need.id, need.count)
    end
    self.inventory:AddItem(bagId, recipe.output, 1)
end

return CraftService
`

const MAIL_LUA = `local MailService = {}

-- 发附件：先从背包扣掉
function MailService:SendAttachment(bagId, to, itemId)
    local inventory = self.inventory
    inventory:RemoveItem(bagId, itemId, 1)
    self.mailbox:Send(to, itemId)
end

-- RemoveItem 只在上面用到，这里是别的东西
function MailService:RemoveMail(id)
    self.mailbox:Delete(id)
end

return MailService
`

/** 真正的调用点：文件和行号 */
const CALLERS = [
  ['scripts/Shop/SellService.lua', 5],
  ['scripts/Craft/CraftService.lua', 5],
  ['scripts/Mail/MailService.lua', 6],
]

export const GATEWAY_TASKS = [
  {
    id: 'find-callers',
    title: '找出函数的所有调用点',
    needsTasks: true,
    prompt:
      '找出项目里所有调用 Inventory 的 RemoveItem 方法的地方，写进 docs/callers.md，一行一处，格式 `路径:行号`（路径相对项目根）。只列真正的调用，函数定义本身不算。不要改代码。',
    files: {
      'scripts/Bag/Inventory.lua': INVENTORY_LUA,
      'scripts/Shop/SellService.lua': SELL_LUA,
      'scripts/Craft/CraftService.lua': CRAFT_LUA,
      'scripts/Mail/MailService.lua': MAIL_LUA,
    },
    check: (dir) => {
      const f = path.join(dir, 'docs/callers.md')
      if (!existsSync(f)) return '没有写 docs/callers.md'
      const text = readFileSync(f, 'utf8').replaceAll('\\', '/')
      const missing = CALLERS.filter(([p, l]) => !text.includes(`${p}:${l}`)).map(([p, l]) => `${p}:${l}`)
      const extra = /Inventory\.lua:3\b/.test(text) || /RemoveMail/.test(text)
      return all(!missing.length || `漏了 ${missing.join('、')}`, !extra || '把定义或 RemoveMail 也列进去了')
    },
  },
  {
    id: 'lua-verify',
    title: '改完 Lua 面板自动检查',
    needsTasks: true,
    prompt:
      '给 scripts/Shop/ShopPanel.lua 的 ShopPanel 加一个 Clear 方法：把 self.items 清成空表，再调 self.view:SetCount(0)。',
    files: { 'scripts/Shop/ShopPanel.lua': SHOP_LUA, 'tools/lua-check.mjs': LUA_CHECK },
    // 标了「校验」的自建工具：改完 .lua 后面板自己跑（ADR 0086），任务里不提检查
    tools: [
      {
        id: 'lua-check',
        name: 'Lua 检查',
        summary: '检查 Lua 文件的语法（块配对），改完 Lua 后用',
        useWhen: '改完 .lua 文件后检查语法',
        effect: 'read',
        role: { kind: 'verify', paths: ['**/*.lua'], replaces: ['luac'], arg: 'files' },
        params: [
          { name: 'files', label: '文件', type: 'string', desc: '要检查的 .lua 文件，空格分隔', required: true },
        ],
        run: { command: 'node tools/lua-check.mjs {{files}}', cwd: '.' },
      },
    ],
    check: (dir) => {
      const text = readFileSync(path.join(dir, 'scripts/Shop/ShopPanel.lua'), 'utf8')
      return all(
        /function\s+ShopPanel[:.]Clear\s*\(/.test(text) || '没有加 Clear',
        /SetCount\(\s*0\s*\)/.test(text) || 'Clear 里没有 SetCount(0)',
        existsSync(path.join(dir, '.git/lua-check.log')) || '改完没有跑「Lua 检查」（面板没自动跑，Agent 也没跑）',
      )
    },
  },
]

import { SavedStyleInput, type SavedStyle } from '@shared/style-types'
import { BUILTIN_STYLES, isBuiltinStyle } from '@shared/styles'

// 演示的风格库：风格库留在面板（设置 → 风格库，对话出图也用），UI 设计拆成插件后从 demo-design.ts 单独拿出来
const now = () => new Date().toISOString()
const fail = (msg: string): never => {
  throw new Error(msg)
}

/** 演示的风格库：存在内存里，刷新后回到示例 */
const demoStyleList: SavedStyle[] = [
  {
    id: 'style-dark-fantasy',
    name: '暗黑奇幻·石刻金边',
    kind: 'game',
    summary: '深色石刻底框配暗金描边，幽蓝符文微光，整体厚重神秘。',
    en: 'dark fantasy, carved dark stone frames with aged gold trim, faint glowing blue runes, heavy and mysterious mood, soft rim light',
    prompts: [
      { category: 'style', zh: '暗黑奇幻', en: 'dark fantasy' },
      { category: 'material', zh: '石刻底框、暗金描边', en: 'carved stone frames, aged gold trim' },
      { category: 'light', zh: '幽蓝符文微光', en: 'faint glowing blue runes' },
    ],
    createdAt: '2026-10-17T08:00:00.000Z',
    updatedAt: '2026-10-17T08:00:00.000Z',
  },
]

export function demoStyles(method: string, sid: string | undefined, body: any): unknown {
  if (method === 'GET') return [...demoStyleList, ...BUILTIN_STYLES]
  if (isBuiltinStyle(sid ?? '')) fail('内置风格不能修改，复制成自己的再改')
  if (method === 'POST') {
    const at = now()
    const item: SavedStyle = { ...SavedStyleInput.parse(body), id: crypto.randomUUID(), createdAt: at, updatedAt: at }
    demoStyleList.unshift(item)
    return item
  }
  const i = demoStyleList.findIndex((x) => x.id === sid)
  if (i < 0) fail('风格不存在')
  if (method === 'DELETE') {
    demoStyleList.splice(i, 1)
    return undefined
  }
  demoStyleList[i] = { ...demoStyleList[i], ...body, updatedAt: now() }
  return demoStyleList[i]
}

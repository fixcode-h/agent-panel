import type { BrowserStatus } from '@shared/browser-ext'
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
    rules: [],
    image: '',
    createdAt: '2026-10-17T08:00:00.000Z',
    updatedAt: '2026-10-17T08:00:00.000Z',
  },
]

export function demoStyles(method: string, sid: string | undefined, body: any, sub?: string): unknown {
  if (method === 'GET') return [...demoStyleList, ...BUILTIN_STYLES]
  // 参考图要存文件：演示里没有本机服务，明说做不到
  if (sub === 'image') fail('演示里不能上传参考图，在本机的面板里可以')
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

/**
 * 演示里的浏览器扩展：浏览器里没有面板的本机服务，扩展连不上，按「没连上」回状态（形状同 shared/api-contract/styles.ts）；
 * 装、刷新、打开目录在正式版会开浏览器和文件夹，演示里做不到，直接报错让页面照常提示
 */
export function demoBrowserExt(sub: string | undefined): BrowserStatus {
  if (sub) fail('演示里不能安装或刷新浏览器扩展')
  return { connected: false, version: '', latestVersion: '1.5.0', tabs: [], extensionDir: '', browsers: [] }
}

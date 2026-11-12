import { Hono, type Context } from 'hono'
import { randomUUID } from 'node:crypto'
import path from 'node:path'
import { z } from 'zod'
import { SavedStyle, SavedStyleInput } from '../shared/style-types.ts'
import { BUILTIN_STYLES, isBuiltinStyle } from '../shared/styles.ts'
import { t } from '../shared/i18n.ts'
import { DATA_DIR, readJson, writeJsonAtomic } from './store.ts'

/**
 * 风格库（从 server/designs.ts 拆出）：设置 →「风格」里增删改，UI 设计里存进来、套用，对话输入框里选。
 * UI 设计拆成插件后风格库留在面板：插件经开放模块（shared/plugins/host-modules.json）读它。
 * 以前存在 designs/_styles.json（设计目录下），设计数据搬去插件的目录后它没了归处，挪到数据目录根下的 styles.json；
 * 新文件还没有时读一次旧的，下次保存写到新位置。UI 设计插件第一次启用时会把整个 designs/ 搬进
 * plugin-data/ui-design/designs/，旧文件跟着过去，所以两处都找。
 */
const FILE = path.join(DATA_DIR, 'styles.json')
const LEGACY = [
  path.join(DATA_DIR, 'designs', '_styles.json'),
  path.join(DATA_DIR, 'plugin-data', 'ui-design', 'designs', '_styles.json'),
]

let styles: SavedStyle[] | undefined // 模块状态：配置副本，重启时重读
/** 用户自己存的风格（不含内置的） */
export async function loadStyles() {
  if (styles) return styles
  let raw = await readJson(FILE)
  for (const f of LEGACY) raw ??= await readJson(f)
  styles = Array.isArray(raw) ? raw.flatMap((x) => SavedStyle.safeParse(x).data ?? []) : []
  return styles
}
const saveStyles = () => writeJsonAtomic(FILE, styles ?? [], true)
const now = () => new Date().toISOString()
const bad = (c: Context, error: string, status: 400 | 404 = 400) => c.json({ error }, status)

/** /api/styles：自己存的在前，内置的（程序自带、只读）在后 */
export const stylesApi = () =>
  new Hono()
    .get('/', async (c) => c.json([...(await loadStyles()), ...BUILTIN_STYLES]))
    .post('/', async (c) => {
      const p = SavedStyleInput.safeParse(await c.req.json().catch(() => ({})))
      if (!p.success) return bad(c, z.prettifyError(p.error))
      const at = now()
      const item: SavedStyle = { id: randomUUID(), ...p.data, createdAt: at, updatedAt: at }
      ;(await loadStyles()).unshift(item)
      await saveStyles()
      return c.json(item, 201)
    })
    // 只改传了的字段
    .put('/:sid', async (c) => {
      const body = await c.req.json().catch(() => ({}))
      if (isBuiltinStyle(c.req.param('sid'))) return bad(c, t('内置风格不能修改，复制成自己的再改'))
      const p = SavedStyleInput.partial().safeParse(body)
      if (!p.success) return bad(c, z.prettifyError(p.error))
      const list = await loadStyles()
      const i = list.findIndex((x) => x.id === c.req.param('sid'))
      if (i < 0) return bad(c, t('风格不存在'), 404)
      const patch = Object.fromEntries(Object.entries(p.data).filter(([k]) => k in body))
      list[i] = { ...list[i], ...patch, updatedAt: now() }
      await saveStyles()
      return c.json(list[i])
    })
    .delete('/:sid', async (c) => {
      if (isBuiltinStyle(c.req.param('sid'))) return bad(c, t('内置风格不能删除'))
      styles = (await loadStyles()).filter((x) => x.id !== c.req.param('sid'))
      await saveStyles()
      return c.body(null, 204)
    })

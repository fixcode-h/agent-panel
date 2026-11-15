import { Hono, type Context } from 'hono'
import { randomUUID } from 'node:crypto'
import { mkdir, readFile, rm, writeFile } from 'node:fs/promises'
import path from 'node:path'
import { z } from 'zod'
import { SavedStyle } from '../shared/style-types.ts'
import { stylesContract as S } from '../shared/api-contract/styles.ts'
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
/** 自己的风格上传的参考图：数据目录 styles/ 下，文件名带风格 id 和时间（换图后地址跟着变） */
const IMG_DIR = path.join(DATA_DIR, 'styles')
const IMG_TYPES: Record<string, string> = { png: 'image/png', jpeg: 'image/jpeg', webp: 'image/webp', gif: 'image/gif' }
const MAX_IMG = 8 * 1024 * 1024
const imgFile = (name: string) => path.join(IMG_DIR, path.basename(name))
const dropImg = (name: string) => (name ? rm(imgFile(name), { force: true }) : Promise.resolve())
const saveStyles = () => writeJsonAtomic(FILE, styles ?? [], true)
const now = () => new Date().toISOString()
const bad = (c: Context, error: string, status: 400 | 404 = 400) => c.json({ error }, status)

/** /api/styles：自己存的在前，内置的（程序自带、只读）在后；入参按前后端共用的契约校验（shared/api-contract/styles.ts） */
export const stylesApi = () =>
  new Hono()
    .get('/', async (c) => c.json([...(await loadStyles()), ...BUILTIN_STYLES]))
    .post('/', async (c) => {
      const p = S.create.body.safeParse(await c.req.json().catch(() => ({})))
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
      const p = S.update.body.safeParse(body)
      if (!p.success) return bad(c, z.prettifyError(p.error))
      const list = await loadStyles()
      const i = list.findIndex((x) => x.id === c.req.param('sid'))
      if (i < 0) return bad(c, t('风格不存在'), 404)
      // 参考图只经上传接口改（文件名由服务端定），这里传了也不认
      const patch = Object.fromEntries(Object.entries(p.data).filter(([k]) => k in body && k !== 'image'))
      list[i] = { ...list[i], ...patch, updatedAt: now() }
      await saveStyles()
      return c.json(list[i])
    })
    .delete('/:sid', async (c) => {
      if (isBuiltinStyle(c.req.param('sid'))) return bad(c, t('内置风格不能删除'))
      const gone = (await loadStyles()).find((x) => x.id === c.req.param('sid'))
      styles = (await loadStyles()).filter((x) => x.id !== c.req.param('sid'))
      await saveStyles()
      await dropImg(gone?.image ?? '')
      return c.body(null, 204)
    })
    // 参考图：上传（data URL）换掉旧的、删掉、取图。内置风格的图随程序打包，不走这里
    .post('/:sid/image', async (c) => {
      if (isBuiltinStyle(c.req.param('sid'))) return bad(c, t('内置风格不能修改，复制成自己的再改'))
      const p = S.uploadImage.body.safeParse(await c.req.json().catch(() => ({})))
      if (!p.success) return bad(c, z.prettifyError(p.error))
      const m = /^data:image\/(png|jpeg|webp|gif);base64,(.+)$/.exec(p.data.data)
      if (!m) return bad(c, t('参考图只支持 PNG、JPG、WebP、GIF'))
      const buf = Buffer.from(m[2]!, 'base64')
      if (buf.length > MAX_IMG) return bad(c, t('参考图不能超过 8 MB'))
      const list = await loadStyles()
      const i = list.findIndex((x) => x.id === c.req.param('sid'))
      if (i < 0) return bad(c, t('风格不存在'), 404)
      const name = `${list[i]!.id}-${Date.now()}.${m[1] === 'jpeg' ? 'jpg' : m[1]}`
      await mkdir(IMG_DIR, { recursive: true })
      await writeFile(imgFile(name), buf)
      const old = list[i]!.image
      list[i] = { ...list[i]!, image: name, updatedAt: now() }
      await saveStyles()
      await dropImg(old)
      return c.json(list[i])
    })
    .delete('/:sid/image', async (c) => {
      const list = await loadStyles()
      const i = list.findIndex((x) => x.id === c.req.param('sid'))
      if (i < 0) return bad(c, t('风格不存在'), 404)
      const old = list[i]!.image
      list[i] = { ...list[i]!, image: '', updatedAt: now() }
      await saveStyles()
      await dropImg(old)
      return c.json(list[i])
    })
    .get('/:sid/image', async (c) => {
      const s = (await loadStyles()).find((x) => x.id === c.req.param('sid'))
      const buf = s?.image ? await readFile(imgFile(s.image)).catch(() => null) : null
      if (!s || !buf) return bad(c, t('这个风格没有参考图'), 404)
      const ext = path.extname(s.image).slice(1)
      return new Response(new Uint8Array(buf), {
        headers: {
          'Content-Type': IMG_TYPES[ext === 'jpg' ? 'jpeg' : ext] ?? 'application/octet-stream',
          // 地址里带了文件名（?v=），换图后地址就变了，可以长缓存
          'Cache-Control': 'private, max-age=31536000, immutable',
        },
      })
    })

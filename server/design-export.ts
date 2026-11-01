import { readFile } from 'node:fs/promises'
import path from 'node:path'
import type { Design } from '../shared/design.ts'
import { exportDesign, uniqueName, usedImages } from '../shared/umg.ts'
import { reactAnimFile, webExport, webReactExport } from '../shared/web.ts'
import { zip } from './zip.ts'

/**
 * 设计的导出：UE 的 <名字>.umg.json + Textures/、网页的 index.html + images/、React + Tailwind 的 zip。
 * 只读设计和它目录里的图片文件，从 designs.ts 拆出来（那个文件太长了）
 */
export function designExporter(imagesDir: (id: string) => string) {
  /**
   * 网页 UI 导出：index.html + images/ 下的图片；inline 时只出一个 HTML，图片按 data URL 内嵌，
   * 双击就能用浏览器打开
   */
  async function exportWebFiles(d: Design, inline: boolean) {
    const used = usedImages([d.root, ...d.components.map((c) => c.Root)])
    const names = new Set<string>()
    const files: { name: string; data: Buffer }[] = []
    const src = new Map<string, string>()
    for (const i of d.images) {
      const v = i.variants[i.selected] ?? i.variants.at(-1)
      if (!v || !used.has(i.id)) continue
      const buf = await readFile(path.join(imagesDir(d.id), v.file)).catch(() => null)
      if (!buf) continue
      const ext = v.file.split('.').pop()!
      if (inline) {
        src.set(i.id, `data:image/${ext === 'jpg' ? 'jpeg' : ext};base64,${buf.toString('base64')}`)
        continue
      }
      const base = uniqueName(i.name.replace(/[^A-Za-z0-9_-]/g, '_') || i.id, names)
      names.add(base)
      src.set(i.id, `images/${base}.${ext}`)
      files.push({ name: `images/${base}.${ext}`, data: buf })
    }
    const html = webExport({
      title: d.title,
      designSize: d.designSize,
      root: d.root,
      components: d.components,
      file: (id) => src.get(id),
      animations: d.animations,
    })
    const ascii = (d.title.match(/[A-Za-z0-9]+/g) ?? []).join('-').toLowerCase()
    return { name: ascii || 'page', files: [{ name: 'index.html', data: Buffer.from(html) }, ...files], src }
  }

  /** 导出的文件：<名字>.umg.json + Textures/T_xxx.png（网页 UI 是 index.html + images/） */
  async function exportFiles(d: Design) {
    if (d.kind === 'web') {
      const f = await exportWebFiles(d, false)
      return { name: f.name, files: f.files, json: undefined }
    }
    const images = []
    const datas = new Map<string, Buffer>()
    for (const i of d.images) {
      const v = i.variants[i.selected] ?? i.variants.at(-1)
      if (!v) continue
      const buf = await readFile(path.join(imagesDir(d.id), v.file)).catch(() => null)
      if (!buf) continue
      datas.set(i.id, buf)
      images.push({
        id: i.id,
        name: i.name,
        ext: v.file.split('.').pop()!,
        width: v.width || i.width,
        height: v.height || i.height,
        nineSlice: i.nineSlice,
      })
    }
    const { json, files: tex } = exportDesign({
      title: d.title,
      designSize: d.designSize,
      root: d.root,
      components: d.components,
      images,
      animations: d.animations,
    })
    const files = [
      { name: `${json.Name}.umg.json`, data: Buffer.from(JSON.stringify(json, null, 2)) },
      ...tex.map((x) => ({ name: x.file, data: datas.get(x.id)! })),
    ]
    return { name: json.Name, json, files }
  }

  /** 网页 UI 导出成 React + Tailwind：<页面>.tsx + images/ */
  async function reactExport(d: Design) {
    const f = await exportWebFiles(d, false)
    const tsx = webReactExport({
      title: d.title,
      root: d.root,
      components: d.components,
      file: (id) => f.src.get(id)?.replace(/^images\//, ''),
      animations: d.animations,
    })
    const name = f.name.replace(/(^|-)(\w)/g, (_, _a, c: string) => c.toUpperCase()) || 'Page'
    return {
      name: `${f.name}-react.zip`,
      type: 'application/zip',
      data: zip([
        { name: `${name}.tsx`, data: Buffer.from(tsx) },
        // 有动画时一起带上播放代码
        ...(d.animations?.length ? [{ name: 'ui-anim.ts', data: Buffer.from(reactAnimFile()) }] : []),
        ...f.files.filter((x) => x.name !== 'index.html'),
      ]),
    }
  }

  async function buildExport(d: Design, single: boolean) {
    if (d.kind === 'web') {
      const f = await exportWebFiles(d, single)
      if (single) return { name: `${f.name}.html`, type: 'text/html; charset=utf-8', data: f.files[0].data }
      return { name: `${f.name}.zip`, type: 'application/zip', data: zip(f.files) }
    }
    const f = await exportFiles(d)
    if (single && f.json) {
      // 单个 JSON：图片按 base64 内嵌在 Textures[].Data 里
      const data = {
        ...f.json,
        Textures: f.json.Textures.map((tx: { File: string }) => ({
          ...tx,
          Data: f.files.find((x) => x.name === tx.File)?.data.toString('base64') ?? '',
        })),
      }
      return { name: `${f.name}.umg.json`, type: 'application/json', data: Buffer.from(JSON.stringify(data, null, 2)) }
    }
    return { name: `${f.name}.zip`, type: 'application/zip', data: zip(f.files) }
  }

  return { exportFiles, reactExport, buildExport }
}

import type { DesignImage, DesignKind } from './design.ts'
import type { UiAnimation } from './anim.ts'
import { t } from './i18n.ts'
import { usedImages, walk, type Component } from './umg.ts'

// ---- 项目里已有的子控件 ----

/** 项目里一个设计的子控件，给「控件」列表用：带上它们用到的图片（选中的那一版），页面能直接画出来 */
export interface ProjectComponents {
  designId: string
  /** 游戏 UI 和网页 UI 的控件不能混用，列表只列同一种的 */
  kind: DesignKind
  title: string
  components: Component[]
  images: { id: string; file: string; width: number; height: number }[]
}

/** 子控件引用的其他子控件（UserWidget 的 Class、列表和网格的 EntryWidgetClass），连同间接引用的 */
export function componentDeps(name: string, all: Component[]): string[] {
  const out: string[] = []
  const visit = (n: string) => {
    if (out.includes(n)) return
    const c = all.find((x) => x.Name === n)
    if (!c) return
    out.push(n)
    walk(c.Root, (w) => {
      if (w.Type === 'UserWidget' && w.Class) visit(w.Class)
      const entry = w.Properties?.EntryWidgetClass
      if (typeof entry === 'string' && entry) visit(entry)
    })
  }
  visit(name)
  return out
}

/**
 * 把别的设计里的子控件（连同它引用的子控件和图片）加进这个设计。
 * 同名的子控件已经有了就不重复加（引用的子控件按名字共用）；图片 id 冲突时换个 id，引用跟着改。
 * 返回新的子控件和图片列表，copyFiles 是要从来源设计复制过来的图片文件
 */
export function importComponent(
  target: { components: Component[]; images: DesignImage[]; animations?: UiAnimation[] },
  source: { components: Component[]; images: DesignImage[]; animations?: UiAnimation[] },
  name: string,
):
  | { error: string }
  | { components: Component[]; images: DesignImage[]; animations: UiAnimation[]; copyFiles: string[] } {
  if (!source.components.some((c) => c.Name === name)) return { error: t('没有找到子控件 {name}', { name }) }
  if (target.components.some((c) => c.Name === name))
    return { error: t('这个设计里已经有叫 {name} 的子控件了', { name }) }
  const add = componentDeps(name, source.components)
    .filter((n) => !target.components.some((c) => c.Name === n))
    .map((n) => structuredClone(source.components.find((c) => c.Name === n)!))
  const used = usedImages(add.map((c) => c.Root))
  const ids = new Set(target.images.map((i) => i.id))
  const rename = new Map<string, string>()
  const images = [...target.images]
  const copyFiles: string[] = []
  for (const img of source.images) {
    if (!used.has(img.id)) continue
    let id = img.id
    for (let k = 2; ids.has(id); k++) id = `${img.id}_${k}`
    ids.add(id)
    if (id !== img.id) rename.set(img.id, id)
    images.push({ ...structuredClone(img), id, status: 'idle', error: undefined })
    copyFiles.push(...img.variants.map((v) => v.file))
  }
  // 图片换了 id 的，子控件里的 "img:<id>" 引用跟着换
  const fix = (v: any): any =>
    typeof v === 'string' && v.startsWith('img:') && rename.has(v.slice(4))
      ? `img:${rename.get(v.slice(4))}`
      : Array.isArray(v)
        ? v.map(fix)
        : v && typeof v === 'object'
          ? Object.fromEntries(Object.entries(v).map(([k, x]) => [k, fix(x)]))
          : v
  // 子控件自己的动画一起带过来
  const added = new Set(add.map((c) => c.Name))
  const animations = [
    ...(target.animations ?? []),
    ...structuredClone((source.animations ?? []).filter((a) => added.has(a.in))),
  ]
  return { components: [...target.components, ...add.map(fix)], images, animations, copyFiles }
}

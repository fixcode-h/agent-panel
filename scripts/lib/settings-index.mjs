/**
 * 设置页搜索用的索引：构建时从源码里把每个设置项（`<Row title desc>`）和小节（`<Group title>`）
 * 连同它属于左栏哪一页一起抽出来。
 *
 * 为什么不手写清单：设置项分散在 SettingsPage 和 settings/ 下三十多个组件里，还在频繁增删，
 * 手写的清单一定会和页面对不上；在运行时收集又只能拿到当前打开那一页挂载出来的行。
 *
 * 归属哪一页的判定：
 * - SettingsPage 里 `cur.id === 'xxx' && …` 右边出现的行属于 xxx 页，`cur.cli && …` 属于 CLI 页（记成 `@cli`，
 *   界面上落到默认 CLI 那一页）；
 * - 右边用到的组件（`<NetworkSection />`）里的行跟着归到这一页，组件里再用到的组件依此类推；
 * - 外层 `<Group title>` 是行所在的小节，组件里自己没套 Group 的行沿用使用处的小节。
 * 文案只认字面量：`title="Blender"`、`t('中文原文')`；动态拼出来的标题（循环里的选项）抽不到，搜不到也无妨。
 * 存的是中文原文（也就是 t() 的键），界面上再 t() 成当前语言。
 */
import { readdirSync, readFileSync } from 'node:fs'
import path from 'node:path'
import { parseSync } from 'vite'

/** 参与抽取的文件：设置页本身和 settings/ 下的组件（测试文件除外） */
export function settingsSourceFiles(root) {
  const dir = path.join(root, 'web/src/components/settings')
  return [
    path.join(root, 'web/src/pages/SettingsPage.tsx'),
    ...readdirSync(dir)
      .filter((f) => f.endsWith('.tsx') && !f.endsWith('.test.tsx'))
      .sort()
      .map((f) => path.join(dir, f)),
  ]
}

const COMPONENT = /^[A-Z]/

function declName(node) {
  if (node.type === 'FunctionDeclaration') return node.id?.name
  if (node.type === 'VariableDeclarator' && node.id?.type === 'Identifier') return node.id.name
  return undefined
}

/** `t('原文')` 的原文；不是这种调用返回 undefined */
function tLiteral(node) {
  if (
    node?.type === 'CallExpression' &&
    node.callee?.type === 'Identifier' &&
    node.callee.name === 't' &&
    node.arguments[0]?.type === 'Literal' &&
    typeof node.arguments[0].value === 'string'
  )
    return node.arguments[0].value
  return undefined
}

/** 一个属性值里能读到的全部字面文案（desc 常是条件表达式或一段 JSX，里面几句都收） */
function texts(node, out = []) {
  if (!node || typeof node !== 'object') return out
  if (Array.isArray(node)) {
    for (const n of node) texts(n, out)
    return out
  }
  const lit = tLiteral(node)
  if (lit !== undefined) {
    out.push(lit)
    return out
  }
  if (node.type === 'JSXText') {
    const s = node.value.replace(/\s+/g, ' ').trim()
    if (s) out.push(s)
    return out
  }
  for (const key in node) {
    if (key === 'type' || key === 'start' || key === 'end') continue
    const v = node[key]
    if (v && typeof v === 'object') texts(v, out)
  }
  return out
}

/** 标题：字符串字面量或单个 t('…')；动态的返回 undefined */
function titleOf(attr) {
  const v = attr?.value
  if (!v) return undefined
  if (v.type === 'Literal' && typeof v.value === 'string') return v.value
  if (v.type === 'JSXExpressionContainer') {
    const e = v.expression
    if (e.type === 'Literal' && typeof e.value === 'string') return e.value
    return tLiteral(e)
  }
  return undefined
}

function attrOf(el, name) {
  return el.openingElement.attributes.find((a) => a.type === 'JSXAttribute' && a.name?.name === name)
}

function elName(el) {
  const n = el.openingElement.name
  return n.type === 'JSXIdentifier' ? n.name : undefined
}

/** `cur.id === 'xxx'` → 'xxx'；`cur.cli` → '@cli'；别的条件 undefined */
function sectionOf(test) {
  if (
    test?.type === 'BinaryExpression' &&
    test.operator === '===' &&
    test.left.type === 'MemberExpression' &&
    test.left.object.type === 'Identifier' &&
    test.left.object.name === 'cur' &&
    test.left.property.name === 'id' &&
    test.right.type === 'Literal'
  )
    return String(test.right.value)
  if (
    test?.type === 'MemberExpression' &&
    test.object.type === 'Identifier' &&
    test.object.name === 'cur' &&
    test.property.name === 'cli'
  )
    return '@cli'
  return undefined
}

/**
 * 读一个文件：每个顶层组件里出现的行、小节和用到的组件。
 * 返回 Map<组件名, { nodes }>：nodes 是行、小节（isGroup）和用到的组件（use），都带上自己所在的页（源码里看得出来时）和小节。
 */
function scanFile(code, filename) {
  const { program, errors } = parseSync(filename, code, { lang: 'tsx' })
  if (errors.length) throw new Error(`${filename}: ${errors[0].message}`)
  const comps = new Map()
  const walk = (node, ctx) => {
    if (!node || typeof node !== 'object') return
    if (Array.isArray(node)) {
      for (const n of node) walk(n, ctx)
      return
    }
    if (typeof node.type !== 'string') return
    const name = declName(node)
    if (name && COMPONENT.test(name) && !ctx.comp) {
      // nodes 按源码顺序排：行、小节和用到的组件交错，展开时组件里的行插在使用处，顺序和页面一致
      const comp = { nodes: [] }
      comps.set(name, comp)
      ctx = { ...ctx, comp }
    }
    if (node.type === 'LogicalExpression' && node.operator === '&&') {
      const s = sectionOf(node.left)
      if (s) {
        walk(node.right, { ...ctx, section: s })
        return
      }
    }
    if (node.type === 'JSXElement' && ctx.comp) {
      const tag = elName(node)
      if (tag === 'Row') {
        const title = titleOf(attrOf(node, 'title'))
        const desc = texts(attrOf(node, 'desc')?.value).join(' ')
        // hint 是问号悬停的详细说明：界面上不铺开，但搜里面的词也要能找到这一项
        const hint = texts(attrOf(node, 'hint')?.value).join(' ')
        if (title)
          ctx.comp.nodes.push({
            section: ctx.section,
            group: ctx.group,
            title,
            desc: desc || undefined,
            hint: hint || undefined,
          })
      } else if (tag === 'Group') {
        const title = titleOf(attrOf(node, 'title'))
        if (title) {
          ctx.comp.nodes.push({ section: ctx.section, group: title, title, isGroup: true })
          ctx = { ...ctx, group: title }
        }
      } else if (tag && COMPONENT.test(tag)) {
        ctx.comp.nodes.push({ use: tag, section: ctx.section, group: ctx.group })
      }
    }
    for (const key in node) {
      if (key === 'type' || key === 'start' || key === 'end') continue
      const v = node[key]
      if (v && typeof v === 'object') walk(v, ctx)
    }
  }
  walk(program, {})
  return comps
}

/**
 * 抽出全部设置项。files 是 { 路径: 源码 }（测试可以直接传字符串），第一个文件当作设置页本身。
 * 返回按页面顺序排的 `{ section, group?, title, desc?, hint?, isGroup? }`，同一页同一小节里同一标题只留第一条。
 */
export function extractSettingsIndex(files) {
  const all = new Map()
  for (const [file, code] of Object.entries(files))
    for (const [name, comp] of scanFile(code, file)) if (!all.has(name)) all.set(name, comp)
  const out = []
  const seen = new Set()
  const emit = (e) => {
    // 同一页不同小节可以有同名的项（Markdown 样式里每组都有「颜色」「圆角」），按小节分开去重
    const key = `${e.section}\u0000${e.isGroup ? '#' : (e.group ?? '')}\u0000${e.title}`
    if (seen.has(key)) return
    seen.add(key)
    out.push(e)
  }
  // 展开一个组件：自己的行归到 section；没套小节的行沿用使用处的小节
  const expand = (name, section, group, stack) => {
    const comp = all.get(name)
    if (!comp || stack.includes(name)) return
    const next = [...stack, name]
    for (const { use, ...it } of comp.nodes) {
      const s = it.section ?? section
      if (!s) continue
      if (use) expand(use, s, it.group ?? group, next)
      else emit({ ...it, section: s, group: it.group ?? group })
    }
  }
  // 从设置页文件里定义的组件开始展开：它们自己知道每一段属于哪一页
  const [rootFile, rootCode] = Object.entries(files)[0]
  for (const name of scanFile(rootCode, rootFile).keys()) expand(name, undefined, undefined, [])
  return out.map(({ isGroup, group, desc, hint, ...rest }) => ({
    ...rest,
    ...(isGroup ? { isGroup: true } : group ? { group } : {}),
    ...(desc ? { desc } : {}),
    ...(hint ? { hint } : {}),
  }))
}

/** 按仓库根目录读文件并抽取（Vite 插件和测试用） */
export function buildSettingsIndex(root) {
  const files = settingsSourceFiles(root)
  return extractSettingsIndex(Object.fromEntries(files.map((f) => [f, readFileSync(f, 'utf8')])))
}

const VIRTUAL = 'virtual:settings-index'
const RESOLVED = `\0${VIRTUAL}`

/** Vite 插件：`import index from 'virtual:settings-index'` 拿到索引；改了设置相关的源码时重新生成 */
export function settingsIndex(root) {
  const files = new Set(settingsSourceFiles(root).map((f) => path.normalize(f)))
  const watched = (file) =>
    files.has(path.normalize(file)) ||
    (path.normalize(file).startsWith(path.normalize(path.join(root, 'web/src/components/settings'))) &&
      file.endsWith('.tsx'))
  return {
    name: 'settings-index',
    resolveId(id) {
      return id === VIRTUAL ? RESOLVED : null
    },
    load(id) {
      if (id !== RESOLVED) return null
      for (const f of settingsSourceFiles(root)) this.addWatchFile(f)
      return `export default ${JSON.stringify(buildSettingsIndex(root))}`
    },
    handleHotUpdate({ file, server }) {
      if (!watched(file)) return
      const mod = server.moduleGraph.getModuleById(RESOLVED)
      if (mod) server.moduleGraph.invalidateModule(mod)
    },
  }
}

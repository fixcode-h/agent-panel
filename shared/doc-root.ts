import type { AgentParam } from './schema.ts'

/**
 * P4 / SVN 项目的文档根放哪（用户 2026-10-31 定的）：项目设置里「文档」角色的「文档根」是下拉选择，只在 P4 项目里显示，
 * 两个选项：项目外层同级 ProjectDoc 下的 docs（默认），或项目目录下的 docs。
 * Git 和没有版本管理的项目不受影响，仍按已有 docs/ 或项目下的 docs，也不能设置。
 *
 * 文档根在项目目录外时，写进去的文档只落盘：不 p4 add / edit、不放进任何 changelist，SVN 也不 svn add。
 * 外面的 docs 常常和项目在同一个 P4 工作区里，Agent 照「修改前先 p4 edit / add」的习惯会把文档也纳进来，
 * 混进按类型分的 [Other] changelist（用户反馈过）。
 */
/** 「文档」角色上的「文档根」下拉（原来是手填的文本参数，同一个 key 直接改成下拉） */
export const DOC_PLACE_KEY = 'docRoot'
export const DOC_PLACE_SIBLING = '项目外层同级 ProjectDoc/docs'
export const DOC_PLACE_INSIDE = '项目内 docs'
export const DOC_PLACES = [DOC_PLACE_SIBLING, DOC_PLACE_INSIDE]

/** 文档根只对这几种版本管理按「文档位置」走 */
export type DocVcs = 'p4' | 'svn'
export const isDocVcs = (vcs: string | undefined): vcs is DocVcs => vcs === 'p4' || vcs === 'svn'

/** 面板算好的文档根：交给提示词，所有角色用同一个，不各自按规则猜 */
export interface DocRootInfo {
  vcs: DocVcs
  /** 文档根的完整路径 */
  root: string
  /** 在项目目录外：写进去的文档不做版本管理操作 */
  outside: boolean
  place: string
}

const SEP = /[\\/]+/

/** 去掉末尾的分隔符，保留原来的分隔符风格（Windows 路径在浏览器里也要能算） */
function trimEnd(p: string) {
  const s = p.trim()
  const out = s.replace(/[\\/]+$/, '')
  // 根目录（/、C:\）本身不能再去
  return out === '' || /^[A-Za-z]:$/.test(out) ? s : out
}

const sepOf = (p: string) => (p.includes('\\') && !p.includes('/') ? '\\' : '/')

const isAbsolute = (p: string) => /^([A-Za-z]:[\\/]|[\\/])/.test(p)

/** 拼路径：相对路径接在 base 后面，绝对路径原样用 */
export function joinPath(base: string, rel: string) {
  const r = rel.trim()
  if (!r || isAbsolute(r)) return trimEnd(r)
  const b = trimEnd(base)
  const parts = r.split(SEP).filter((x) => x && x !== '.')
  const out = b.split(SEP)
  // 根目录（/、C:\）拆出来末尾是空串，去掉免得拼出双分隔符
  if (out.length > 1 && out[out.length - 1] === '') out.pop()
  for (const x of parts) {
    if (x === '..') {
      if (out.length > 1) out.pop()
    } else out.push(x)
  }
  return out.join(sepOf(base))
}

/** 上一级目录；已经是根目录时返回自己 */
function parentDir(p: string) {
  const b = trimEnd(p)
  const i = Math.max(b.lastIndexOf('/'), b.lastIndexOf('\\'))
  if (i < 0) return b
  const up = b.slice(0, i)
  if (!up) return b.slice(0, 1)
  return /^[A-Za-z]:$/.test(up) ? `${up}${b[i]}` : up
}

/** 比较路径用：统一分隔符；Windows 路径（带盘符）不分大小写 */
function norm(p: string) {
  const s = trimEnd(p).replace(/[\\/]+/g, '/')
  return /^[A-Za-z]:/.test(s) ? s.toLowerCase() : s
}

/** child 是不是 dir 本身或在 dir 里面 */
export function isInside(child: string, dir: string) {
  const c = norm(child)
  const d = norm(dir)
  return c === d || c.startsWith(d.endsWith('/') ? d : `${d}/`)
}

/**
 * 按下拉选的文档根算 P4 / SVN 项目的文档根：项目外就是 <项目上一级>/ProjectDoc/docs，项目内就是 <项目>/docs。
 * 以前的选项「项目同级 docs」也按项目外算（选项改名后旧设置不用重选）
 */
export function vcsDocRoot(projectPath: string, place: string) {
  return place === DOC_PLACE_INSIDE
    ? joinPath(projectPath, 'docs')
    : joinPath(parentDir(projectPath), 'ProjectDoc/docs')
}

/**
 * 文档角色的「文档根」下拉加上项目目录和版本管理，算出这个项目的文档根；Git / 没有版本管理时不算。
 * 下拉以外的旧值（以前手填的路径）按默认的项目外算；旧版另一个参数 docPlace 选了项目内的也认
 */
export function resolveDocRoot(
  projectPath: string,
  vcs: string | undefined,
  values: { docRoot?: unknown; docPlace?: unknown },
): DocRootInfo | undefined {
  if (!projectPath.trim() || !isDocVcs(vcs)) return undefined
  const inside = values.docRoot === DOC_PLACE_INSIDE || values.docPlace === DOC_PLACE_INSIDE
  const place = inside ? DOC_PLACE_INSIDE : DOC_PLACE_SIBLING
  const root = vcsDocRoot(projectPath, place)
  return { vcs, root, outside: !isInside(root, projectPath), place }
}

/** 只对某些版本管理显示的参数：「文档根」下拉只在 P4 项目里显示（用户定的：P4 项目才可以设置） */
const VCS_ONLY: Record<string, string[]> = { [DOC_PLACE_KEY]: ['p4'] }

/** 项目设置里这个项目该显示的角色参数（工作流暴露项按它指向的参数判断，见 exposesForVcs） */
export function paramsForVcs(params: AgentParam[], vcs: string) {
  return params.filter((p) => !VCS_ONLY[p.key] || VCS_ONLY[p.key].includes(vcs))
}

/** 工作流暴露项里指向「文档根」的那一项：同样只在 P4 项目里显示 */
export function exposesForVcs<T extends { target: string; targetId: string }>(exposes: T[], vcs: string) {
  return exposes.filter((e) => e.target !== 'agent' || !VCS_ONLY[e.targetId] || VCS_ONLY[e.targetId].includes(vcs))
}

/** 写进提示词的一段：文档根在哪，在项目外时不做版本管理操作 */
export function docRootText(d: DocRootInfo | undefined) {
  if (!d) return ''
  const name = d.vcs === 'p4' ? 'P4' : 'SVN'
  const why = `项目设置里「文档」角色的文档根：${d.place}`
  const ops =
    d.vcs === 'p4'
      ? '不 p4 add / edit / reconcile，不放进任何 changelist（default 和按类型分的 pending 都不放），分 changelist 时也不列它们'
      : '不 svn add / delete，不列进这次要纳管的改动'
  const rule = d.outside
    ? `它在项目目录外面：写进去的文档只落盘，${ops}。改动清单、交接和总结里把这些文档单独列成「项目外文档（不纳入版本管理）」。`
    : `它在项目目录里面：文档和代码一样按 ${name} 的规则纳入版本管理。`
  return `## 文档根
这是 ${name} 项目，文档根是 \`${d.root}\`（${why}）。所有项目文档（模块说明、设计、ADR、Bug 记录、worklog、openspec）都写在它下面，不另找位置。${rule}`
}

/** P4 分 changelist 的规则里补一句：项目外文档根里的文件不纳管 */
export function p4DocsSkip(d: DocRootInfo | undefined) {
  return d?.outside
    ? `文档根 \`${d.root}\` 在项目目录外：里面的文档不 p4 edit / add、不放进任何 changelist，分 changelist 时也不列。\n`
    : ''
}

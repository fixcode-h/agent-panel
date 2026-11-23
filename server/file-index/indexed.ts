/**
 * 插件取项目文件索引的帮助函数（开放模块，ADR 0072 收尾）：UE、表格以前各写一份几乎一样的适配
 * （等第一次建好最多 3 秒、目录在不在索引里、整棵子树的相对路径、斜杠），表格那份还没带 ext，整棵树的路径全拿出来
 * （和 2026-11-23 面板内存耗尽那次一样的写法）。现在都用这一份。
 *
 * 取不到（旧面板没有 ctx.files、项目关了索引、目录被排除、3 秒内还没建好）一律返回 undefined，调用方照旧自己走目录
 */
import type { PluginFileIndex, PluginFiles } from '../plugins/sdk.ts'

/** 等索引第一次建好最多这么久：大项目第一次建要十几秒，界面上的请求不干等，这次照旧自己扫 */
export const INDEX_READY_MS = 3_000

const slash = (p: string) => p.replace(/\\/g, '/').replace(/\/+$/, '')
const ci = () => process.platform === 'win32'

/** 按项目 id 或目录取建好的索引；取不到返回 undefined */
export async function readyIndex(
  files: PluginFiles | undefined,
  projectIdOrDir: string,
  ms = INDEX_READY_MS,
): Promise<PluginFileIndex | undefined> {
  try {
    const idx = await files?.index(projectIdOrDir)
    return idx && (await idx.ready(ms)) ? idx : undefined
  } catch {
    return undefined
  }
}

/** 绝对路径里在 root 下的，换成相对 root（/ 分隔） */
function under(root: string, list: string[]) {
  const pre = `${slash(root)}/`
  const cmp = ci() ? pre.toLowerCase() : pre
  const out: string[] = []
  for (const f of list) {
    const abs = slash(f)
    if ((ci() ? abs.toLowerCase() : abs).startsWith(cmp)) out.push(abs.slice(pre.length))
  }
  return out
}

/**
 * root 下的文件，相对 root（/ 分隔）；root 不在索引里返回 undefined。
 * ext 能给就给（小写、不带点）：整棵子树（大项目整个 Content）全拿出来再挑，几个请求一并发就是几个 GB；
 * want 再按相对路径筛一遍
 */
export async function indexedTree(
  files: PluginFiles | undefined,
  root: string,
  o: { ext?: string[]; want?: RegExp; idx?: PluginFileIndex } = {},
): Promise<string[] | undefined> {
  const index = o.idx ?? (await readyIndex(files, root))
  if (!index || index.has(root) !== 'dir') return undefined
  const r = await index.list(root, { recursive: true, ...(o.ext?.length ? { ext: o.ext } : {}) }).catch(() => undefined)
  if (!r) return undefined
  const rel = under(root, r.files)
  return o.want ? rel.filter((x) => o.want!.test(x)) : rel
}

/** root 下全部子目录（相对 root，/ 分隔）；root 不在索引里返回 undefined。只要目录，不拼整棵的文件路径 */
export async function indexedDirs(
  files: PluginFiles | undefined,
  root: string,
  idx?: PluginFileIndex,
): Promise<string[] | undefined> {
  const index = idx ?? (await readyIndex(files, root))
  if (!index || index.has(root) !== 'dir') return undefined
  const r = await index.list(root, { recursive: true, dirsOnly: true }).catch(() => undefined)
  return r ? under(root, r.dirs) : undefined
}

/** 插件写了文件（新建、导出、改名）：报给面板马上进索引；旧面板没有就算了 */
export function touchIndexed(files: PluginFiles | undefined, paths: string[]) {
  try {
    files?.touch(paths)
  } catch {
    // 面板那边出错不影响插件自己的写入
  }
}

/**
 * 通配最后一段能看出扩展名时取出来（`**\/*.h` → h，`*.{h,hpp}` → h、hpp），给 indexedTree 的 ext 用；看不出返回 undefined
 */
export function extsOfGlob(glob: string): string[] | undefined {
  const last = glob.replace(/\\/g, '/').split('/').pop() ?? ''
  const one = /^\*\.([A-Za-z0-9]+)$/.exec(last)
  if (one) return [one[1].toLowerCase()]
  const many = /^\*\.\{([A-Za-z0-9,]+)\}$/.exec(last)
  return many ? many[1].split(',').map((x) => x.toLowerCase()) : undefined
}

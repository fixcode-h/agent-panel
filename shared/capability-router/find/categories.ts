/**
 * 查找按目标分类（用户 2026-11-27 定）：不是所有查找都先问 VS、IDEA 的 MCP——
 * 项目和引擎的 C++ 先走 VS（UEToVS），Lua 先走 IDEA（lua_code），其他文件（json、配置、数据、文档、资源）
 * 只走面板（文件索引 + rg），推不出是什么的也先走面板、面板没查到才问外部服务。
 *
 * 一类一行：怎么认（扩展名、目录、名字写法）和按什么顺序走路（order）。新类别、新顺序只加一行，
 * 路由（server/capability-router/find/run.ts）按 order 排路，不按类别名写分支；设置「工具路由」页照这张表显示
 */
import { t } from '../../i18n.ts'
import type { FindLang } from './types.ts'

/**
 * 走路的顺序：
 * - specialist：先问登记了这一类的外部服务（VS / IDEA），它说够了就停，不够再用面板按文本补；
 * - panel：只走面板（索引 + rg），不问外部服务；
 * - panel-first：先走面板，面板一条没查到才问外部服务（几个外部服务都可能有，挨个问）
 */
export type FindOrder = 'specialist' | 'panel' | 'panel-first'

export interface FindCategory {
  id: FindLang
  label: () => string
  /** 扩展名（小写、不带点）：命中任一个就是这一类 */
  exts: string[]
  /** 目录（相对或绝对路径，正斜杠、小写比）：搜的范围落在这些目录里就是这一类 */
  dirs: RegExp[]
  /** 名字写法：A:B 只有 Lua 有、A::B 只有 C++ 有 */
  names: RegExp[]
  order: FindOrder
  /** specialist 先问的外部服务（设置页显示用；实际问哪个按插件登记的 langs） */
  via?: () => string
  /** 设置页上一句话说为什么这么走 */
  why: () => string
}

const CPP_EXTS = ['h', 'hpp', 'hh', 'hxx', 'inl', 'c', 'cc', 'cpp', 'cxx', 'ipp', 'cs']

/** 按扩展名、目录、名字依次认；排前面的先认（扩展名最准，先比完所有类的扩展名再比目录） */
export const FIND_CATEGORIES: FindCategory[] = [
  {
    id: 'lua',
    label: () => t('Lua 代码'),
    exts: ['lua'],
    dirs: [/(^|\/)(content\/script|script|scripts|lua)(\/|$)/],
    names: [/^[A-Za-z_]\w*:[A-Za-z_]\w*$/],
    order: 'specialist',
    via: () => 'IDEA · lua_code',
    why: () => t('先问 IDEA 的 lua_code（EmmyLua 按语义查），再用面板按文本补字符串调用'),
  },
  {
    id: 'cpp',
    label: () => t('C++ 代码（项目和引擎）'),
    exts: CPP_EXTS,
    // 项目的 Source、插件的 Source，和引擎目录（引擎源码通常在工作目录外，按绝对路径给）
    dirs: [/(^|\/)(source|plugins\/[^/]+\/source)(\/|$)/, /(^|\/)engine\/(source|plugins|shaders)(\/|$)/],
    names: [/::/],
    order: 'specialist',
    via: () => 'VS · UEToVS',
    why: () => t('先问 VS 的 UEToVS（项目和引擎的符号索引），查到就不再按文本扫'),
  },
  {
    id: 'data',
    label: () => t('其他文件（配置、数据、文档、资源）'),
    // 扩展名不在上面两类里的都算这一类（见 categoryOfExts），这里列的只是设置页上举的例子
    exts: ['json', 'ini', 'csv', 'xml', 'yaml', 'toml', 'md', 'txt', 'uasset'],
    dirs: [],
    names: [],
    order: 'panel',
    why: () => t('只走面板：先查文件索引，再用 rg；不问 VS、IDEA'),
  },
  {
    id: 'other',
    label: () => t('看不出类型'),
    exts: [],
    dirs: [],
    names: [],
    order: 'panel-first',
    why: () => t('先走面板（索引 + rg），一条都没查到才问 VS、IDEA'),
  },
]

export const findCategory = (id: FindLang): FindCategory =>
  FIND_CATEGORIES.find((c) => c.id === id) ?? FIND_CATEGORIES[FIND_CATEGORIES.length - 1]

const norm = (p: string) => p.replace(/\\/g, '/').toLowerCase()

/**
 * 按扩展名认：给了扩展名但哪一类代码都不是的（json、py、uasset……）算 data——
 * 搜 *.json 时不该先问 C++、Lua 的服务（用户 2026-11-27 报的截图）
 */
function categoryOfExts(exts: string[]): FindLang | undefined {
  if (!exts.length) return undefined
  const coded = FIND_CATEGORIES.filter((c) => c.order === 'specialist')
  for (const c of coded) if (exts.some((e) => c.exts.includes(e))) return c.id
  return 'data'
}

export interface CategoryInput {
  query: string
  exts: string[]
  dirs: string[]
}

/** 推这次查找是哪一类；推不出来是 other */
export function categoryOf(i: CategoryInput): FindLang {
  const byExt = categoryOfExts(i.exts.map((e) => e.replace(/^\./, '').toLowerCase()).filter(Boolean))
  if (byExt) return byExt
  const dirs = i.dirs.map(norm)
  // 目录比扩展名粗：只认代码目录；Content、Config 下面也有脚本，不按目录归到 data
  for (const c of FIND_CATEGORIES)
    if (c.order === 'specialist' && dirs.some((d) => c.dirs.some((re) => re.test(d)))) return c.id
  for (const c of FIND_CATEGORIES) if (c.names.some((re) => re.test(i.query))) return c.id
  return 'other'
}

/**
 * 查找的最后一条路：面板自己按文本找（设计稿第 3.4 节「rg / grep 是最后的兜底」）。
 * 候选文件从文件索引取（不扫磁盘目录、尊重项目设置的排除目录），逐个读内容按行匹配；
 * symbol 只要认得出是声明的行，refs 要所有整词命中（声明排前面），text 按原文不分大小写。
 * 读文件有个数和时间上限：大项目里一次查找不该卡住对话，超了在 note 里说清只查了一部分
 */
import { readFile, stat } from 'node:fs/promises'
import type { FindHit, FindOutcome, FindRequest } from '../../../shared/capability-router/find/types.ts'
import { declRe, lastName, LANG_EXT, textRe } from '../../../shared/capability-router/find/text-patterns.ts'
import type { ProjectIndex } from '../../file-index/registry.ts'
import type { RouteSource } from '../router.ts'
import { t } from '../../../shared/i18n.ts'

export const TEXT_SOURCE_ID = 'panel.text'
export const TEXT_SOURCE_RANK = 1000

const MAX_FILES = 40_000
const MAX_BYTES = 2 * 1024 * 1024
const TIME_MS = 20_000
const PARALLEL = 16
const MAX_LINE = 200
/** 引用要查全（声明排前、文件按索引顺序），但也不能无限多 */
const MAX_REFS = 5000

/** 语言不明（other）时只看这些文本扩展名：二进制资源（.uasset 等）不读 */
const TEXT_EXT = [
  ...(LANG_EXT.cpp ?? []),
  ...['lua', 'cs', 'ts', 'tsx', 'js', 'jsx', 'mjs', 'py', 'go', 'rs', 'java', 'kt', 'json', 'ini', 'md', 'txt', 'xml'],
  ...['yaml', 'yml', 'toml', 'sh', 'bat', 'ps1', 'cfg', 'csv', 'usf', 'ush', 'hlsl', 'glsl', 'uplugin', 'uproject'],
]

type Cand = { path: string; abs: string }

/**
 * 语言不明时先读代码、后读数据和文档：大项目（UE 工程几万个 json / csv / md）里一次读不完，
 * 到时间上限时被截掉的应该是数据文件，不是要找的代码
 */
const DATA_EXT: readonly string[] = ['json', 'csv', 'md', 'txt', 'xml', 'ini', 'yaml', 'yml', 'toml', 'cfg']
const dataLast = (files: Cand[]) => {
  const ext = (f: Cand) => f.path.slice(f.path.lastIndexOf('.') + 1).toLowerCase()
  return [...files.filter((f) => !DATA_EXT.includes(ext(f))), ...files.filter((f) => DATA_EXT.includes(ext(f)))]
}

/** relocate：独立分支里把项目目录的路径换到对话目录（那边删了的返回 undefined） */
export function textSource(
  getIndex: () => Promise<ProjectIndex | undefined>,
  relocate: (f: Cand) => Cand | undefined = (f) => f,
): RouteSource<FindRequest, FindOutcome> {
  return {
    id: TEXT_SOURCE_ID,
    label: t('面板按文本找'),
    via: 'panel',
    rank: TEXT_SOURCE_RANK,
    accepts: (req) => req.kind === 'symbol' || req.kind === 'refs' || req.kind === 'text',
    ready: async () => ((await getIndex()) ? { state: 'ready' } : { state: 'down', why: '项目关了文件索引' }),
    run: async (req, signal) => {
      const idx = (await getIndex())!
      const { partial, ...out } = await scan(idx, req, relocate, signal)
      // 只查了一部分（超时、超个数）的再核对目录重查也是一样查不完，只会让 Agent 多等一轮：直接把「只查了一部分」交回去
      if (out.hits.length || partial || idx.building || signal?.aborted) return out
      // 一条都没有：可能是刚在面板外新建的文件还没进索引（没装监听、监听还没报上来），按目录核对一遍再查一次。
      // 只核对目录的修改时间，几万个目录一两秒；和 action=file 没找到时的做法一样
      const r = await idx.refresh(req.under?.length === 1 ? req.under[0] : undefined)
      if (!r.added) return out
      const { partial: _p, ...again } = await scan(idx, req, relocate, signal)
      return again
    },
  }
}

async function scan(
  idx: ProjectIndex,
  req: FindRequest,
  relocate: (f: Cand) => Cand | undefined,
  signal?: AbortSignal,
): Promise<FindOutcome & { partial: boolean }> {
  await idx.ready(60_000, !req.wide)
  const ext = req.ext?.length ? req.ext : (LANG_EXT[req.lang] ?? TEXT_EXT)
  const found = idx
    // 「*」：所有文件名（空查询索引不回结果），按 under、ext 筛
    .find('*', { under: req.under, ext, cap: MAX_FILES, roots: req.wide ? 'all' : 'project' })
    .map(relocate)
    .filter((f): f is Cand => !!f)
  const files = req.ext?.length || LANG_EXT[req.lang] ? found : dataLast(found)
  const match = textRe(req)
  const decl = req.kind === 'text' ? undefined : declRe(lastName(req.query), req.lang)
  const want = req.offset + req.limit + 200
  const hits: FindHit[] = []
  const t0 = Date.now()
  let next = 0
  let read = 0
  const stopped = () =>
    signal?.aborted || Date.now() - t0 > TIME_MS || hits.length >= (req.kind === 'refs' ? MAX_REFS : want)

  const one = async (f: Cand) => {
    const s = await stat(f.abs).catch(() => undefined)
    if (!s?.isFile() || s.size > MAX_BYTES) return
    const body = await readFile(f.abs, 'utf8').catch(() => undefined)
    if (body === undefined || body.includes('\0')) return
    read++
    const lines = body.split('\n')
    for (let i = 0; i < lines.length; i++) {
      const line = lines[i]
      if (!match.test(line)) continue
      const isDecl = !!decl?.test(line)
      if (req.kind === 'symbol' && !isDecl) continue
      hits.push({
        file: f.path,
        line: i + 1,
        text: line.trim().slice(0, MAX_LINE),
        rank: isDecl ? 0 : req.kind === 'text' ? 2 : 1,
      })
    }
  }
  const worker = async () => {
    while (next < files.length && !stopped()) await one(files[next++])
  }
  await Promise.all(Array.from({ length: PARALLEL }, worker))

  const partial = next < files.length
  const note = partial
    ? `面板按文本只查了 ${read} 个文件（共 ${files.length} 个候选${signal?.aborted ? '，被取消' : Date.now() - t0 > TIME_MS ? '，超过时间上限' : ''}）；用 under / ext 缩小范围再查。`
    : files.length >= MAX_FILES
      ? `候选文件超过 ${MAX_FILES} 个，只查了前面这些；用 under / ext 缩小范围。`
      : undefined
  return { hits, ...(note && { note }), partial: partial || files.length >= MAX_FILES }
}

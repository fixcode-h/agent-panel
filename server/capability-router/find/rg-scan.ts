/**
 * 面板按文本找的快路：本机有 ripgrep 时先用它把含关键词的行全找出来，再交给 text-source 按同一套规则认声明、引用。
 *
 * 为什么：只靠面板逐个读索引里的文件，UE 工程（几万个 json / csv / md）20 秒都读不完，查不完就回「没有找到」，
 * Agent 以为不存在、又自己跑一遍 rg 才找到（用户 2026-11-26：「兜底的不就是 rg 么，find 失败那么就是不存在」）。
 * rg 多线程、跳过二进制，同一个工程一两秒查全；没有 rg（启动失败）时返回 undefined，调用方照旧逐个读文件。
 * 排除目录和 Agent 自己跑的 rg 一样（项目设置的排除 + 默认产物目录 + 二进制资源，shared/search-exclude.ts）
 */
import path from 'node:path'
import { runProcess } from '../../exec/process.ts'
import { SEARCH_SKIP_FILES } from '../../../shared/search-exclude.ts'

/** 一行命中：路径相对 root、正斜杠 */
export interface RgLine {
  file: string
  line: number
  text: string
}

export interface RgScan {
  lines: RgLine[]
  /** 到了时间或条数上限被停掉：结果不全 */
  partial: boolean
}

const TIME_MS = 20_000
const MAX_COLS = 400

/**
 * needle：按原文、不分大小写找（宽一点没关系，调用方会再按精确规则过滤）。
 * under 相对 root；ext 不带点；exclude 是排除的目录名。maxLines 到了就停（声明、引用调用方自己再挑）
 */
export async function rgScan(o: {
  root: string
  needle: string
  under?: string[]
  ext?: string[]
  exclude: string[]
  maxLines: number
  signal?: AbortSignal
  /** 测试替换程序名 */
  program?: string
}): Promise<RgScan | undefined> {
  const args = [
    '--no-config',
    '-n',
    '--no-heading',
    '--with-filename',
    '--color=never',
    '-F',
    '-i',
    `--max-columns=${MAX_COLS}`,
    '--max-filesize=2M',
    // rg 的 glob 后写的优先：扩展名放前面，排除放后面，排除目录里的 .lua 才不会被 *.lua 捞回来
    ...(o.ext ?? []).map((e) => `--glob=*.${e}`),
    ...o.exclude.map((d) => `--glob=!${d}/`),
    ...SEARCH_SKIP_FILES.map((f) => `--glob=!${f}`),
    '--',
    o.needle,
    // 一定写出起点：不写时 rg 发现标准输入是管道，会去搜标准输入
    ...(o.under?.length ? o.under : ['.']),
  ]
  const lines: RgLine[] = []
  const stop = new AbortController()
  const onAbort = () => stop.abort()
  o.signal?.addEventListener('abort', onAbort)
  let full = false
  const r = await runProcess({
    command: o.program ?? 'rg',
    args,
    cwd: o.root,
    env: process.env,
    signal: stop.signal,
    timeoutMs: TIME_MS,
    onLine: (l) => {
      if (full) return
      const m = /^(.+?):(\d+):(.*)$/.exec(l)
      if (!m) return
      lines.push({ file: normRel(m[1]), line: Number(m[2]), text: m[3] })
      if (lines.length >= o.maxLines) {
        full = true
        stop.abort()
      }
    },
  }).finally(() => o.signal?.removeEventListener('abort', onAbort))
  // 没有 rg：交回逐个读文件那条路
  if (r.spawnError) return undefined
  // 0 有命中、1 没有命中；2 是有的文件读不了（权限、坏链接），已经找到的照样算
  if (!r.killed && r.code !== 0 && r.code !== 1 && !lines.length) return undefined
  return { lines, partial: full || r.killed === 'timeout' || (r.killed === 'stopped' && !o.signal?.aborted) }
}

const normRel = (p: string) => path.normalize(p).replace(/\\/g, '/').replace(/^\.\//, '')

import { childEnv, runProcess } from './exec/process.ts'

/**
 * P4 按文件类型分 changelist：C++、表格、Lua、其他各放一个 pending。
 * 以前只把分桶规则写进提示词，Agent 常常图省事建一个「[C++/Lua] …」把几类塞在一起（用户反馈过），
 * 现在由面板照规则执行：Agent 只给每类一句描述，分桶、建 changelist、reopen 都在这里做
 */

export type P4Bucket = 'C++' | 'XLSX' | 'Lua' | 'Other'

/** 分桶顺序：结果和提示里都按这个顺序列 */
export const P4_BUCKETS: P4Bucket[] = ['C++', 'XLSX', 'Lua', 'Other']

const CPP = new Set(['c', 'cc', 'cpp', 'cxx', 'h', 'hh', 'hpp', 'inl', 'ixx', 'mm'])
// 表格：配置表常见的是 Excel，也有导出成 csv 的
const TABLE = new Set(['xlsx', 'xlsm', 'xlsb', 'xls', 'csv'])

/** 按扩展名分桶（depotFile 或本地路径都行） */
export function p4Bucket(file: string): P4Bucket {
  const name = file.split(/[\\/]/).pop() ?? file
  const dot = name.lastIndexOf('.')
  const ext = dot > 0 ? name.slice(dot + 1).toLowerCase() : ''
  if (CPP.has(ext)) return 'C++'
  if (TABLE.has(ext)) return 'XLSX'
  if (ext === 'lua') return 'Lua'
  return 'Other'
}

/** 跑一次 p4：返回退出码、stdout、stderr */
export type P4Run = (args: string[], stdin?: string) => Promise<{ ok: boolean; out: string; err: string }>

/**
 * 在项目目录里跑 p4。PWD 要跟着改：p4 在 Unix 上按 PWD（不是进程的 cwd）找 .p4config，
 * 不改的话用的是面板启动目录的配置，连到别的 client 上
 */
export function p4Runner(cwd: string): P4Run {
  return async (args, stdin) => {
    const lines: string[] = []
    const r = await runProcess({
      command: 'p4',
      args,
      cwd,
      env: { ...childEnv([]), PWD: cwd },
      stdin,
      timeoutMs: 60_000,
      onLine: (l) => lines.push(l),
    })
    const err = r.spawnError ? `p4 启动失败：${r.spawnError}` : r.stderr.trim()
    return { ok: r.code === 0 && !r.spawnError, out: lines.join('\n'), err }
  }
}

/** 解析 p4 -ztag 的输出：每条记录是一组「... key value」行，空行或 key 重复时开始下一条 */
export function parseZtag(out: string): Record<string, string>[] {
  const recs: Record<string, string>[] = []
  let cur: Record<string, string> | null = null
  for (const line of out.split(/\r?\n/)) {
    const m = /^\.\.\. (\S+)(?: (.*))?$/.exec(line)
    if (!m) {
      if (!line.trim() && cur) cur = null
      continue
    }
    const [, key, value = ''] = m
    if (!cur || key in cur) {
      cur = {}
      recs.push(cur)
    }
    cur[key] = value
  }
  return recs
}

/** 一句描述加上类型标签：Agent 自己写了标签（[C++] 或 [C++/Lua]）也换成这一类的 */
function describe(bucket: P4Bucket, text: string) {
  const body = text
    .replace(/\s+/g, ' ')
    .trim()
    .replace(/^\[[^\]]*\]\s*/, '')
  return `[${bucket}] ${body}`
}

/** 新建 pending 的表单：不写 Files，建出来是空的，再用 reopen 把文件挪进去 */
function changeSpec(desc: string) {
  return `Change: new\n\nDescription:\n\t${desc}\n`
}

export interface P4SplitInput {
  /** 从哪个 changelist 分：default 或一个 pending 的编号（把已经混在一起的拆开） */
  from?: string
  /** 只分这些文件（本地路径或 depot 路径）；不写分来源里的全部文件 */
  files?: string[]
  /** 每类一句中文描述，不带标签 */
  descriptions: Partial<Record<P4Bucket, string>>
}

/**
 * 按类型把文件分进各自的新 pending。缺哪类的描述就先不动，列出各类文件让 Agent 补上再调；
 * 从编号的 changelist 分时，挪空了就删掉它（空的 pending 留着只会让人以为还有东西没交）
 */
export async function splitChangelists(run: P4Run, input: P4SplitInput): Promise<{ ok: boolean; info: string }> {
  const from = (input.from ?? '').trim() || 'default'
  if (from !== 'default' && !/^\d+$/.test(from))
    return { ok: false, info: `from 写 default 或 pending changelist 的编号，不是「${from}」` }
  const files = (input.files ?? []).map((f) => f.trim()).filter(Boolean)
  const opened = await run(['-ztag', 'opened', '-c', from, ...files])
  // 没有打开的文件时 p4 把「file(s) not opened」写在 stderr、退出码不一定是 0
  const recs = parseZtag(opened.out).filter((r) => r.depotFile)
  if (!recs.length)
    return {
      ok: false,
      info: `changelist ${from} 里没有${files.length ? '这些' : ''}打开的文件${opened.err ? `（p4：${opened.err}）` : ''}。先用 p4 edit / add 把改动纳入，再调用。`,
    }

  const groups = new Map<P4Bucket, string[]>()
  for (const r of recs) {
    const b = p4Bucket(r.depotFile)
    groups.set(b, [...(groups.get(b) ?? []), r.depotFile])
  }
  const used = P4_BUCKETS.filter((b) => groups.has(b))
  // 编号的 changelist 本来就只有一类：不用拆，挪来挪去只会换掉用户记住的编号
  if (from !== 'default' && used.length === 1)
    return { ok: true, info: `changelist ${from} 里只有 [${used[0]}] 的文件，不用拆。` }
  const list = used.map((b) => `- [${b}] ${groups.get(b)!.length} 个：${groups.get(b)!.join('、')}`).join('\n')
  const missing = used.filter((b) => !input.descriptions[b]?.trim())
  if (missing.length)
    return {
      ok: false,
      info: `还没动任何文件：缺 ${missing.map((b) => `[${b}]`).join('、')} 的描述。这次要分的文件：\n${list}\n给每一类在 descriptions 里写一句中文描述（约 40 字内，不带标签、不写函数名和文件列表）再调用；里面有不属于这次任务的文件就用 files 只列本次的。`,
    }

  const done: string[] = []
  for (const b of used) {
    const desc = describe(b, input.descriptions[b]!)
    const made = await run(['change', '-i'], changeSpec(desc))
    const num = /Change (\d+) created/.exec(made.out)?.[1]
    if (!made.ok || !num)
      return {
        ok: false,
        info: [
          ...done,
          `新建 [${b}] changelist 失败：${made.err || made.out || '没有返回编号'}`,
          '没分完的文件还留在原处。',
        ].join('\n'),
      }
    const moved = await run(['reopen', '-c', num, ...groups.get(b)!])
    if (!moved.ok)
      return {
        ok: false,
        info: [
          ...done,
          `已新建 ${num}「${desc}」，但挪文件失败：${moved.err || moved.out}`,
          '没分完的文件还留在原处。',
        ].join('\n'),
      }
    // 回读描述：服务器字符集不对时中文会变成 ?，提醒 Agent 去改，不悄悄当成功
    const back = await run(['-ztag', 'describe', '-s', num])
    const got = parseZtag(back.out)[0]?.desc?.trim() ?? ''
    const garbled =
      got && got !== desc ? `（回读的描述是「${got}」，和写入的不一样，可能是字符集问题，要改用 p4 change ${num}）` : ''
    done.push(`- ${num}「${desc}」：${groups.get(b)!.length} 个文件${garbled}`)
  }

  let tail = ''
  if (from !== 'default' && !files.length) {
    const del = await run(['change', '-d', from])
    tail = del.ok
      ? `\n原来的 ${from} 已经挪空，已删除。`
      : `\n原来的 ${from} 已经挪空，但没删掉（${del.err || del.out}），可能还有搁置的文件，留给用户处理。`
  }
  const stale = await staleFiles(
    run,
    recs.map((r) => r.depotFile),
  )
  return { ok: true, info: `已按类型分好（没有 submit）：\n${done.join('\n')}${tail}${stale}` }
}

/**
 * 不是最新版本的文件（P4V 里带红三角）：工作区落后，提交前要先同步再解决冲突。
 * Agent 不 sync，只把它们列出来交给用户，不当成功悄悄带过（用户反馈过「最新版本」的问题）
 */
async function staleFiles(run: P4Run, files: string[]) {
  const r = await run(['-ztag', 'fstat', '-T', 'depotFile,haveRev,headRev', ...files])
  const old = parseZtag(r.out).filter((x) => x.haveRev && x.headRev && Number(x.haveRev) < Number(x.headRev))
  if (!old.length) return ''
  const list = old.map((x) => `${x.depotFile}（本地 #${x.haveRev}，最新 #${x.headRev}）`).join('、')
  return `\n注意：这些文件不是最新版本，提交前要先 sync 并 resolve：${list}。你不 sync，把这句原样告诉用户。`
}

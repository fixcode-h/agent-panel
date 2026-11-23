/**
 * 一个目录归哪种版本管理（版本管理服务，ADR 0073）：面板和插件只用这一套判断。
 * 以前面板（projects-analyze.ts）和 UE 插件（ue/server/detect.ts）各写一份：P4 配置文件名一个认 8 个、一个认 4 个，
 * 往上找的层数 6 和 12，同一层 svn / p4 的先后也不一样——同一个目录两边可能判断成不同的版本管理。
 *
 * 往上找 .git / .svn，P4 看配置文件（常见名字 + 环境变量和 p4 set 里的 P4CONFIG）。
 * 不跑 p4 where：要连服务器，慢的时候几秒，每次判断版本管理都卡住（用户 2026-11-23：「p4 where 不要用这个」）
 */
import { stat } from 'node:fs/promises'
import path from 'node:path'
import { vcsExec } from './run.ts'

export type VcsKind = 'git' | 'p4' | 'svn' | 'none'

/** P4 工作区根常在项目上面好几层（引擎和项目在同一个工作区里） */
const MAX_UP = 12
/** 常见的 P4 配置文件名（再加上环境变量和 p4 set 里设的） */
const P4_NAMES = ['.p4config', '.p4ignore', 'p4config.txt', '.p4config.txt', 'p4config', 'P4CONFIG']

const exists = (p: string) =>
  stat(p).then(
    () => true,
    () => false,
  )

let p4Config: Promise<string | undefined> | undefined // 模块状态：缓存，进程里只问一次

/** p4 set 里的 P4CONFIG（只读本机设置，不连服务器）：P4CONFIG=p4config.txt (set)；没装 p4、没设都返回 undefined */
function p4ConfigName() {
  p4Config ??= vcsExec('p4', ['set', '-q', 'P4CONFIG'], process.cwd(), { timeoutMs: 3000 }).then(
    (r) => /^P4CONFIG=([^\s(]+)/m.exec(r.stdout.toString('utf8').trim())?.[1],
    () => undefined,
  )
  return p4Config
}

/** 同一层的先后：git 先于 p4 先于 svn（P4 工作区里单独 git init 的脚本目录按 git 算） */
export async function detectVcs(dir: string): Promise<{ vcs: VcsKind; root: string }> {
  const p4Names = [...new Set([...P4_NAMES, process.env.P4CONFIG?.trim(), await p4ConfigName()])].filter(
    (x): x is string => !!x,
  )
  let cur = dir
  for (let i = 0; i < MAX_UP; i++) {
    if (await exists(path.join(cur, '.git'))) return { vcs: 'git', root: cur }
    for (const name of p4Names) if (await exists(path.join(cur, name))) return { vcs: 'p4', root: cur }
    if (await exists(path.join(cur, '.svn'))) return { vcs: 'svn', root: cur }
    const up = path.dirname(cur)
    if (up === cur) break
    cur = up
  }
  return { vcs: 'none', root: dir }
}

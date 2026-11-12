import { open as openFd, stat } from 'node:fs/promises'
import os from 'node:os'
import path from 'node:path'
import type { Task } from '../../shared/schema.ts'
import { openWithSystem, revealDir, revealItem } from '../open.ts'

/**
 * 对话消息里提到的文件路径：找到本机上真实的那个文件，给悬停卡片看信息，点了用合适的方式打开。
 *
 * Agent 写的相对路径不一定相对对话的工作目录：P4 / SVN 工程里常常相对工作区根写
 * （`Project/Designer/Excel/a.xlsx`，项目目录是 `<根>/Project/Client`），所以按顺序在几个根下面找，先找到的算数。
 */

/** 一个路径解析出来的样子：rel 是相对对话目录 / 项目目录的写法（都不在里面时为空，界面只显示完整路径） */
export interface PathInfo {
  /** 消息里原样写的路径（不含行号） */
  path: string
  abs: string
  rel: string
  /** 在对话的工作目录里：面板预览可以直接用原来的写法读，不在时要按完整路径读 */
  inTask: boolean
  exists: boolean
  dir: boolean
  /** 是文字（开头一段没有 0 字节）：能在面板里预览 */
  text: boolean
  size?: number
  mtime?: string
}

/** 项目目录往上最多找几层：再往上就到盘符根了，同名文件撞上的机会比找对的大 */
const UP_LEVELS = 4
/** 判断是不是文字只看开头这么多字节（和 git 判断二进制的做法一样） */
const SNIFF = 8000

/** 绝对路径的各种写法：Linux 上 path.isAbsolute('C:/x') 是 false，盘符和 UNC 也要认 */
const absoluteLike = (p: string) => path.isAbsolute(p) || /^[a-zA-Z]:[\\/]/.test(p) || /^[\\/]{2}/.test(p)

function inside(root: string, full: string) {
  const r = path.relative(root, full)
  return !!root && r !== '..' && !r.startsWith(`..${path.sep}`) && !path.isAbsolute(r)
}

/** 找文件的根：对话目录、项目目录，再加项目目录的几层上级（版本库或工作区的根大概率在其中） */
export function searchRoots(taskDir: string, projectDir: string): string[] {
  const out: string[] = []
  const add = (d: string) => d && !out.includes(path.resolve(d)) && out.push(path.resolve(d))
  add(taskDir)
  add(projectDir)
  let up = projectDir ? path.resolve(projectDir) : ''
  for (let i = 0; up && i < UP_LEVELS; i++) {
    const parent = path.dirname(up)
    if (parent === up) break
    add(parent)
    up = parent
  }
  return out
}

/** 相对哪一个根显示：对话目录优先，其次项目目录；上级目录里找到的不算「项目内」 */
function relOf(full: string, homes: string[]) {
  for (const h of homes) if (inside(h, full)) return path.relative(h, full).split(path.sep).join('/')
  return ''
}

async function isText(full: string) {
  const fd = await openFd(full, 'r').catch(() => null)
  if (!fd) return false
  try {
    const buf = Buffer.alloc(SNIFF)
    const { bytesRead } = await fd.read(buf, 0, SNIFF, 0)
    return !buf.subarray(0, bytesRead).includes(0)
  } finally {
    await fd.close()
  }
}

/** 解析一个路径。homes 是「项目内」的根（对话目录、项目目录），roots 是找文件的全部根 */
export async function resolvePath(want: string, roots: string[], homes: string[]): Promise<PathInfo> {
  const raw = want.trim()
  const expanded = /^~[\\/]/.test(raw) ? path.join(os.homedir(), raw.slice(2)) : raw
  const tries = absoluteLike(expanded) ? [path.resolve(expanded)] : roots.map((r) => path.resolve(r, expanded))
  for (const full of tries) {
    const info = await stat(full).catch(() => null)
    if (!info) continue
    return {
      path: raw,
      abs: full,
      rel: relOf(full, homes),
      inTask: !!homes[0] && inside(homes[0], full),
      exists: true,
      dir: info.isDirectory(),
      text: info.isFile() && (await isText(full)),
      size: info.isFile() ? info.size : undefined,
      mtime: info.mtime.toISOString(),
    }
  }
  // 哪里都没有：按第一个根拼出来给界面显示（虚线、划掉），复制路径也能复制到它本该在的位置
  const abs = tries[0] ?? expanded
  const inTask = !!homes[0] && inside(homes[0], abs)
  return { path: raw, abs, rel: relOf(abs, homes), inTask, exists: false, dir: false, text: false }
}

/** 统一成 / 再比：Windows 上 Agent 写的路径正反斜杠都有 */
const slash = (s: string) => s.replace(/\\/g, '/')

/**
 * 这个路径在对话里出现过：消息正文、工具行的标题、输入和输出。
 * 打开接口只打开对话里真的提到过的文件，本机服务谁都能往 127.0.0.1 发请求，不能凭一段任意路径就让系统去打开
 */
export function mentioned(task: Pick<Task, 'messages'>, want: string) {
  const needle = slash(want.trim())
  if (!needle) return false
  const has = (s?: string) => !!s && slash(s).includes(needle)
  return task.messages.some(
    (m) =>
      has(m.text) ||
      m.attachments?.some((a) => has(a.path)) ||
      m.tools.some((x) => has(x.label) || has(x.input) || has(x.output)),
  )
}

/** 能不能打开：在对话目录 / 项目目录里面，或者对话里提到过 */
export const openable = (task: Pick<Task, 'messages'>, info: PathInfo, homes: string[]) =>
  info.exists && (homes.some((h) => inside(h, info.abs)) || mentioned(task, info.path))

/**
 * 打开解析好的路径：目录在文件管理器里打开；文件交给系统默认程序，
 * 会被当成脚本执行的类型（不在 open.ts 的白名单里）只在文件夹里选中，不运行。返回是不是改成了在文件夹中显示
 */
export async function openPath(info: PathInfo, reveal: boolean): Promise<{ revealed: boolean }> {
  if (info.dir) {
    await revealDir(info.abs)
    return { revealed: true }
  }
  if (!reveal && (await openWithSystem(info.abs))) return { revealed: false }
  await revealItem(info.abs)
  return { revealed: true }
}

/**
 * 演示：项目程序在本机的位置（shared/custom-tools/programs.ts）。没有本机磁盘：登记时不查文件在不在，
 * 样例里放一条「找不到了」的，看得到界面怎么标；登记、覆盖、删除用 shared 里的同一份逻辑
 */
import { programProblem, upsertProgram, withoutProgram, type ProgramPathView } from '@shared/custom-tools/programs'
import { fail } from './demo-http'

const FILE = '/home/demo/.agent-panel/program-paths.json'

// 模块状态：演示数据只在这一页里，刷新回到样例
let items: ProgramPathView[] = [
  {
    name: 'luac',
    path: '/home/demo/projects/shop/Tools/Lua/luac',
    note: 'Lua 5.4 语法检查',
    at: '2026-11-26T03:10:00.000Z',
    by: '修复背包出售按钮',
  },
  {
    name: 'TableExporter',
    path: '/home/demo/projects/shop/Tools/Excel/TableExporter.exe',
    note: '导表，单表加 -sheet',
    at: '2026-11-25T08:00:00.000Z',
    by: '我',
  },
  {
    name: 'texconv',
    path: '/opt/old-tools/texconv',
    note: '',
    at: '2026-11-10T02:00:00.000Z',
    by: '贴图压缩',
    missing: true,
  },
]

export function demoProgramPaths(method: string, seg: string[], body: unknown) {
  if (method === 'GET') return { items, file: FILE }
  if (method === 'PUT') {
    const b = (body ?? {}) as { name?: string; path?: string; note?: string }
    const name = String(b.name ?? '').trim()
    const path = String(b.path ?? '').trim()
    const bad = programProblem(name, path)
    if (bad) return { ok: false, info: bad }
    items = upsertProgram(items, {
      name,
      path,
      note: String(b.note ?? '').trim(),
      at: new Date().toISOString(),
      by: '我',
    })
    return { ok: true, info: `已登记 ${name}：${path}` }
  }
  if (method === 'DELETE') {
    const name = decodeURIComponent(seg[1] ?? '')
    const r = withoutProgram(items, name)
    items = r.rest
    return r.found ? { ok: true, info: `已删掉 ${name} 的登记` } : { ok: false, info: `没有登记过 ${name}` }
  }
  return fail('不支持的请求', 405)
}

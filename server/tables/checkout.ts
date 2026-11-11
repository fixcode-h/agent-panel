/**
 * 把本地表格切换到某一版：取那一版文件的原始字节（git show / p4 print / svn cat，三种版本控制一个做法），
 * 整个替换本地文件。不动版本控制的状态（不 checkout 分支、不 p4 sync），切完在版本控制里就是一处本地改动，
 * 要留就提交、不要就再切回最新版。替换前和保存一样：查只读、查 Excel / WPS 占用、备份原文件、P4 只读文件先 p4 edit。
 */
import path from 'node:path'
import { access, constants, readFile, rename, rm, stat, writeFile } from 'node:fs/promises'
import { t } from '../../shared/i18n.ts'
import { tableKind, type TableDoc, type TablesConfig } from '../../shared/tables.ts'
import { forgetLists, forgetTable, lockedByOffice, openTable, safeRel } from './files.ts'
import { rawAt } from './history.ts'
import { backup, type SaveDeps } from './write.ts'
import { HttpError } from './http-error.ts'

export interface CheckoutBody {
  path: string
  rev: string
}

export async function checkoutTable(
  dir: string,
  projectId: string,
  cfg: TablesConfig,
  body: CheckoutBody,
  /** 版本命令在哪个目录跑、文件在那边叫什么（项目目录外的表格在它自己的仓库里跑） */
  vcs: { cwd: string; rel: string },
  deps: SaveDeps = {},
): Promise<TableDoc> {
  if (cfg.readOnly) throw new HttpError(t('项目设置里把表格设成了只读'), 409)
  const { rel, full } = safeRel(dir, body.path, cfg)
  if (!tableKind(rel)) throw new HttpError(t('不是表格文件：{path}', { path: rel }))
  const buf = await rawAt(vcs.cwd, vcs.rel, body.rev)
  if (!buf) throw new HttpError(t('那一版里还没有这个文件'), 404)
  const info = await stat(full).catch(() => null)
  if (info && !info.isFile()) throw new HttpError(t('不是文件：{path}', { path: rel }))
  if (info && (await lockedByOffice(full)))
    throw new HttpError(t('文件正在 Excel / WPS 里打开，先在那边关掉再切换（不然那边保存时会把切换的内容盖掉）'), 409)
  // 内容本来就一样：什么都不写
  if (info && buf.equals(await readFile(full))) return openTable(dir, rel, cfg)
  if (info) {
    const writable = await access(full, constants.W_OK).then(
      () => true,
      () => false,
    )
    if (!writable) {
      const p4 = deps.p4Edit ? await deps.p4Edit(full) : false
      if (p4 && !p4.ok) throw new HttpError(t('p4 edit 失败：{err}', { err: p4.err }), 409)
      if (!p4) throw new HttpError(t('文件是只读的，没有权限写入'), 409)
    }
    await backup(projectId, rel, full)
  }
  // 同目录的临时文件再改名替换：写到一半断电也不会留下半个文件
  const tmp = path.join(path.dirname(full), `.${path.basename(full)}.${process.pid}.agentpanel-tmp`)
  try {
    await writeFile(tmp, buf)
    await rename(tmp, full)
  } catch (e) {
    await rm(tmp, { force: true })
    throw new HttpError(t('写入失败：{err}', { err: (e as Error).message }), 409)
  }
  forgetTable(full)
  forgetLists()
  return openTable(dir, rel, cfg)
}

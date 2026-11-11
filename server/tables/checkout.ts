/**
 * 把本地表格切换到某一版：取那一版文件的原始字节（git show / p4 print / svn cat，三种版本控制一个做法），
 * 整个替换本地文件。不动版本控制的状态（不 checkout 分支、不 p4 sync），切完在版本控制里就是一处本地改动，
 * 要留就提交、不要就再切回最新版。替换前和保存一样：查只读、查 Excel / WPS 占用、备份原文件、P4 只读文件先 p4 edit。
 */
import { t } from '../../shared/i18n.ts'
import { tableKind, type TableDoc, type TablesConfig } from '../../shared/tables.ts'
import { openTable, safeRel } from './files.ts'
import { rawAt } from './history.ts'
import type { SaveDeps } from './write.ts'
import { replaceTableBytes } from './replace.ts'
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
  await replaceTableBytes(projectId, rel, full, buf, deps)
  return openTable(dir, rel, cfg)
}

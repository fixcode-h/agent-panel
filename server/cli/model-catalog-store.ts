/**
 * 用户的模型补充目录：数据目录的 config/models.json。
 * 内置目录（shared/models/catalog.json）跟不上新模型时，AI 联网查到的那条写在这里，
 * 和内置目录合并后使用（同厂商同 id 的覆盖内置的）。
 */
import path from 'node:path'
import {
  BUILTIN_MODEL_CATALOG,
  mergeCatalog,
  parseModelCatalog,
  type ModelCatalogEntry,
} from '../../shared/models/catalog.ts'
import { catalogKey } from '../../shared/models/discover.ts'
import { DATA_DIR, readJson, writeJsonAtomic } from '../store.ts'

export const MODEL_CONFIG_DIR = path.join(DATA_DIR, 'config')
export const MODEL_CONFIG_FILE = path.join(MODEL_CONFIG_DIR, 'models.json')

/**
 * 读到的补充目录；文件不存在时当作空的。旧目录里的 Gemini 协议和单条坏记录由 parseModelCatalog 处理，
 * 不能让它们让整份目录失效（保存时会把整份覆盖掉）
 */
export async function userModelCatalog(): Promise<ModelCatalogEntry[]> {
  return parseModelCatalog(await readJson(MODEL_CONFIG_FILE))
}

/** 内置目录 + 用户补充目录 */
export async function mergedModelCatalog(): Promise<ModelCatalogEntry[]> {
  return mergeCatalog(BUILTIN_MODEL_CATALOG, await userModelCatalog())
}

/** 写入一条（同厂商同 id 的替换），返回写入后的全部补充记录 */
export async function saveModelEntry(entry: ModelCatalogEntry): Promise<ModelCatalogEntry[]> {
  return saveModelEntries([entry])
}

/** 一次写入几条（联网检查后勾选加入的），同厂商同 id 的替换 */
export async function saveModelEntries(entries: ModelCatalogEntry[]): Promise<ModelCatalogEntry[]> {
  const keys = new Set(entries.map(catalogKey))
  const list = await userModelCatalog()
  return writeUserCatalog([...list.filter((m) => !keys.has(catalogKey(m))), ...entries])
}

/** 删掉一条补充记录（同名的内置记录重新生效）；没有这条时原样返回 */
export async function removeModelEntry(vendor: string, id: string): Promise<ModelCatalogEntry[]> {
  const key = catalogKey({ vendor, id })
  const list = await userModelCatalog()
  if (!list.some((m) => catalogKey(m) === key)) return list
  return writeUserCatalog(list.filter((m) => catalogKey(m) !== key))
}

async function writeUserCatalog(models: ModelCatalogEntry[]) {
  await writeJsonAtomic(MODEL_CONFIG_FILE, { updated: new Date().toISOString().slice(0, 10), models })
  return models
}

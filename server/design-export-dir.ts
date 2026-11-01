import { readdir, readFile } from 'node:fs/promises'
import path from 'node:path'

/** 导出到项目目录时写进目录里的标记：认出这是哪个设计导出的 */
export const EXPORT_MARK = '.agent-panel.json'

/**
 * 导出到项目目录（<项目>/UI/<名字>/）时选目录：
 * - 目录不存在或是空的：直接用
 * - 标记是同一个设计：用它，并清掉上次导出的贴图（删掉的贴图不再残留）
 * - 标记是别的设计、或者没有标记但已经有东西：名字后面加设计 id 的前几位另起一个目录。
 *   以前中文标题的游戏 UI 都叫 WBP_Design，导出到同一个目录会互相覆盖、不提示
 */
export async function pickExportDir(
  base: string,
  name: string,
  designId: string,
): Promise<{ dir: string; clean: boolean }> {
  const owner = async (dir: string): Promise<'empty' | 'mine' | 'other'> => {
    const list = await readdir(dir).catch(() => null)
    if (!list || !list.length) return 'empty'
    const mark = await readFile(path.join(dir, EXPORT_MARK), 'utf8')
      .then((t) => JSON.parse(t) as { designId?: string })
      .catch(() => null)
    return mark?.designId === designId ? 'mine' : 'other'
  }
  const first = path.join(base, name)
  const a = await owner(first)
  if (a !== 'other') return { dir: first, clean: a === 'mine' }
  const second = path.join(base, `${name}_${designId.replace(/[^\w]/g, '').slice(0, 6)}`)
  const b = await owner(second)
  if (b !== 'other') return { dir: second, clean: b === 'mine' }
  // 极少见：两个都被占了，用完整的 id
  return { dir: path.join(base, `${name}_${designId.replace(/[^\w-]/g, '')}`), clean: true }
}

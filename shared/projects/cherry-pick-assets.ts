/**
 * cherry-pick 时哪些文件算「资源文件」（用户 2026-11-19 定）：资源文件冲突时不解冲突，直接用搬过去的那一版覆盖目标；
 * 代码这类文本文件冲突时才去解。判定按扩展名清单（项目设置里能改，没设时用这份默认的），
 * 清单外的文件只要内容是二进制（开头 8000 字节里有 NUL，和 git 一样）也按资源文件处理：二进制没法按行合
 */

/** 默认的资源文件扩展名：UE 资源、贴图、模型、音视频、字体、表格文档、编译产物和压缩包 */
export const DEFAULT_ASSET_EXTS: readonly string[] = [
  // UE
  '.uasset',
  '.umap',
  '.ubulk',
  '.uexp',
  '.upk',
  '.pak',
  // 贴图
  '.png',
  '.jpg',
  '.jpeg',
  '.tga',
  '.bmp',
  '.gif',
  '.webp',
  '.psd',
  '.dds',
  '.exr',
  '.hdr',
  '.tif',
  '.tiff',
  '.ico',
  // 模型、场景
  '.fbx',
  '.obj',
  '.blend',
  '.max',
  '.ma',
  '.mb',
  '.abc',
  '.gltf',
  '.glb',
  // 音视频
  '.wav',
  '.ogg',
  '.mp3',
  '.mp4',
  '.mov',
  '.bik',
  '.bnk',
  '.wem',
  // 字体
  '.ttf',
  '.otf',
  // 表格、文档
  '.xlsx',
  '.xls',
  '.docx',
  '.pdf',
  // 编译产物、压缩包
  '.dll',
  '.exe',
  '.pdb',
  '.lib',
  '.so',
  '.a',
  '.zip',
  '.7z',
  '.bin',
]

/** 用户填的一项规整成「.小写扩展名」：「uasset」「*.uasset」「.UASSET」都认；填空的、带路径的不要 */
export function normalizeAssetExt(raw: string): string {
  const s = raw.trim().replace(/^\*/, '').toLowerCase()
  if (!s || /[\\/\s]/.test(s)) return ''
  return s.startsWith('.') ? s : `.${s}`
}

/** 输入框里的文字（逗号、顿号、空格、换行分隔）→ 去重后的扩展名清单 */
export function parseAssetExts(text: string): string[] {
  return [
    ...new Set(
      text
        .split(/[,，、\s]+/)
        .map(normalizeAssetExt)
        .filter(Boolean),
    ),
  ]
}

/** 项目实际用的清单：没设过（undefined）用默认的；设成空数组表示只按「是不是二进制」判断 */
export function assetExtsOf(project: { cherryPickAssets?: string[] } | undefined): string[] {
  const own = project?.cherryPickAssets
  return own ? own.map(normalizeAssetExt).filter(Boolean) : [...DEFAULT_ASSET_EXTS]
}

/** 按扩展名判断一个路径是不是资源文件（内容是不是二进制由调用方另外看） */
export function isAssetPath(file: string, exts: readonly string[]): boolean {
  const name = file.split(/[\\/]/).at(-1)?.toLowerCase() ?? ''
  return exts.some((e) => name.endsWith(e) && name.length > e.length)
}

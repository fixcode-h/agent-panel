import { File, FileCode2, FileImage, FileJson, FileText } from 'lucide-react'

/**
 * 按扩展名挑图标，让常见文件一眼能认出来。
 * 文件树、「改动」树和搜索结果共用这一份，别在组件里各抄一遍。
 */
export function fileIcon(path: string) {
  const ext = path.slice(path.lastIndexOf('.') + 1).toLowerCase()
  if (/^(png|jpe?g|gif|webp|svg|bmp|ico)$/.test(ext)) return FileImage
  if (/^(json|jsonc|ya?ml|toml|ini|lock)$/.test(ext)) return FileJson
  if (/^(md|mdx|txt|rst)$/.test(ext)) return FileText
  if (/^(ts|tsx|js|jsx|mjs|cjs|vue|svelte|py|go|rs|java|kt|swift|c|h|cc|cpp|hpp|cs|rb|php|lua|sh|ps1)$/.test(ext))
    return FileCode2
  return File
}

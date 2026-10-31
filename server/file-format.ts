/**
 * 文本文件的编码和换行符：按设置里的格式把字符串变成要写进文件的字节。
 *
 * 项目在 Windows 上编辑、在 WSL / Linux 里跑测试，CRLF 会让带 shebang 的脚本报
 * 「bad interpreter: /usr/bin/env node^M」，BOM 会让 shebang 直接失效，所以默认
 * UTF-8 无 BOM + LF，并且允许在项目设置和全局设置里改。
 */
import { writeFile } from 'node:fs/promises'
import { DEFAULT_FILE_FORMAT, type FileFormat, type Settings } from '../shared/schema.ts'

/** 项目的格式：项目自己设了就用项目的，否则跟随全局设置 */
export function projectFormat(project: { fileFormat?: FileFormat } | undefined, settings: Settings): FileFormat {
  return project?.fileFormat ?? settings.fileFormat ?? DEFAULT_FILE_FORMAT
}

/** 换行统一成 LF，再按格式换成 CRLF：避免文件里混着两种 */
const eolOf = (text: string, eol: FileFormat['eol']) => {
  const lf = text.replace(/\r\n?/g, '\n')
  return eol === 'crlf' ? lf.replace(/\n/g, '\r\n') : lf
}

/** 按格式把文本变成要写进文件的字节 */
export function encodeText(text: string, format: FileFormat): Buffer {
  const body = eolOf(text, format.eol)
  // UTF-8 的 BOM 是 EF BB BF；Buffer.from 不会自动加，要自己拼
  return Buffer.from(format.encoding === 'utf8-bom' ? `\ufeff${body}` : body, 'utf8')
}

/** 按格式写一个面板自己生成 / 改写的文本文件 */
export async function writeTextFile(file: string, text: string, format: FileFormat) {
  await writeFile(file, encodeText(text, format))
}

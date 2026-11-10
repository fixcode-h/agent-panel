import { inflateRawSync } from 'node:zlib'

/**
 * 读 zip（插件安装包、GitHub 的源码包和 Release 附件）：只认「存储」和「deflate」两种压缩方式，够用且不引依赖。
 * 按中央目录读，不信本地文件头里的大小（有的打包工具在那里写 0、数据后面另跟描述符）。
 */

export interface ZipEntry {
  /** 用 / 分隔的相对路径；目录项不返回 */
  name: string
  data: Buffer
}

/** 单个文件解压后最大多少、整个包最多多少：防止压缩炸弹把内存吃光 */
const MAX_FILE = 64 * 1024 * 1024
const MAX_TOTAL = 512 * 1024 * 1024

export function readZip(buf: Buffer): ZipEntry[] {
  // 找中央目录结束记录（EOCD）：在最后 64KB + 22 字节里倒着找签名
  let eocd = -1
  for (let i = buf.length - 22; i >= Math.max(0, buf.length - 65_557); i--)
    if (buf.readUInt32LE(i) === 0x06054b50) {
      eocd = i
      break
    }
  if (eocd < 0) throw new Error('不是 zip 文件')
  const count = buf.readUInt16LE(eocd + 10)
  let p = buf.readUInt32LE(eocd + 16)
  const out: ZipEntry[] = []
  let total = 0
  for (let n = 0; n < count; n++) {
    if (buf.readUInt32LE(p) !== 0x02014b50) throw new Error('zip 的目录损坏')
    const flags = buf.readUInt16LE(p + 8)
    const method = buf.readUInt16LE(p + 10)
    const csize = buf.readUInt32LE(p + 20)
    const usize = buf.readUInt32LE(p + 24)
    const nameLen = buf.readUInt16LE(p + 28)
    const extraLen = buf.readUInt16LE(p + 30)
    const commentLen = buf.readUInt16LE(p + 32)
    const local = buf.readUInt32LE(p + 42)
    // 文件名一律按 UTF-8 读：没标 UTF-8（第 11 位）的老工具写的一般也是 ASCII，读出来一样
    const name = buf.toString('utf8', p + 46, p + 46 + nameLen).replaceAll('\\', '/')
    p += 46 + nameLen + extraLen + commentLen
    if (name.endsWith('/')) continue
    if (flags & 1) throw new Error(`zip 里的文件加了密码：${name}`)
    if (usize > MAX_FILE) throw new Error(`zip 里的文件太大：${name}`)
    total += usize
    if (total > MAX_TOTAL) throw new Error('zip 解压后太大')
    if (buf.readUInt32LE(local) !== 0x04034b50) throw new Error('zip 的文件头损坏')
    const start = local + 30 + buf.readUInt16LE(local + 26) + buf.readUInt16LE(local + 28)
    const raw = buf.subarray(start, start + csize)
    let data: Buffer
    if (method === 0) data = Buffer.from(raw)
    else if (method === 8) data = inflateRawSync(raw, { maxOutputLength: MAX_FILE })
    else throw new Error(`zip 用了不支持的压缩方式（${method}）：${name}`)
    out.push({ name, data })
  }
  return out
}

/** 安全的相对路径：不能是绝对路径，不能有 ..，不能是空段（反斜杠也当分隔符：Windows 上 path.join 会认它） */
export function safeRel(name: string) {
  const parts = name.split(/[\\/]/)
  if (/^[\\/]/.test(name) || /^[a-zA-Z]:/.test(name)) return false
  return parts.every((s) => s && s !== '..' && s !== '.')
}

/**
 * 改写 xlsx 用的 zip 读写：只换掉改了的几个条目（工作表、共享字符串），其余条目的压缩数据、
 * 本地头、时间戳逐字节照搬，样式、图片、宏（xlsm 的 vbaProject.bin）、WPS 自己的扩展部件都原样留着。
 * 不认 zip64、加密、分卷（表格文件用不到；遇到就拒绝改写，不冒险）。
 */
import { deflateRawSync, inflateRawSync } from 'node:zlib'

/** zip 里单个文件解压后最多这么大：防压缩炸弹 */
const MAX_ENTRY = 120_000_000

export interface RawEntry {
  name: string
  /** 中央目录里这一条的原始字节（含文件名、扩展、注释） */
  central: Buffer
  flags: number
  method: number
  crc: number
  csize: number
  usize: number
  /** 本地头在文件里的位置 */
  offset: number
  /** 本地头 + 数据 + 数据描述符一共多长（照搬时整段复制） */
  span: number
  /** 压缩数据从哪开始 */
  dataAt: number
}

export interface RawZip {
  buf: Buffer
  entries: RawEntry[]
  /** 结尾记录里的注释 */
  comment: Buffer
}

const fail = (why: string): never => {
  throw new Error(`zip: ${why}`)
}

export function readZip(buf: Buffer): RawZip {
  let end = -1
  for (let i = buf.length - 22; i >= Math.max(0, buf.length - 22 - 0xffff); i--)
    if (buf.readUInt32LE(i) === 0x06054b50) {
      end = i
      break
    }
  if (end < 0) fail('not a zip')
  if (buf.readUInt16LE(end + 4) !== 0 || buf.readUInt16LE(end + 6) !== 0) fail('multi-disk')
  const count = buf.readUInt16LE(end + 10)
  const cdSize = buf.readUInt32LE(end + 12)
  let at = buf.readUInt32LE(end + 16)
  if (count === 0xffff || at === 0xffffffff || cdSize === 0xffffffff) fail('zip64')
  const comment = buf.subarray(end + 22, end + 22 + buf.readUInt16LE(end + 20))
  const entries: RawEntry[] = []
  for (let n = 0; n < count; n++) {
    if (at + 46 > buf.length || buf.readUInt32LE(at) !== 0x02014b50) fail('bad central directory')
    const nameLen = buf.readUInt16LE(at + 28)
    const len = 46 + nameLen + buf.readUInt16LE(at + 30) + buf.readUInt16LE(at + 32)
    const flags = buf.readUInt16LE(at + 8)
    if (flags & 1) fail('encrypted')
    const csize = buf.readUInt32LE(at + 20)
    const usize = buf.readUInt32LE(at + 24)
    const offset = buf.readUInt32LE(at + 42)
    if (csize === 0xffffffff || usize === 0xffffffff || offset === 0xffffffff) fail('zip64')
    if (buf.readUInt32LE(offset) !== 0x04034b50) fail('bad local header')
    const dataAt = offset + 30 + buf.readUInt16LE(offset + 26) + buf.readUInt16LE(offset + 28)
    let span = dataAt + csize - offset
    // 数据描述符：位 3 置上时跟在数据后面，可能带签名（16 字节）也可能不带（12 字节）
    if (flags & 8) span += buf.readUInt32LE(dataAt + csize) === 0x08074b50 ? 16 : 12
    entries.push({
      name: buf.toString('utf8', at + 46, at + 46 + nameLen),
      central: buf.subarray(at, at + len),
      flags,
      method: buf.readUInt16LE(at + 10),
      crc: buf.readUInt32LE(at + 16),
      csize,
      usize,
      offset,
      span,
      dataAt,
    })
    at += len
  }
  return { buf, entries, comment }
}

export function entryText(zip: RawZip, name: string): string | null {
  const e = zip.entries.find((x) => x.name === name)
  if (!e) return null
  const data = zip.buf.subarray(e.dataAt, e.dataAt + e.csize)
  if (e.method === 0) return data.toString('utf8')
  if (e.method !== 8) fail(`unsupported method ${e.method}`)
  return inflateRawSync(data, { maxOutputLength: MAX_ENTRY }).toString('utf8')
}

const CRC_TABLE = (() => {
  const t = new Uint32Array(256)
  for (let n = 0; n < 256; n++) {
    let c = n
    for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1
    t[n] = c >>> 0
  }
  return t
})()

export function crc32(data: Buffer) {
  let c = 0xffffffff
  for (let i = 0; i < data.length; i++) c = CRC_TABLE[(c ^ data[i]) & 0xff] ^ (c >>> 8)
  return (c ^ 0xffffffff) >>> 0
}

/**
 * 重新拼 zip：replace 里的条目换成新内容（deflate 压缩），其余照搬原来的字节。
 * 条目顺序、文件名、时间戳、扩展字段都不变
 */
export function writeZip(zip: RawZip, replace: Map<string, string>): Buffer {
  const parts: Buffer[] = []
  const central: Buffer[] = []
  let offset = 0
  for (const e of zip.entries) {
    const text = replace.get(e.name)
    if (text === undefined) {
      parts.push(zip.buf.subarray(e.offset, e.offset + e.span))
      const c = Buffer.from(e.central)
      c.writeUInt32LE(offset, 42)
      central.push(c)
      offset += e.span
      continue
    }
    const raw = Buffer.from(text, 'utf8')
    const data = deflateRawSync(raw)
    const crc = crc32(raw)
    const oldLocal = zip.buf.subarray(e.offset, e.dataAt)
    const local = Buffer.from(oldLocal)
    // 换了内容：不再用数据描述符，大小和校验写在头里
    const flags = e.flags & ~8
    local.writeUInt16LE(flags, 6)
    local.writeUInt16LE(8, 8)
    local.writeUInt32LE(crc, 14)
    local.writeUInt32LE(data.length, 18)
    local.writeUInt32LE(raw.length, 22)
    parts.push(local, data)
    const c = Buffer.from(e.central)
    c.writeUInt16LE(flags, 8)
    c.writeUInt16LE(8, 10)
    c.writeUInt32LE(crc, 16)
    c.writeUInt32LE(data.length, 20)
    c.writeUInt32LE(raw.length, 24)
    c.writeUInt32LE(offset, 42)
    central.push(c)
    offset += local.length + data.length
  }
  const cd = Buffer.concat(central)
  const end = Buffer.alloc(22)
  end.writeUInt32LE(0x06054b50, 0)
  end.writeUInt16LE(zip.entries.length, 8)
  end.writeUInt16LE(zip.entries.length, 10)
  end.writeUInt32LE(cd.length, 12)
  end.writeUInt32LE(offset, 16)
  end.writeUInt16LE(zip.comment.length, 20)
  return Buffer.concat([...parts, cd, end, zip.comment])
}

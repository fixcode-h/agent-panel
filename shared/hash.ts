/**
 * 内容指纹：稳定 JSON + 53 位字符串哈希。
 * 内置工作流的升级判断和角色 / 工作流分享包的校验共用这一份——同一个内容不管字段写入顺序如何都得到同一串，
 * 前后端都能同步算，不依赖 node:crypto。
 */

/** 稳定的 JSON：键按字母排，同样的内容不管字段写入顺序都得到同一串 */
export function stableJson(v: unknown): string {
  if (Array.isArray(v)) return `[${v.map(stableJson).join(',')}]`
  if (v && typeof v === 'object')
    return `{${Object.keys(v)
      .filter((k) => (v as Record<string, unknown>)[k] !== undefined)
      .sort()
      .map((k) => `${JSON.stringify(k)}:${stableJson((v as Record<string, unknown>)[k])}`)
      .join(',')}}`
  return JSON.stringify(v) ?? 'null'
}

/** 53 位的字符串哈希（cyrb53） */
export function hash53(s: string) {
  let h1 = 0xdeadbeef
  let h2 = 0x41c6ce57
  for (let i = 0; i < s.length; i++) {
    const c = s.charCodeAt(i)
    h1 = Math.imul(h1 ^ c, 2654435761)
    h2 = Math.imul(h2 ^ c, 1597334677)
  }
  h1 = Math.imul(h1 ^ (h1 >>> 16), 2246822507) ^ Math.imul(h2 ^ (h2 >>> 13), 3266489909)
  h2 = Math.imul(h2 ^ (h2 >>> 16), 2246822507) ^ Math.imul(h1 ^ (h1 >>> 13), 3266489909)
  return (4294967296 * (2097151 & h2) + (h1 >>> 0)).toString(16)
}

/** 一个值的内容指纹（键的顺序不影响结果） */
export const contentHash = (v: unknown) => hash53(stableJson(v))

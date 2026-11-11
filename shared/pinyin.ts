/**
 * 汉字的拼音首字母（名字搜索用：输 jszl 能找到「角色資料」那样的表）。不带字库：
 * 用浏览器 / Node 自带的中文拼音排序（Intl.Collator zh 拼音序），拿每个声母段的第一个字当分界，
 * 一个字落在哪一段就是哪个字母。多音字取排序用的那个读音，常用字够用；不认识的字原样跳过
 */
const LETTERS = 'ABCDEFGHJKLMNOPQRSTWXYZ'
const BOUNDS = '阿八嚓哒妸发旮哈讥咔垃痳拏噢妑七呥扨它穵夕丫帀'

let collator: Intl.Collator | null | undefined
const cache = new Map<string, string>()

function letterOf(ch: string): string {
  const hit = cache.get(ch)
  if (hit !== undefined) return hit
  if (collator === undefined) {
    try {
      collator = new Intl.Collator('zh-Hans-CN-u-co-pinyin')
      // 环境没有中文排序数据时，比较结果和码位序一样：「八」排不到「阿」后面就当不支持
      if (collator.compare('阿', '八') >= 0 || collator.compare('八', '嚓') >= 0) collator = null
    } catch {
      collator = null
    }
  }
  let out = ''
  if (collator)
    for (let i = BOUNDS.length - 1; i >= 0; i--)
      if (collator.compare(BOUNDS[i], ch) <= 0) {
        out = LETTERS[i].toLowerCase()
        break
      }
  cache.set(ch, out)
  return out
}

const CJK = /[㐀-鿿]/

/** 每个汉字换成拼音首字母，别的字符（字母、数字、符号）原样保留，全部小写 */
export function pinyinInitials(s: string): string {
  if (!CJK.test(s)) return s.toLowerCase()
  let out = ''
  for (const ch of s) out += CJK.test(ch) ? letterOf(ch) : ch.toLowerCase()
  return out
}

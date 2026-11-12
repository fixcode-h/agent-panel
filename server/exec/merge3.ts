/**
 * 三方合并一个文件（不依赖 git）：P4 / SVN 项目的 cherry-pick 也要合并，以前借 git merge-file，
 * 项目根本不是 Git 时照样调 git，二进制文件（.uasset 等）直接报「git merge-file 出错」（2026-11-12 用户反馈）。
 * 这里按行做 diff3：两边都和基准一样的行原样保留，只有一边改了的取改了的那边，两边改法不同才算冲突，
 * 冲突写成 git 同样的标记（<<<<<<< / ======= / >>>>>>>），用户看着熟悉。
 * 内容按字节处理（latin1 一字节一个字符），编码、换行符、结尾有没有换行都原样保留
 */

export type Merge3 =
  | { kind: 'clean'; out: Buffer }
  | { kind: 'conflict'; out: Buffer; conflicts: number }
  /** 二进制文件且两边都改过：没法按行合，交给调用方说明 */
  | { kind: 'binary' }

/** 和 git 一样只看开头 8000 字节里有没有 NUL */
export const isBinary = (b: Buffer) => b.subarray(0, 8000).includes(0)

/** 按行切开，每行带着自己的换行符；最后一行可能没有 */
function lines(b: Buffer): string[] {
  const s = b.toString('latin1')
  const out: string[] = []
  let at = 0
  for (let i = s.indexOf('\n'); i !== -1; i = s.indexOf('\n', at)) {
    out.push(s.slice(at, i + 1))
    at = i + 1
  }
  if (at < s.length) out.push(s.slice(at))
  return out
}

/**
 * Myers 差分：返回 a[i] 和 b[j] 对上的行（i、j 都递增）。
 * 先去掉两头相同的部分，中间只保存每一步用到的那段 V（总量是改动数的平方，不按文件长度算）
 */
function matches(a: string[], b: string[]): [number, number][] {
  let pre = 0
  while (pre < a.length && pre < b.length && a[pre] === b[pre]) pre++
  let suf = 0
  while (suf < a.length - pre && suf < b.length - pre && a[a.length - 1 - suf] === b[b.length - 1 - suf]) suf++
  const head: [number, number][] = Array.from({ length: pre }, (_, i) => [i, i])
  const tail: [number, number][] = Array.from({ length: suf }, (_, i) => [a.length - suf + i, b.length - suf + i])
  const A = a.slice(pre, a.length - suf)
  const B = b.slice(pre, b.length - suf)
  const n = A.length
  const m = B.length
  if (!n || !m) return [...head, ...tail]
  const max = n + m
  // trace[d] 存第 d 步结束时 k ∈ [-d, d] 的最远 x（下标 k + d）
  const trace: Int32Array[] = []
  let v = new Int32Array(3)
  v[1] = 0
  let found = -1
  for (let d = 0; d <= max && found < 0; d++) {
    const cur = new Int32Array(2 * d + 1)
    const get = (k: number) => (k < -(d - 1) || k > d - 1 ? -1 : v[k + d - 1])
    for (let k = -d; k <= d; k += 2) {
      let x = d === 0 ? 0 : k === -d || (k !== d && get(k - 1) < get(k + 1)) ? get(k + 1) : get(k - 1) + 1
      let y = x - k
      while (x < n && y < m && A[x] === B[y]) {
        x++
        y++
      }
      cur[k + d] = x
      if (x >= n && y >= m) found = d
    }
    trace.push(cur)
    v = cur
  }
  // 从终点往回走，收集对角线上的行
  const mid: [number, number][] = []
  let x = n
  let y = m
  for (let d = found; d > 0; d--) {
    const prev = trace[d - 1]
    const k = x - y
    const at = (kk: number) => (kk < -(d - 1) || kk > d - 1 ? -1 : prev[kk + d - 1])
    const down = k === -d || (k !== d && at(k - 1) < at(k + 1))
    const pk = down ? k + 1 : k - 1
    const px = at(pk)
    const py = px - pk
    const sx = down ? px : px + 1
    while (x > sx && y > sx - k) {
      x--
      y--
      mid.push([x + pre, y + pre])
    }
    x = px
    y = py
  }
  while (x > 0 && y > 0) {
    x--
    y--
    mid.push([x + pre, y + pre])
  }
  mid.reverse()
  return [...head, ...mid, ...tail]
}

/** base 每一行在另一边对上的行号，没对上是 -1 */
function mapOf(base: string[], other: string[]) {
  const map = new Int32Array(base.length).fill(-1)
  for (const [i, j] of matches(base, other)) map[i] = j
  return map
}

const eq = (x: string[], y: string[]) => x.length === y.length && x.every((l, i) => l === y[i])

/**
 * 把 base → mine 的改动合进 target。target、mine 都相对 base 改过的同一段算冲突，
 * 两边改成一样的不算。labels 是冲突标记上的名字（目标在上、这次的改动在下）
 */
export function merge3(
  target: Buffer,
  base: Buffer,
  mine: Buffer,
  labels: { target: string; mine: string } = { target: 'target', mine: 'mine' },
): Merge3 {
  if (target.equals(base)) return { kind: 'clean', out: mine }
  if (mine.equals(base) || mine.equals(target)) return { kind: 'clean', out: target }
  if (isBinary(target) || isBinary(base) || isBinary(mine)) return { kind: 'binary' }
  const O = lines(base)
  const T = lines(target)
  const M = lines(mine)
  const mt = mapOf(O, T)
  const mm = mapOf(O, M)
  // 冲突标记用目标文件的换行风格
  const nl = target.includes('\r\n') ? '\r\n' : '\n'
  const out: string[] = []
  let conflicts = 0
  /** 冲突块里一边的最后一行没有换行时补上，不然标记会接在同一行 */
  const block = (xs: string[]) => {
    out.push(...xs)
    const last = xs.at(-1)
    if (last !== undefined && !last.endsWith('\n')) out.push(nl)
  }
  const chunk = (o: string[], t: string[], m: string[]) => {
    if (eq(t, o)) return void out.push(...m)
    if (eq(m, o) || eq(t, m)) return void out.push(...t)
    // 两边开头、结尾一样的行不算冲突，冲突块收到真正不同的那几行
    let s = 0
    while (s < t.length && s < m.length && t[s] === m[s]) s++
    let e = 0
    while (e < t.length - s && e < m.length - s && t[t.length - 1 - e] === m[m.length - 1 - e]) e++
    out.push(...t.slice(0, s))
    out.push(`<<<<<<< ${labels.target}${nl}`)
    block(t.slice(s, t.length - e))
    out.push(`=======${nl}`)
    block(m.slice(s, m.length - e))
    out.push(`>>>>>>> ${labels.mine}${nl}`)
    out.push(...t.slice(t.length - e))
    conflicts++
  }
  let o = 0
  let t = 0
  let m = 0
  while (o < O.length || t < T.length || m < M.length) {
    // 基准这一行两边都原样对上：稳定行
    if (o < O.length && mt[o] === t && mm[o] === m) {
      out.push(T[t])
      o++
      t++
      m++
      continue
    }
    // 找下一行两边都对上的基准行，中间是一段有改动的块
    let j = o
    while (j < O.length && (mt[j] < 0 || mm[j] < 0)) j++
    const tEnd = j < O.length ? mt[j] : T.length
    const mEnd = j < O.length ? mm[j] : M.length
    chunk(O.slice(o, j), T.slice(t, tEnd), M.slice(m, mEnd))
    o = j
    t = tEnd
    m = mEnd
  }
  const buf = Buffer.from(out.join(''), 'latin1')
  return conflicts ? { kind: 'conflict', out: buf, conflicts } : { kind: 'clean', out: buf }
}

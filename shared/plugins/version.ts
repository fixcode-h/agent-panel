/**
 * 插件版本比较：插件版本按 semver 写，常带预发布后缀（3.1.0-alpha.1），
 * 面板自己的 compareVersions（shared/version.ts）只认 -dev，不能拿来比插件。
 * 规则同 semver：先比主、次、修订号，相同时正式版比预发布版新，预发布段逐段比（数字按大小，其他按字典序）。
 */
function parse(v: string) {
  const m = /^v?(\d+)\.(\d+)\.(\d+)(?:-([0-9A-Za-z.-]+))?(?:\+.*)?$/.exec(v.trim())
  return m ? { nums: [Number(m[1]), Number(m[2]), Number(m[3])], pre: m[4] ? m[4].split('.') : [] } : null
}

/** a 比 b 新返回正数，旧返回负数；相同或认不出版本号时返回 0（认不出就不提示更新） */
export function comparePluginVersions(a: string, b: string) {
  const x = parse(a)
  const y = parse(b)
  if (!x || !y) return 0
  for (let i = 0; i < 3; i++) if (x.nums[i] !== y.nums[i]) return x.nums[i] - y.nums[i]
  if (!x.pre.length || !y.pre.length) return Number(!x.pre.length) - Number(!y.pre.length)
  for (let i = 0; i < Math.max(x.pre.length, y.pre.length); i++) {
    const p = x.pre[i]
    const q = y.pre[i]
    if (p === undefined) return -1
    if (q === undefined) return 1
    if (p === q) continue
    const pn = /^\d+$/.test(p)
    const qn = /^\d+$/.test(q)
    if (pn && qn) return Number(p) - Number(q)
    if (pn !== qn) return pn ? -1 : 1
    return p < q ? -1 : 1
  }
  return 0
}

/** 市场或仓库里的版本比装着的新 */
export const isNewerPlugin = (latest: string, current: string) => comparePluginVersions(latest, current) > 0

/** 一个可以升级的插件：去哪儿装新版本（交给 /plugins/install/github 预览） */
export interface PluginUpdate {
  id: string
  current: string
  latest: string
  install: { repo: string; id?: string; ref?: string; path?: string }
}

/**
 * 给 npm 子进程（安装 / 更新 / 卸载 CLI、查最新版本）准备环境变量，主要是代理。
 *
 * 为什么要单独做：面板自己访问外网走 netFetch，按「设置里的代理 → 环境变量 → 系统代理 → 直连」选路；
 * 但 npm 是子进程，只认自己的 .npmrc 和 HTTPS_PROXY / HTTP_PROXY 环境变量，
 * 不读 Windows / macOS 的系统代理，更不知道面板设置里填的代理。于是用户开着 Clash 的系统代理、
 * 或者在面板里填了代理，npm 仍然直连 registry.npmjs.org：国内每个请求 2 秒上下，
 * Claude Code 这种带一串平台包的，光查元数据就要十几个请求（2026-11-04 用户反馈安装很慢）。
 *
 * 做法：按面板同一套顺序算出代理，设置或系统代理给出的地址写进 HTTPS_PROXY / HTTP_PROXY 交给 npm。
 * 用户在 .npmrc 里自己配的 proxy / https-proxy 优先级比环境变量高，照样生效，这里不覆盖。
 */
import { homedir } from 'node:os'
import { capture, childEnv } from './exec/process.ts'
import { NPM } from './cli-source.ts'
import { defaultPlan, ENV_PROXY, probeProxy, type ProxyPlan } from './net.ts'
import { t } from '../shared/i18n.ts'

export const NPMJS = 'https://registry.npmjs.org/'

/** npm config get registry 的结果缓存 5 分钟：每次安装都起一个 npm 进程只为读配置不值得 */
let registryCache: { at: number; url: string } | undefined
const REGISTRY_TTL = 5 * 60_000

async function npmRegistry() {
  if (registryCache && Date.now() - registryCache.at < REGISTRY_TTL) return registryCache.url
  const r = await capture(NPM, ['config', 'get', 'registry'], homedir(), childEnv([]), 10_000)
  const out = r.stdout.trim().split('\n').at(-1)?.trim() ?? ''
  const url = r.code === 0 && /^https?:\/\//i.test(out) ? out : NPMJS
  registryCache = { at: Date.now(), url }
  return url
}

export interface NpmEnv {
  env: NodeJS.ProcessEnv
  /** 写进安装输出的一行说明：走了哪个代理、或者代理连不上改成直连。直连且没什么可说时为空 */
  note?: string
}

/**
 * 纯函数：按选路结果拼出 npm 的环境变量。
 * - 直连、或代理本来就来自环境变量（npm 自己会读）：原样不动
 * - 设置里的代理 / 系统代理：写进 HTTPS_PROXY 和 HTTP_PROXY；探测确认连不上时不写，并说明改成直连
 */
export function npmProxyEnv(base: NodeJS.ProcessEnv, plan: ProxyPlan, registry: string, alive: boolean): NpmEnv {
  if (plan.kind === 'direct') return { env: base }
  const fromEnv = ENV_PROXY.some((k) => base[k] && base[k] === plan.key)
  if (fromEnv)
    return { env: base, note: t('npm 通过环境变量里的代理 {proxy} 访问 {registry}', { proxy: plan.shown, registry }) }
  if (!alive)
    return {
      env: base,
      note: t('代理 {proxy} 连不上，npm 直连 {registry}', { proxy: plan.shown, registry }),
    }
  const env: NodeJS.ProcessEnv = { ...base, HTTPS_PROXY: plan.key, HTTP_PROXY: plan.key }
  // 小写的同名变量在有些平台上优先于大写，留着旧值会让上面的设置不生效
  delete env.https_proxy
  delete env.http_proxy
  return {
    env,
    note: plan.system
      ? t('npm 通过系统代理 {proxy} 访问 {registry}', { proxy: plan.shown, registry })
      : t('npm 通过设置里的代理 {proxy} 访问 {registry}', { proxy: plan.shown, registry }),
  }
}

/** 给 npm 用的环境变量；每次安装都重新算，用户刚改了代理设置或刚开代理软件也能用上 */
export async function npmEnv(): Promise<NpmEnv> {
  const base = childEnv([])
  const registry = await npmRegistry()
  const plan = await defaultPlan(registry)
  let alive = true
  if (plan.kind === 'proxy' && /^https?:\/\//i.test(plan.key)) {
    // 系统代理开关还开着、代理软件却关了时，把它交给 npm 只会换来 ECONNREFUSED；先握一次手确认
    alive = await probeProxy(plan.key, 2000, new URL(registry).hostname)
  }
  return npmProxyEnv(base, plan, registry, alive)
}

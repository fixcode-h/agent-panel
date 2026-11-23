/**
 * 按本机的项目根核对模块文档里的「源码」路径（ADR 0048）。
 * 模块文档要写相对项目根的路径：P4 共用文档时各人的工作区根不同，写成绝对路径在别人机器上一定「找不到」。
 * 老文档里已经写了绝对路径、带了「:行号」的，这里尽量认出它在本机对应哪个相对路径，别把还在的模块误判成删了；
 * 认出来的写法交回给「文档」改掉（server/module-map.ts 的 goneModulesNote），面板不直接改用户的文档
 * （P4 下文档没 checkout 是只读的，静默改写也会给每个人留一份没人提交的改动）。
 */
import { existsSync } from 'node:fs'
import path from 'node:path'
import { isAbsoluteSource, relativeCandidates, sourcePathOf } from '../../shared/module-docs.ts'

export interface SourceCheck {
  /** 文档里的原写法 */
  raw: string
  /** 相对项目根的路径（/ 分隔）；绝对路径对不上本机任何位置时为空串 */
  rel: string
  /** 本机项目里有这个路径 */
  exists: boolean
  /** 文档里写的是绝对路径 */
  absolute: boolean
}

/** 通配符后面的部分不拿去查文件：`src/*.ts` 按 `src/` 算 */
const withoutGlob = (p: string) => p.replace(/\*+.*$/, '')

export function checkSource(projectPath: string, raw: string): SourceCheck {
  const p = sourcePathOf(raw)
  const has = (rel: string) => existsSync(path.join(projectPath, withoutGlob(rel)))
  if (!isAbsoluteSource(p)) return { raw, rel: p, exists: !!p && has(p), absolute: false }
  const rel = relativeCandidates(p, projectPath).find((c) => has(c)) ?? ''
  return { raw, rel, exists: !!rel, absolute: true }
}

/** 一个模块的源码项都核对一遍 */
export const checkSources = (projectPath: string, sources: string[]) => sources.map((s) => checkSource(projectPath, s))

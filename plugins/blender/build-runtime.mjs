// 把随插件带来的 dsh-blender-plugin 运行时（plugins/blender/dsh/runtime/**/*.ts）逐个转成 JS，
// 放到 plugins/blender/dsh/lib/runtime/，和上游 `npm run build:runtime` 的产物布局一致：
// Gateway 是单独的 Node 子进程（lib/runtime/gateway.js），运行时还会按 lib/runtime/engine.js、
// lib/runtime/ext/*.js 这些路径起探针子进程，所以不能打成一个文件，只做逐文件转译（不改 import 写法）。
// Python 资产留在 runtime/py/ 原处，运行时按「lib/runtime 的上两级 + runtime/」找到它们。
//
// 开发时服务端第一次启动 Gateway 前调用（源码比产物新才重转）；出包时 scripts/package.mjs 调用。
import { existsSync, mkdirSync, readdirSync, statSync } from 'node:fs'
import path from 'node:path'
import { fileURLToPath } from 'node:url'

export const DSH_ROOT = path.join(path.dirname(fileURLToPath(import.meta.url)), 'dsh')
const SRC = path.join(DSH_ROOT, 'runtime')
export const RUNTIME_OUT = path.join(DSH_ROOT, 'lib', 'runtime')

function walk(dir, out = []) {
  for (const e of readdirSync(dir, { withFileTypes: true })) {
    const f = path.join(dir, e.name)
    if (e.isDirectory()) walk(f, out)
    else if (/\.ts$/.test(e.name) && !/\.d\.ts$/.test(e.name)) out.push(f)
  }
  return out
}

/** 产物缺了或比源码旧：要重转 */
export function runtimeStale(outDir = RUNTIME_OUT) {
  const entry = path.join(outDir, 'gateway.js')
  if (!existsSync(entry)) return true
  const built = statSync(entry).mtimeMs
  return walk(SRC).some((f) => statSync(f).mtimeMs > built)
}

/** 逐文件转译到 outDir（默认插件目录下的 lib/runtime），返回转了多少个文件 */
export async function buildRuntime(outDir = RUNTIME_OUT) {
  const { build } = await import('esbuild')
  const files = walk(SRC)
  mkdirSync(outDir, { recursive: true })
  await build({
    entryPoints: files,
    outdir: outDir,
    outbase: SRC,
    bundle: false,
    platform: 'node',
    format: 'esm',
    target: 'node22',
    logLevel: 'silent',
  })
  return files.length
}

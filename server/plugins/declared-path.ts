import path from 'node:path'

/** 把插件包里的目录前置到环境里的 PATH（插件接口 11 的 env.PATH.prepend）；Windows 上变量名可能是 Path */
export function prependPath(env: NodeJS.ProcessEnv, dirs: string[]) {
  if (!dirs.length) return env
  const key = Object.keys(env).find((k) => k.toUpperCase() === 'PATH') ?? 'PATH'
  env[key] = [...dirs, env[key] ?? ''].filter(Boolean).join(path.delimiter)
  return env
}

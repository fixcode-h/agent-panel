import { execFile } from 'node:child_process'
import { CLIS } from '../shared/clis.ts'
import type { CliStatus } from '../shared/schema.ts'

const TTL = 30_000
let cached: { at: number; data: CliStatus[] } | null = null

function version(command: string, args: string[]): Promise<string | null> {
  return new Promise((resolve) => {
    execFile(
      command,
      args,
      { timeout: 5000, shell: process.platform === 'win32', windowsHide: true },
      (err, stdout, stderr) => {
        if (err) return resolve(null)
        resolve((stdout || stderr).trim().split('\n')[0] ?? '')
      },
    )
  })
}

/** 检测每个 CLI 是否装在本机（结果缓存 30 秒） */
export async function detectClis(force = false): Promise<CliStatus[]> {
  if (!force && cached && Date.now() - cached.at < TTL) return cached.data
  const data = await Promise.all(
    CLIS.map(async (c) => {
      const v = await version(c.command, c.versionArgs)
      return {
        id: c.id,
        name: c.name,
        command: c.command,
        installed: v !== null,
        version: v ?? undefined,
        models: c.models,
        docsUrl: c.docsUrl,
      }
    }),
  )
  cached = { at: Date.now(), data }
  return data
}

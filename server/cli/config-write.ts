import { chmod, mkdir, writeFile } from 'node:fs/promises'
import path from 'node:path'
import { writeJsonAtomic } from '../store.ts'

/**
 * 写 CLI 自己的配置文件（~/.claude/settings.json、~/.claude.json、~/.codex/config.toml、Pi 的 models.json 等）。
 * 这些文件里常有 API key、令牌：以前按默认权限写成 644，同机其他用户能读（真实 API 实测报告问题 19）。
 * 统一收到 600：原子写的临时文件新建时就是 600，rename 之后保留；就地覆盖已有文件时 writeFile 的 mode
 * 不生效，所以再 chmod 一次。Windows 没有这套权限位，跳过 chmod。
 */
export const CLI_CONFIG_MODE = 0o600

export async function writeCliConfigJson(file: string, data: unknown) {
  await writeJsonAtomic(file, data, false, CLI_CONFIG_MODE)
}

export async function writeCliConfigText(file: string, text: string) {
  await mkdir(path.dirname(file), { recursive: true })
  await writeFile(file, text, { encoding: 'utf8', mode: CLI_CONFIG_MODE })
  if (process.platform !== 'win32') await chmod(file, CLI_CONFIG_MODE).catch(() => {})
}

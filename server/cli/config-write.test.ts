import test from 'node:test'
import assert from 'node:assert/strict'
import { mkdtempSync, readFileSync, rmSync, statSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import path from 'node:path'
import { writeCliConfigJson, writeCliConfigText } from './config-write.ts'

// Windows 没有 Unix 权限位，只验证内容
const posix = process.platform !== 'win32'
const modeOf = (f: string) => statSync(f).mode & 0o777

test('写 CLI 配置：新建的 JSON / 文本文件是 600', async () => {
  const dir = mkdtempSync(path.join(tmpdir(), 'cli-config-'))
  try {
    const json = path.join(dir, '.claude', 'settings.json')
    await writeCliConfigJson(json, { env: { ANTHROPIC_API_KEY: 'sk-xxxx' } })
    assert.deepEqual(JSON.parse(readFileSync(json, 'utf8')), { env: { ANTHROPIC_API_KEY: 'sk-xxxx' } })
    const toml = path.join(dir, '.codex', 'config.toml')
    await writeCliConfigText(toml, 'model = "x"\n')
    assert.equal(readFileSync(toml, 'utf8'), 'model = "x"\n')
    if (posix) {
      assert.equal(modeOf(json), 0o600)
      assert.equal(modeOf(toml), 0o600)
    }
  } finally {
    rmSync(dir, { recursive: true, force: true })
  }
})

test('写 CLI 配置：覆盖已有的 644 文件后收到 600', async () => {
  const dir = mkdtempSync(path.join(tmpdir(), 'cli-config-'))
  try {
    const json = path.join(dir, 'settings.json')
    const env = path.join(dir, '.env')
    writeFileSync(json, '{}', { mode: 0o644 })
    writeFileSync(env, 'A=1\n', { mode: 0o644 })
    await writeCliConfigJson(json, { a: 1 })
    await writeCliConfigText(env, 'A=2\n')
    assert.equal(readFileSync(env, 'utf8'), 'A=2\n')
    if (posix) {
      assert.equal(modeOf(json), 0o600)
      assert.equal(modeOf(env), 0o600)
    }
  } finally {
    rmSync(dir, { recursive: true, force: true })
  }
})

// 防回退：写 CLI 自己配置文件的地方都要走上面两个函数，直接 writeFile / writeJsonAtomic 会写成 644
test('写 CLI 配置：accounts / mcp-store 不直接写 CLI 的配置文件', () => {
  for (const f of ['accounts.ts', 'mcp-store.ts']) {
    const src = readFileSync(path.join(import.meta.dirname, f), 'utf8')
    assert.doesNotMatch(src, /writeJsonAtomic\(file,|writeFile\(file, (next|writeToml)/, f)
  }
})

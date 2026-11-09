import assert from 'node:assert/strict'
import { test } from 'node:test'
import { chmod, mkdtemp, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import path from 'node:path'
import { enableUrlOf, tailscaleStart } from './tailscale.ts'
import { Settings } from '../shared/schema.ts'

// tailnet 没开 Serve 时 tailscale serve 的原样输出（enableFeatureInteractive）：打完链接后不退出，一直等用户去开
const NOT_ENABLED = `
Serve is not enabled on your tailnet.
To enable, visit:

         https://login.tailscale.com/f/serve?node=naPzWqzMia11CNTRL
`

test('从 tailscale 的输出里取出开启 Serve / Funnel 的链接', () => {
  const lines = NOT_ENABLED.split('\n')
  assert.deepEqual(lines.map(enableUrlOf).filter(Boolean), [
    'https://login.tailscale.com/f/serve?node=naPzWqzMia11CNTRL',
  ])
  assert.equal(enableUrlOf('Available within your tailnet: https://hqm.tailc04df3.ts.net/'), '')
})

/**
 * 假的 tailscale：serve 打出开启链接后一直等到「开好」标记文件出现再退出 0，和真的 tailscale 一样；
 * 其他子命令（funnel off）直接退出
 */
async function fakeTailscale() {
  const dir = await mkdtemp(path.join(tmpdir(), 'ts-fake-'))
  const bin = path.join(dir, 'tailscale')
  const flag = path.join(dir, 'enabled')
  await writeFile(
    bin,
    `#!/bin/sh
[ "$1" = serve ] || exit 0
cat <<'END'
${NOT_ENABLED}
END
while [ ! -f ${JSON.stringify(flag)} ]; do sleep 0.1; done
echo 'Available within your tailnet:'
exit 0
`,
  )
  await chmod(bin, 0o755)
  return { dir, bin, flag }
}

const cfg = Settings.parse({}).remoteAccess.tailscale

test(
  'tailnet 没开 Serve：先交出链接、不按超时杀掉，用户开好后命令自己配完',
  { skip: process.platform === 'win32' },
  async () => {
    const f = await fakeTailscale()
    try {
      let link = ''
      let settled = false
      const ac = new AbortController()
      const p = tailscaleStart(f.bin, cfg, 9999, { signal: ac.signal, onNeedEnable: (u) => (link = u) }).finally(
        () => (settled = true),
      )
      for (let i = 0; i < 50 && !link; i++) await new Promise((r) => setTimeout(r, 100))
      assert.equal(link, 'https://login.tailscale.com/f/serve?node=naPzWqzMia11CNTRL')
      assert.equal(settled, false, '还在等用户去开启，不能当成失败结束')
      await writeFile(f.flag, '')
      await p
    } finally {
      // 断言失败时也让假 tailscale 退出，不然测试进程一直等着它
      await writeFile(f.flag, '').catch(() => {})
      await rm(f.dir, { recursive: true, force: true })
    }
  },
)

test('等开启时换了设置：停掉等着的那条命令', { skip: process.platform === 'win32' }, async () => {
  const f = await fakeTailscale()
  try {
    const ac = new AbortController()
    const p = tailscaleStart(f.bin, cfg, 9999, { signal: ac.signal, onNeedEnable: () => ac.abort() })
    await assert.rejects(p, /aborted/)
  } finally {
    await rm(f.dir, { recursive: true, force: true })
  }
})

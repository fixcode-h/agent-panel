import assert from 'node:assert/strict'
import test from 'node:test'
import { mkdtemp, mkdir, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import path from 'node:path'
import type { Project } from '../../shared/schema.ts'
import type { HookFacts } from '../../shared/hooks/index.ts'
import { modulePush } from './module-push.ts'

const edit = (file: string, input: Record<string, unknown>): HookFacts => ({
  tool: { kind: 'edit', name: 'Edit', input, path: file, paths: [file] },
})

test('模块入口推送：第一次碰某个模块的文件推它的入口，同一个模块和同一个新函数在一个对话里只推一次', async () => {
  const dir = await mkdtemp(path.join(tmpdir(), 'module-push-'))
  try {
    await mkdir(path.join(dir, 'docs/modules/home'), { recursive: true })
    await writeFile(
      path.join(dir, 'docs/modules/home/README.md'),
      '# home：家园\n\n- 状态：documented\n- 职责：家园摆件\n- 源码：`Source/Game/Home/`\n- 入口：`UHomeLib::GetDecorationActorTopLocation`\n',
    )
    const push = modulePush({
      taskId: 'module-push-t1',
      project: { id: 'p', path: dir } as Project,
      agents: [],
      cwd: dir,
    })
    const first = await push.before(
      edit(path.join(dir, 'Source/Game/Home/Public/Title.h'), { new_string: 'GAME_API FVector GetTopLocation();' }),
    )
    assert.match(first, /属于模块「home」/)
    assert.match(first, /GetDecorationActorTopLocation/)
    assert.match(first, /新增公开函数 `GetTopLocation`/)
    const again = await push.before(
      edit(path.join(dir, 'Source/Game/Home/Private/Title.cpp'), { new_string: 'GAME_API FVector GetTopLocation();' }),
    )
    assert.equal(again, '')
    // 没有模块文档的文件、不是读改文件的工具都不推
    assert.equal(await push.before(edit(path.join(dir, 'Other/a.cpp'), { new_string: 'int x;' })), '')
    assert.equal(
      await push.before({ tool: { kind: 'shell', name: 'Bash', input: { command: 'ls' }, path: '', paths: [] } }),
      '',
    )
  } finally {
    await rm(dir, { recursive: true, force: true })
  }
})

import assert from 'node:assert/strict'
import { execFileSync } from 'node:child_process'
import { mkdirSync, mkdtempSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import path from 'node:path'
import test from 'node:test'
import { placedFiles } from '../attachments.ts'
import { gitNumstat, reviewDiff } from './git.ts'

const git = (cwd: string, ...args: string[]) =>
  execFileSync('git', ['-c', 'user.name=t', '-c', 'user.email=t@t', ...args], { cwd, stdio: 'pipe' }).toString()

function repo() {
  const dir = mkdtempSync(path.join(tmpdir(), 'ap-git-ignore-'))
  git(dir, 'init', '-q')
  writeFileSync(path.join(dir, 'a.ts'), 'export const a = 1\n')
  git(dir, 'add', '-A')
  git(dir, 'commit', '-qm', 'init')
  return { dir, base: git(dir, 'rev-parse', 'HEAD').trim() }
}

test('面板拷进对话目录的图片不算任务的改动：更改列表和评审差异都排除，旧任务按消息里的名字同样排除', async () => {
  const { dir, base } = repo()
  writeFileSync(path.join(dir, '截图.png'), 'png')
  writeFileSync(path.join(dir, 'b.ts'), 'export const b = 2\n')
  mkdirSync(path.join(dir, 'attachments'))
  writeFileSync(path.join(dir, 'attachments', '旧.png'), 'png')

  const all = (await gitNumstat(dir, base))!
  assert.ok('截图.png' in all, '不传名单时它就是未跟踪文件')
  assert.ok('attachments/旧.png' in all, '旧消息里记的那份不传名单时也在改动里')

  const skip = (await gitNumstat(dir, base, ['截图.png']))!
  assert.ok(!('截图.png' in skip), '按任务记的名单排除')
  assert.ok('b.ts' in skip, '别的文件照常统计')

  const reviewed = (await reviewDiff(dir, base))!
  assert.match(reviewed.stat, /截图\.png/, '不传名单时评审也看得到')
  const own = (await reviewDiff(dir, base, '', undefined, ['截图.png']))!
  assert.doesNotMatch(own.stat, /截图\.png/, '评审差异里排除')
  assert.match(own.stat, /b\.ts/, '真实改动照旧交给评审')

  // 排除名单只认对话目录里的相对路径：绝对路径、带 .. 的都不算
  assert.ok('b.ts' in (await gitNumstat(dir, base, [path.join(dir, 'b.ts'), '../b.ts']))!)

  // 旧任务没有 placedAttachments：从消息里的 attachments/名字 推出的名单同样被排除
  const task = {
    placedAttachments: {},
    messages: [
      {
        role: 'user',
        text: '',
        attachments: [{ name: '旧.png', path: 'attachments/旧.png', size: 1, mime: 'image/png' }],
      },
    ],
  }

  const legacy = (await gitNumstat(dir, base, placedFiles(task as never)))!
  assert.ok(!('attachments/旧.png' in legacy), '旧消息里记的那份也被排除（不传名单时它在改动里，见上面的 all）')
})

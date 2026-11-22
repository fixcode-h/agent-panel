import { test } from 'node:test'
import assert from 'node:assert/strict'
import { AUTO_SOURCE, downloadCandidates, normalizeGithubInput, pickCandidates } from './gh-download.ts'

test('加速下载：各种 GitHub 地址整理成下载地址，按来源列出加速地址，别的网站拒绝', () => {
  const blob = normalizeGithubInput('github.com/o/r/blob/main/dir/a.txt')
  assert.deepEqual(blob, { url: 'https://raw.githubusercontent.com/o/r/main/dir/a.txt', name: 'a.txt' })
  assert.deepEqual(normalizeGithubInput('https://github.com/o/r.git'), {
    url: 'https://github.com/o/r/archive/HEAD.zip',
    name: 'r-HEAD.zip',
  })
  assert.deepEqual(normalizeGithubInput('http://github.com/o/r/tree/feat/x'), {
    url: 'https://github.com/o/r/archive/feat/x.zip',
    name: 'r-feat-x.zip',
  })
  const rel = 'https://github.com/o/r/releases/download/v1/app%20x.zip'
  assert.deepEqual(normalizeGithubInput(rel), { url: rel, name: 'app x.zip' })
  assert.ok('error' in normalizeGithubInput('https://gitlab.com/o/r'))
  assert.ok('error' in normalizeGithubInput('https://github.com/o/r/issues/1'))

  // Release 附件只能走镜像：原地址 + 预置的 gh-proxy；关着的也列出来（界面上能点名用），自动只用打开的
  const list = downloadCandidates(rel, [{ id: 'mirror', enabled: false, prefix: 'https://v6.gh-proxy.org/' }])
  assert.deepEqual(
    list.map((c) => `${c.key}|${c.url}|${c.enabled}`),
    // 存过的顺序优先：gh-proxy 那一项存在最前面
    [`mirror:https://v6.gh-proxy.org/|https://v6.gh-proxy.org/${rel}|false`, `origin|${rel}|true`],
  )
  assert.deepEqual(
    pickCandidates(list, AUTO_SOURCE).map((c) => c.key),
    ['origin'],
  )
  assert.equal(pickCandidates(list, 'mirror:https://v6.gh-proxy.org/').length, 1)
  // 仓库文件不列「GitHub 网页」：那是从网页里抠文本，不适合下载文件
  assert.ok(!downloadCandidates(blob && 'url' in blob ? blob.url : '', []).some((c) => c.key === 'web'))
})

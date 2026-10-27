/**
 * 分层判据的单测样例：一段段「测试文件源码」的文本，只用来喂给 layerOf。
 * 单独放在这里而不是写进 test-layers.test.mjs 里，是因为静态判据按源码文本匹配——
 * 样例里出现的 `spawn(`、`mkdtempSync(` 一类字样，会让那个测试文件自己被判成集成层。
 */
export const LAYER_SAMPLES = {
  /** 起 Hono 应用并监听端口 */
  httpServer: [
    "import { Hono } from 'hono'",
    'const app = new Hono()',
    'const server = app.listen(0)',
    "test('接口返回任务列表', () => {})",
  ].join('\n'),
  /** 建临时目录并往里写文件 */
  tempDir: [
    "import { mkdtempSync, writeFileSync } from 'node:fs'",
    "const dir = mkdtempSync(path.join(os.tmpdir(), 'case-'))",
    "writeFileSync(path.join(dir, 'a.json'), '{}')",
  ].join('\n'),
  /** 跑 git 命令并开子进程 */
  gitAndChild: [
    "import { execFileSync, spawn } from 'node:child_process'",
    "execFileSync('git', ['status'], { cwd: dir })",
    "spawn(process.execPath, ['scripts/fake-cli.mjs'])",
  ].join('\n'),
  /** 用 fs/promises 读写临时文件：不带 Sync 后缀，同样是集成层 */
  asyncFs: [
    "import { readFile, rm } from 'node:fs/promises'",
    'const { dir, file } = await writeSystemPrompt(role)',
    "assert.equal(await readFile(file, 'utf8'), role)",
    'await rm(dir, { recursive: true, force: true })',
  ].join('\n'),
  /** 只做内存计算的纯逻辑测试；`RegExp.exec` 不算开子进程，字符串里的 'git' 不算执行 git */
  pureLogic: [
    "import test from 'node:test'",
    "import { layerOf } from './test-layers.mjs'",
    "test('解析描述', () => {",
    '  const hit = /Description:\\n\\t(.*)\\n/.exec(input)',
    '  assert.equal(hit?.[1], expected)',
    "  const labels = ['git', 'child-process']",
    '  assert.deepEqual(labels, [])',
    '})',
  ].join('\n'),
}

// 生成 skills/coding/systematic-debugging/ 的 SKILL.md（入口）和 full-flow.md（完整流程）：正文来自 shared/builtin/bug-method.ts 的
// debugSkillMd()、debugSkillFullMd()（ADR 0046，方法只写一处；ADR 0083 入口不超过 8000 字，完整流程放子文件）。
// 改了方法就跑一次：node scripts/gen-debug-skill.mjs。--check 只核对不写（shared/builtin/bug-method.test.ts 也会核对）
import { readFile, writeFile } from 'node:fs/promises'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import { tsImport } from 'tsx/esm/api'
import { format, resolveConfig } from 'prettier'

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..')
const dir = path.join(root, 'skills/coding/systematic-debugging')
const { debugSkillMd, debugSkillFullMd } = await tsImport('../shared/builtin/bug-method.ts', import.meta.url)
const check = process.argv.includes('--check')
let bad = false
for (const [name, make] of [
  ['SKILL.md', debugSkillMd],
  ['full-flow.md', debugSkillFullMd],
]) {
  const file = path.join(dir, name)
  // Prettier 配置在 config/ 下（和 npm run lint 同一份），按文件位置找不到它
  const config = await resolveConfig(file, { config: path.join(root, 'config/.prettierrc.json') })
  const text = await format(make(), { ...config, filepath: file })
  const now = await readFile(file, 'utf8').catch(() => '')
  if (now === text) continue
  if (check) {
    console.error(
      `skills/coding/systematic-debugging/${name} 和 shared/builtin/bug-method.ts 对不上：跑 node scripts/gen-debug-skill.mjs 重新生成`,
    )
    bad = true
  } else {
    await writeFile(file, text)
    console.log(`已重新生成 skills/coding/systematic-debugging/${name}`)
  }
}
if (bad) process.exit(1)
if (check) console.log('systematic-debugging 技能和方法一致')

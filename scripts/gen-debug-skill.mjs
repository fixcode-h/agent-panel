// 生成 skills/coding/systematic-debugging/SKILL.md：正文来自 shared/builtin/bug-method.ts 的 debugSkillMd()（ADR 0046，方法只写一处）。
// 改了方法就跑一次：node scripts/gen-debug-skill.mjs。--check 只核对不写（shared/builtin/bug-method.test.ts 也会核对）
import { readFile, writeFile } from 'node:fs/promises'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import { tsImport } from 'tsx/esm/api'
import { format, resolveConfig } from 'prettier'

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..')
const file = path.join(root, 'skills/coding/systematic-debugging/SKILL.md')
const { debugSkillMd } = await tsImport('../shared/builtin/bug-method.ts', import.meta.url)
// Prettier 配置在 config/ 下（和 npm run lint 同一份），按文件位置找不到它
const config = await resolveConfig(file, { config: path.join(root, 'config/.prettierrc.json') })
const text = await format(debugSkillMd(), { ...config, filepath: file })
const now = await readFile(file, 'utf8').catch(() => '')
if (process.argv.includes('--check')) {
  if (now !== text) {
    console.error(
      'skills/coding/systematic-debugging/SKILL.md 和 shared/builtin/bug-method.ts 对不上：跑 node scripts/gen-debug-skill.mjs 重新生成',
    )
    process.exit(1)
  }
  console.log('systematic-debugging 技能和方法一致')
} else if (now === text) console.log('systematic-debugging 技能已是最新')
else {
  await writeFile(file, text)
  console.log('已重新生成 skills/coding/systematic-debugging/SKILL.md')
}

import { test } from 'node:test'
import assert from 'node:assert/strict'
import { withSkillDir } from './skill-guide.ts'

test('「要用的 Skill」一节写明技能装在哪，模型不用自己猜用户目录', () => {
  const role =
    '你是文档。\n\n## 要用的 Skill\n遇到下面的情况时先读对应的 SKILL.md：\n- `project-documentation`：读写项目文档时'
  const out = withSkillDir(role, '/home/me/.agents/skills')
  assert.match(
    out,
    /先读对应的 SKILL\.md：\n这些 Skill 装在 `\/home\/me\/\.agents\/skills`，路径就是 `\/home\/me\/\.agents\/skills\/<名字>\/SKILL\.md`/,
  )
  assert.ok(out.endsWith('- `project-documentation`：读写项目文档时'), '原来的清单保留')
  assert.equal(withSkillDir('没有技能的角色', '/x'), '没有技能的角色')
})

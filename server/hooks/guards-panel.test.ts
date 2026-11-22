import assert from 'node:assert/strict'
import { tmpdir } from 'node:os'
import path from 'node:path'
import test from 'node:test'
import { panelFilesDeny } from './guards-panel.ts'

const roots = { panel: path.join(tmpdir(), 'agent-panel-app'), data: path.join(tmpdir(), 'agent-panel-data') }
const proj = path.join(tmpdir(), 'shop-kit')
const read = (file: string) => ({ tool: { kind: 'read' as const, name: 'Read', input: {}, path: file, paths: [file] } })
const sh = (command: string) => ({
  tool: { kind: 'shell' as const, name: 'Bash', input: { command }, path: '', paths: [] },
})

test('面板文件守卫：别的项目里读面板源码、数据目录的设置和对话记录时拦下（实跑 2026-11-22）', () => {
  const c = { cwd: proj, projectPath: proj }
  assert.match(panelFilesDeny(c, read(path.join(roots.panel, 'server/turn/changes.ts')), roots), /面板的源码/)
  assert.match(panelFilesDeny(c, sh(`rg -n gitChanges ${roots.panel}/server/exec/git.ts`), roots), /面板的源码/)
  assert.match(panelFilesDeny(c, read(path.join(roots.data, 'settings.json')), roots), /设置和对话记录/)
  assert.match(
    panelFilesDeny(c, sh(`node -e "require('${roots.data}/tasks/projects/p/t.json')"`), roots),
    /设置和对话记录/,
  )
  // 给 Agent 用的：独立分支、对话目录、交接文件、Skill，以及项目自己的文件
  assert.equal(panelFilesDeny(c, read(path.join(roots.data, 'worktrees/p/t/src/a.js')), roots), '')
  assert.equal(panelFilesDeny(c, read(path.join(roots.data, 'tasks/handoff/t/x.md')), roots), '')
  assert.equal(panelFilesDeny(c, read(path.join(roots.panel, 'skills/docs/SKILL.md')), roots), '')
  assert.equal(panelFilesDeny(c, read('src/cart.js'), roots), '')
})

test('面板文件守卫：项目就是面板仓库时源码照常读，数据目录照样拦', () => {
  const c = { cwd: roots.panel, projectPath: roots.panel }
  assert.equal(panelFilesDeny(c, read('server/turn/changes.ts'), roots), '')
  assert.equal(panelFilesDeny(c, sh('rg -n gitChanges server/exec/git.ts'), roots), '')
  assert.match(panelFilesDeny(c, read(path.join(roots.data, 'settings.json')), roots), /设置和对话记录/)
})

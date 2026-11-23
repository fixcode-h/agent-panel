import test from 'node:test'
import assert from 'node:assert/strict'
import { openProjectsIn, pickIdeProject, samePath } from './ide-project.ts'

// IDE 源码 McpCallInfo.noSuitableProjectError 的原样格式
const err = (prefix: string, paths: string[]) =>
  `${prefix}\n You may specify the project path via \`projectPath\` parameter when calling a tool. \n` +
  ` If you're aware of the current working directory you may pass it as \`projectPath\`. \n` +
  ` In the case when it's unobvious which project to use you have to ASK the USER about a project providing him a numbered list of the projects.\n` +
  ` Currently open projects: ${JSON.stringify({ projects: paths.map((path) => ({ path })) })}`

test('从 IDE「定不了项目」的报错里取已开项目，别的输出不算', () => {
  const two = ['G:/P4/ws/Project', 'D:/Other']
  assert.deepEqual(
    openProjectsIn(err('Unable to determine the target project for the current MCP tool call.', two)),
    two,
  )
  assert.deepEqual(
    openProjectsIn(err("`projectPath`=`G:/P4/ws` doesn't correspond to any open project.", two) + '\n…(已截断)'),
    two,
  )
  assert.equal(openProjectsIn('{"error":"indexing"}'), undefined)
  // 输出被截断、没带列表：认得出是这类错，列表为空
  assert.deepEqual(
    openProjectsIn('Unable to determine the target project for the current MCP tool call.\n Currently open pro…'),
    [],
  )
})

test('按工作目录挑 IDE 项目：在项目里取最深的，工作目录下只有一个取它，多个或对不上交给用户', () => {
  const open = ['G:\\P4\\ws\\Project', 'G:/P4/ws/Project/Content/Script', 'D:/Other']
  // 工作目录在项目里面：取最深的
  assert.equal(pickIdeProject(open, ['g:/p4/ws/Project/Content/Script/UI']).path, 'G:/P4/ws/Project/Content/Script')
  assert.equal(pickIdeProject(open, ['G:/P4/ws/Project/Source']).path, 'G:\\P4\\ws\\Project')
  // 工作目录是 P4 工作区根，IDE 打开的是下面的 Project：只有一个时取它
  assert.equal(pickIdeProject(['G:/P4/ws/Project', 'D:/Other'], ['G:\\P4\\ws\\']).path, 'G:/P4/ws/Project')
  // 下面有两个：挑不出来，只列这两个
  assert.deepEqual(pickIdeProject(['G:/ws/A', 'G:/ws/B', 'D:/Other'], ['G:/ws']), {
    candidates: ['G:/ws/A', 'G:/ws/B'],
  })
  // 一个都对不上：列全部
  assert.deepEqual(pickIdeProject(['D:/A', 'D:/B'], ['/home/u/x', '']), { candidates: ['D:/A', 'D:/B'] })
  assert.ok(samePath('G:\\P4\\ws\\', 'g:/P4/ws'))
  assert.ok(!samePath('/a/B', '/a/b'))
})

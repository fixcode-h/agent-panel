// 从 demo-backend.ts 拆出来（那个文件到了行数上限）：Chat 页右栏的演示数据，建对话的函数由 demo-backend 传进来
import type { NewTaskInput, Task } from '@shared/schema'

/**
 * Chat 页右栏的演示（Chat.dc.html）：一条带截图的提问，回复里有联网搜索、打开网页和两段代码，
 * 右栏的「代码 / 来源 / 附件」三个页签都有内容；另一条置顶的聊天演示侧栏最上面的「置顶」组
 */
export async function seedChatRail(
  create: (input: NewTaskInput) => { task: Task; done: Promise<unknown> },
  agentId: string,
  back: (t: Task, minutes: number) => void,
  shot: string,
) {
  const make = async (prompt: string) => {
    const { task, done } = create({
      projectId: '',
      mode: 'chat',
      workflowId: '',
      agentId,
      prompt,
      attachments: [],
      cli: '',
      model: '',
      effort: '',
      isolate: false,
      askUser: false,
      params: {},
    })
    await done
    return task
  }
  const pinned = await make('周报写作助手')
  pinned.pinned = true
  back(pinned, 60 * 24 * 3)
  const task = await make('这个报错是因为 use() 用错了吗？顺便讲讲它和 useEffect 取数有什么区别。')
  task.title = 'React 19 的 use() 怎么用'
  const user = task.messages.find((m) => m.role === 'user')
  if (user) user.attachments = [{ name: '报错截图.png', path: shot, size: 48_213, mime: 'image/png' }]
  const reply = task.messages.find((m) => m.role === 'agent')
  if (reply) {
    reply.tools = [
      {
        kind: 'web',
        name: '网页搜索',
        label: 'react.dev use() 文档',
        detail: '',
        output:
          '1. use – React\nhttps://react.dev/reference/react/use\n2. Suspense – React\nhttps://react.dev/reference/react/Suspense\n3. facebook/react issue: use() re-suspends\nhttps://github.com/facebook/react/issues/27877',
        ms: 1800,
      },
      { kind: 'web', name: '打开网页', label: 'https://react.dev/reference/react/use', detail: '', ms: 900 },
    ]
    reply.text = [
      '是的。截图里的 Promise 写在组件里，**每次渲染都会新建一个**，use() 每次都拿到新的 Promise，于是一直挂起、反复重渲染。',
      '',
      '把 Promise 提到组件外面（或者交给父组件 / 缓存）就好：',
      '',
      '```tsx',
      "import { use, Suspense } from 'react'",
      '',
      '// 在组件外创建，渲染之间是同一个 Promise',
      "const userPromise = fetchUser('42')",
      '',
      'export function Profile() {',
      '  const user = use(userPromise)',
      '  return <h1>{user.name}</h1>',
      '}',
      '```',
      '',
      '用 useEffect 取数的老写法对照一下：',
      '',
      '```tsx',
      'function ProfileOld() {',
      '  const [user, setUser] = useState<User | null>(null)',
      "  useEffect(() => void fetchUser('42').then(setUser), [])",
      '  return user ? <h1>{user.name}</h1> : <Spinner />',
      '}',
      '```',
    ].join('\n')
  }
  back(task, 20)

  // 只有联网来源、没有代码和附件的聊天：来源一多右栏默认不自动打开（点标题栏的右栏开关再看）
  const news = await make('这周 AI 圈有什么新闻？')
  news.title = '这周的 AI 新闻'
  const newsReply = news.messages.find((m) => m.role === 'agent')
  if (newsReply) {
    const hosts = [
      'news.example.com/ai/week-47',
      'tech.example.org/2026/11/20/agents',
      'blog.example.net/posts/model-release',
      'research.example.edu/papers/long-context',
      'dev.example.io/changelog/cli',
      'press.example.com/releases/2026-11',
      'forum.example.dev/t/benchmarks',
      'weekly.example.co/issue-212',
      'podcast.example.fm/episodes/ai-roundup',
      'mag.example.com/features/coding-agents',
      'data.example.ai/reports/usage',
      'open.example.org/projects/eval-suite',
    ]
    newsReply.tools = [
      {
        kind: 'web',
        name: '网页搜索',
        label: 'AI news this week',
        detail: '',
        output: hosts.map((h, i) => `${i + 1}. ${h.split('/')[0]}\nhttps://${h}`).join('\n'),
        ms: 2100,
      },
    ]
    newsReply.text = '这周值得看的几条：新模型发布、长上下文评测和几款编码 Agent 的更新，来源见右栏。'
  }
  back(news, 35)
}

/** 英文词典的一部分，键是中文原文：对话里的报错和警告（shared/alerts.ts、警告行） */
export const EN_ALERTS: Record<string, string> = {
  // 警告行
  '原始信息：': 'Raw details:',
  点开看原因和怎么办: 'Open to see the cause and what to do',
  已恢复: 'Recovered',
  这是什么: 'What this means',
  怎么办: 'What to do',
  原始信息: 'Raw details',
  // 分类
  网络错误: 'Network error',
  '连不上模型服务，或者连接中途断开了（超时、被代理或服务端断开）。':
    "Couldn't reach the model service, or the connection dropped midway (timeout, or closed by a proxy or the server).",
  '检查网络和代理（CLI 设置里的环境变量，例如 HTTPS_PROXY）；面板会自动续接重试，仍然失败就点「继续执行」，或者换一个接口。':
    'Check your network and proxy (environment variables in the CLI settings, such as HTTPS_PROXY). The panel resumes and retries automatically; if it still fails, click Continue or switch to another API.',
  被限流: 'Rate limited',
  '模型服务返回「请求太多」或「服务过载」（429、529、overloaded），这一轮的请求被拒绝或在排队重试。':
    'The model service answered "too many requests" or "overloaded" (429, 529). Requests in this turn were rejected or are being retried.',
  '等一两分钟再继续；经常出现就换一个模型或接口，或者减少同时执行的子对话。':
    'Wait a minute or two, then continue. If it keeps happening, switch models or APIs, or run fewer subconversations at once.',
  登录或密钥失效: 'Sign-in or key invalid',
  'CLI 没有登录、登录过期，或者 API 密钥无效（401、403）。':
    'The CLI is not signed in, the sign-in expired, or the API key is invalid (401, 403).',
  '在终端里运行这个 CLI 按提示重新登录，或者到设置的「API 配置」里检查密钥，然后点「继续执行」。':
    'Run the CLI in a terminal and sign in again, or check the key under Settings → API, then click Continue.',
  额度用完: 'Out of quota',
  '账号的余额或用量额度不够了（insufficient balance、quota、billing）。':
    'The account ran out of balance or usage quota (insufficient balance, quota, billing).',
  '到模型服务的后台充值或等额度恢复；也可以在输入框里换一个模型或接口接着做。':
    "Top up in the model service's console or wait for the quota to reset. You can also switch models or APIs in the input box and continue.",
  上下文超长: 'Context too long',
  '这次请求的内容超过了模型的上下文上限，模型拒绝处理。':
    "This request exceeded the model's context limit, so the model refused it.",
  '点「压缩上下文」后继续，或者新开一个对话只带必要的内容。':
    'Click Compact context and continue, or start a new conversation with only what is needed.',
  模型请求被拒绝: 'Model request rejected',
  '模型服务拒绝了这次请求：模型名不对、不支持这个参数，或者请求内容不合格式（400、404）。':
    'The model service rejected the request: wrong model name, an unsupported parameter, or a malformed request (400, 404).',
  '看下面的原始信息确认是哪个参数；在输入框里换一个模型或思考强度后重试。':
    'Check the raw details below to find the parameter, then switch the model or effort in the input box and retry.',
  '找不到 CLI': 'CLI not found',
  '面板找不到要用的 CLI 命令，或者它在设置里被停用了。':
    "The panel can't find the CLI command, or the CLI is disabled in Settings.",
  '到设置里确认 CLI 已安装、命令路径正确并且已启用。':
    'In Settings, make sure the CLI is installed, its command path is correct, and it is enabled.',
  'CLI 执行失败': 'CLI failed',
  'CLI 没有正常完成这一轮：报了错，或者中途退出了（崩溃、配置错误）。':
    "The CLI didn't finish this turn: it reported an error or exited midway (crash, bad configuration).",
  '看下面的原始信息和 stderr；修好后点「继续执行」，也可以点「AI 处理」让 AI 帮你看。':
    'Check the raw details and stderr below. After fixing it, click Continue, or click AI fix to have AI look at it.',
  'CLI 没有响应': 'CLI not responding',
  '消息已经交给 CLI，但它一直没有任何输出：多半是它向模型发的请求卡住了（网络、限流、服务没响应），也可能是 CLI 自己卡死了。':
    "The message reached the CLI, but it hasn't produced any output. Most likely its request to the model is stuck (network, rate limit, unresponsive service), or the CLI itself hung.",
  '直接再发一条消息：面板会停掉卡住的 CLI，接着原来的会话重开，把没被处理的消息一起带上。也可以点停止后检查网络。':
    'Just send another message: the panel stops the stuck CLI, resumes the same session, and passes along the unhandled message. You can also click Stop and check your network.',
  长时间没有输出: 'No output for a long time',
  '执行中的 CLI 很久没有任何输出，可能卡在登录、网络重连或交互式确认上。':
    'The running CLI has produced no output for a long time. It may be stuck on sign-in, a network reconnect, or an interactive prompt.',
  '再过同样长的时间还没有输出会自动停止；也可以现在点停止，检查网络和登录后再继续。':
    'If there is still no output after the same amount of time, it stops automatically. You can also click Stop now, check your network and sign-in, then continue.',
  超过时限: 'Time limit reached',
  '这一步执行的时间超过了设置里的单步时限，被面板停掉了。':
    'This step ran longer than the per-step time limit in Settings, so the panel stopped it.',
  '点「继续执行」接着做；经常超时就在设置里调大「单步时限」，或者把任务拆小。':
    'Click Continue to keep going. If it happens often, raise the per-step time limit in Settings or split the task.',
  这一轮没有产出: 'Nothing produced this turn',
  '模型这一轮没有返回内容，或者只说了一句「我先…」就结束了，没有动手也没有结论。':
    'The model returned nothing this turn, or said "Let me first…" and stopped without acting or concluding.',
  '面板会自动再推一次；仍然没有产出就换一个模型，或者把要求写得更具体。':
    'The panel nudges it once more automatically. If nothing comes out, switch models or make the request more specific.',
  正在重试: 'Retrying',
  'CLI 向模型发的请求失败了，它正在自动重试。':
    "The CLI's request to the model failed and it is retrying automatically.",
  '一般会自己恢复，不用处理；反复重试失败时看原始信息里的原因。':
    'This usually recovers by itself. If retries keep failing, check the raw details for the cause.',
  消息没有送到: 'Message not delivered',
  '面板没能把一条消息（后台命令的结果、子对话的上报、提问的回答）交给这个对话的 CLI。':
    "The panel couldn't hand a message (a background command result, a subconversation report, an answer) to this conversation's CLI.",
  '消息已经记在对话里；发一条消息或点「继续执行」，CLI 下一轮会看到它。':
    'The message is saved in the conversation. Send a message or click Continue and the CLI will see it next turn.',
  独立分支出错: 'Separate branch error',
  '建立、恢复或删除独立分支（git worktree）时失败了。':
    'Creating, restoring, or deleting the separate branch (git worktree) failed.',
  '看原始信息里 git 的报错（常见是目录被占用、有未提交的改动），处理后再继续。':
    "Check git's error in the raw details (often a directory in use or uncommitted changes), fix it, then continue.",
  面板出错: 'Panel error',
  '面板自己在处理这个对话时出了错。': 'The panel itself hit an error while handling this conversation.',
  '点「继续执行」重试；反复出现请把原始信息复制给开发者，或者点「AI 处理」。':
    'Click Continue to retry. If it keeps happening, copy the raw details to the developers, or click AI fix.',
  // 面板写进对话的警告
  'CLI 没有响应，面板重启了它': 'The CLI stopped responding, so the panel restarted it',
  '已自动续接，从中断的地方继续了': 'Resumed automatically from where it stopped',
  '已自动接一轮，继续做完了': 'Nudged once more automatically and it finished',
  '{s} 秒后有输出了，接着在处理': 'Output resumed after {s}s and it is working again',
  '{cli} 收到消息 {s} 秒了还没有任何输出。直接再发一条消息，面板会停掉它、接回这个会话重新开始。':
    '{cli} received the message {s}s ago and has produced no output. Send another message and the panel will stop it and restart in the same session.',
  '{cli} 在 {s} 秒里没有任何输出（没有思考、正文或工具调用）。':
    '{cli} produced no output for {s}s (no thinking, text, or tool calls).',
  '收到新消息时停掉了卡住的 CLI，接回会话重新开始':
    'On the new message, the panel stopped the stuck CLI and restarted in the same session',
  '交给它的最后一条内容：': 'Last thing handed to it:',
  '最后一次输出在 {n} 分钟前': 'Last output was {n} min ago',
  '子对话的结果没能马上交给这个对话，已放进收件箱，下一轮会处理':
    "A subconversation's result couldn't be handed to this conversation right away. It is in the inbox for the next turn",
  执行这个子对话时出错: 'Error while running this subconversation',
  父对话的编译结果没能交给这个对话: "The parent's build result couldn't be handed to this conversation",
  '后台命令的结果两次都没能交给 CLI，已经记在对话里，下一轮会处理':
    "The background command's result couldn't reach the CLI after two tries. It is saved in the conversation for the next turn",
  后台命令的结果没能推回这个对话: "The background command's result couldn't be sent back to this conversation",
  '后台命令跑完了，但没能更新它那一行的结果': "The background command finished, but its row couldn't be updated",
  后台命令的提醒没能交给这个对话: "The background command's reminder couldn't be handed to this conversation",
  '一条消息没能马上交给这个对话，已放进收件箱':
    "A message couldn't be handed to this conversation right away. It is in the inbox",
  '对话完成了，但删除独立分支失败，分支和目录还留着':
    'The conversation finished, but deleting its separate branch failed. The branch and folder are still there',
  '这一轮结束后整理独立分支、上报父对话时出错':
    'Error while tidying the separate branch and reporting to the parent after this turn',
  收尾子对话后刷新计划失败: "The plan couldn't be refreshed after wrapping up the subconversation",
  这个对话的状态没能报给父对话: "This conversation's status couldn't be reported to the parent",
  '子对话等你决定，但没能开一轮来处理，问题在收件箱里':
    "A subconversation needs a decision, but a turn couldn't be started to handle it. The question is in the inbox",
  '关掉「提问」后没能开一轮去回答子对话的问题':
    "After Ask was turned off, a turn couldn't be started to answer the subconversation's question",
  '提前启动 CLI 失败：发消息时会再启动一次，仍然失败会在这里报错':
    'Starting the CLI ahead of time failed. It will start again when you send a message, and any failure will show here',
}

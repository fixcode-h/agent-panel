/**
 * 「本轮产出」的接口契约（写法见 ./define.ts，挑文件的规则见 shared/turn-outputs/pick.ts）：
 * 界面按这一轮的消息挑出候选文件交上来，服务端按这几条消息记下的快照查 git 状态和大小，
 * 删掉的、已经不在了的剔除，返回新建还是修改
 */
import { z } from 'zod'
import { TurnOutput } from '../turn-outputs/pick.ts'
import { endpoint } from './define.ts'

export const turnOutputsContract = {
  outputs: endpoint({
    method: 'POST',
    path: '/tasks/:id/turn-outputs',
    body: z.object({ msgs: z.array(z.string()).max(50), paths: z.array(z.string()).max(200) }),
    res: z.object({ files: z.array(TurnOutput) }),
  }),
}

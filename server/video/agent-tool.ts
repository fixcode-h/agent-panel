/**
 * 给 Agent 的截帧工具的说明（工具清单里列出来的那份）。执行在 agent-frames.ts，按需动态加载：
 * 面板工具服务（ask-mcp.ts）每轮都要列工具，不能为了这一个工具把 FFmpeg、ComfyUI 那一串模块都牵进来
 */
import { AUTO_MODES } from '../../shared/video.ts'

export const VIDEO_TOOL = {
  name: 'video_frames',
  title: '从视频截帧',
  description:
    '从本机视频里截几张帧图片来看（你读不了视频本身）。path 是视频的绝对路径；' +
    '可以给 times（要看的具体秒数，最多 12 个），或者给 start/end（秒，不给就是整段）加 count（张数，默认 6，最多 12）' +
    '和 mode（scene：在画面变化处截，默认；screen：录屏，跳过不动的画面；uniform：平均截）。' +
    '返回视频时长、尺寸和每张帧图片的路径与时间，再用读图片的方式去看。先截少量看个大概，需要细看某一段再缩小范围多截。',
  inputSchema: {
    type: 'object',
    properties: {
      path: { type: 'string', description: '视频文件的绝对路径' },
      times: { type: 'array', items: { type: 'number' }, description: '要截的具体时间点（秒）' },
      start: { type: 'number', description: '范围起点（秒）' },
      end: { type: 'number', description: '范围终点（秒）' },
      count: { type: 'number', description: '在范围里截几张，默认 6，最多 12' },
      mode: { type: 'string', enum: [...AUTO_MODES], description: '挑时间点的方式，默认 scene' },
    },
    required: ['path'],
  },
}

import * as React from 'react'
import { t, getLang } from '@shared/i18n'
import { taskSummary } from '@shared/task'
import type { PluginConfig } from '@shared/plugins/types'
import { api, request } from '@/lib/api'
import { useData, useNav, useTasks } from '@/lib/data'
import { toast } from '@/lib/toast'
import { cn } from '@/lib/utils'
import { Button } from '@/components/ui/button'
import { IconButton } from '@/components/ui/icon-button'
import { EmptyPanel } from '@/components/ui/empty-panel'
import { Field, Input, Select, Textarea } from '@/components/ui/input'
import { Modal } from '@/components/ui/modal'
import { Segmented } from '@/components/ui/segmented'
import { DirPicker, useDirInfo } from '@/components/projects/DirPicker'
import { appendDraft } from '@/components/chat/ChatComposer'
import { useNewAskUser } from '@/components/chat/AskToggle'
import { TaskView } from '@/components/tasks/TaskView'

/**
 * 交给插件网页部分的宿主（ADR 0059，类型见 sdk.ts 的 WebHost）：面板的数据、导航、界面组件和插件自己的接口。
 * 只开放这里列出来的东西，插件不 import 面板的源码；面板内部重构时只要这里的形状不变，插件就不用跟着改。
 */
/** 插件整页的子位置（#/plugin/<插件>/<页面>/<path>）：读当前的，跳到别的 */
function usePluginRoute(id: string) {
  const { route, go } = useNav()
  const here = route.page === 'plugin' && route.id === id
  return {
    page: here ? (route.sub ?? '') : '',
    path: here ? (route.msg ?? '') : '',
    go: (page: string, path?: string) => go({ page: 'plugin', id, sub: page, msg: path || undefined }),
  }
}

/**
 * 把一段文字放进对话的输入框再打开那个对话（插件的「发给对话」）：不直接发送，用户看过、补两句再发。
 * 给了 taskId 接在那个对话的草稿后面；没给就放进项目新建对话的输入框
 */
function useToChat() {
  const { go } = useNav()
  return React.useCallback(
    ({ projectId, taskId, text }: { projectId: string; taskId?: string; text: string }) => {
      appendDraft(taskId ? `task:${taskId}` : `new:project:${projectId}`, text)
      go(taskId ? { page: 'projects', id: projectId, sub: taskId } : { page: 'projects', id: projectId })
    },
    [go],
  )
}

export function host(id: string, config: () => PluginConfig) {
  const base = `/plugins/${encodeURIComponent(id)}/api`
  return {
    pluginId: id,
    React,
    t,
    lang: getLang,
    /** 当前参数（按清单声明补齐默认值） */
    config,
    /** 插件自己的接口（服务端 ServerPlugin.fetch）：路径写插件里的，例如 '/models/x' */
    api: {
      url: (path: string) => `/api${base}${path}`,
      get: <T>(path: string) => request<T>(`${base}${path}`),
      post: <T>(path: string, body?: unknown) =>
        request<T>(`${base}${path}`, { method: 'POST', body: JSON.stringify(body ?? {}) }),
    },
    /** 插件包里的文件地址 */
    fileUrl: (rel: string) => `/api/plugins/${encodeURIComponent(id)}/files/${rel}`,
    /** 面板接口里插件常用的几个 */
    panel: {
      createTask: api.createTask,
      createProject: api.createProject,
      makeDir: api.makeDir,
    },
    hooks: {
      useData,
      useTasks,
      useNav,
      useDirInfo,
      useNewAskUser,
      usePluginRoute: () => usePluginRoute(id),
      useToChat,
    },
    ui: { Button, IconButton, EmptyPanel, Field, Input, Select, Textarea, Modal, Segmented, DirPicker, TaskView },
    toast,
    cn,
    taskSummary,
  }
}

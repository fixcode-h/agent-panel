import { useCallback, useEffect, useRef, useState } from 'react'
import { Box, Download, Loader2, Maximize } from 'lucide-react'
import * as THREE from 'three'
import { GLTFLoader } from 'three/examples/jsm/loaders/GLTFLoader.js'
import { OrbitControls } from 'three/examples/jsm/controls/OrbitControls.js'
import type { ModelMeta } from '@shared/blender'
import { t } from '@shared/i18n'
import { api } from '@/lib/api'
import { cn } from '@/lib/utils'
import { IconButton } from '@/components/ui/icon-button'

/** 执行中隔 2 秒看一次版本号，空闲时放慢：Agent 每跑一次 blender_python 版本加一 */
const POLL_RUNNING = 2000
const POLL_IDLE = 8000

/** 读预览状态：版本号、物体列表、导出失败的原因 */
function useModelMeta(taskId: string, running: boolean) {
  const [meta, setMeta] = useState<ModelMeta>()
  const [error, setError] = useState('')
  useEffect(() => {
    let alive = true
    const load = () =>
      api
        .blenderModel(taskId)
        .then((m) => {
          if (!alive) return
          setMeta(m)
          setError('')
        })
        .catch((e) => alive && setError((e as Error).message))
    void load()
    const timer = setInterval(load, running ? POLL_RUNNING : POLL_IDLE)
    return () => {
      alive = false
      clearInterval(timer)
    }
  }, [taskId, running])
  return { meta, error }
}

/** three.js 的场景、相机和控制器：挂在一个 div 上，按需渲染（只在转动、换模型、改尺寸时画一帧） */
function useViewer(host: React.RefObject<HTMLDivElement | null>) {
  const ref = useRef<{
    renderer: THREE.WebGLRenderer
    scene: THREE.Scene
    camera: THREE.PerspectiveCamera
    controls: OrbitControls
    model?: THREE.Object3D
    render: () => void
  } | null>(null)
  useEffect(() => {
    const el = host.current
    if (!el) return
    let renderer: THREE.WebGLRenderer
    try {
      renderer = new THREE.WebGLRenderer({ antialias: true, alpha: true })
    } catch {
      // 没有 WebGL（远程桌面、禁用了硬件加速）：外层显示说明，不让整页报错
      ref.current = null
      return
    }
    renderer.setPixelRatio(Math.min(2, window.devicePixelRatio))
    el.appendChild(renderer.domElement)
    const scene = new THREE.Scene()
    scene.add(new THREE.HemisphereLight(0xffffff, 0x444444, 2.2))
    const sun = new THREE.DirectionalLight(0xffffff, 2)
    sun.position.set(3, 6, 4)
    scene.add(sun)
    const grid = new THREE.GridHelper(10, 20, 0x888888, 0x888888)
    ;(grid.material as THREE.Material).opacity = 0.25
    ;(grid.material as THREE.Material).transparent = true
    scene.add(grid)
    const camera = new THREE.PerspectiveCamera(40, 1, 0.01, 1000)
    camera.position.set(3, 2.5, 4)
    const controls = new OrbitControls(camera, renderer.domElement)
    const render = () => renderer.render(scene, camera)
    controls.addEventListener('change', render)
    const resize = () => {
      const w = el.clientWidth
      const h = el.clientHeight
      if (!w || !h) return
      renderer.setSize(w, h)
      camera.aspect = w / h
      camera.updateProjectionMatrix()
      render()
    }
    const ro = new ResizeObserver(resize)
    ro.observe(el)
    resize()
    ref.current = { renderer, scene, camera, controls, render }
    return () => {
      ro.disconnect()
      controls.dispose()
      if (ref.current?.model) disposeObject(ref.current.model)
      renderer.dispose()
      renderer.domElement.remove()
      ref.current = null
    }
  }, [host])
  return ref
}

/** 换模型时把旧的几何体、材质、贴图释放掉，不然每次刷新都漏一份显存 */
function disposeObject(obj: THREE.Object3D) {
  obj.traverse((o) => {
    const mesh = o as THREE.Mesh
    mesh.geometry?.dispose()
    const mats = Array.isArray(mesh.material) ? mesh.material : mesh.material ? [mesh.material] : []
    for (const m of mats) {
      for (const v of Object.values(m)) if (v instanceof THREE.Texture) v.dispose()
      m.dispose()
    }
  })
}

/** 让相机正好看全模型：按包围球算距离，从右前上方看 */
function fit(v: { camera: THREE.PerspectiveCamera; controls: OrbitControls; render: () => void }, obj: THREE.Object3D) {
  const box = new THREE.Box3().setFromObject(obj)
  if (box.isEmpty()) return
  const sphere = box.getBoundingSphere(new THREE.Sphere())
  // 右栏常常是竖长的：按横竖两个方向里窄的那个视角算距离，模型才不会左右被裁掉
  const vHalf = (v.camera.fov * Math.PI) / 360
  const hHalf = Math.atan(Math.tan(vHalf) * v.camera.aspect)
  const dist = (sphere.radius / Math.sin(Math.min(vHalf, hHalf))) * 1.15
  const dir = new THREE.Vector3(1, 0.8, 1.2).normalize()
  v.camera.position.copy(sphere.center).addScaledVector(dir, dist)
  v.camera.near = Math.max(0.001, dist / 100)
  v.camera.far = dist * 100
  v.camera.updateProjectionMatrix()
  v.controls.target.copy(sphere.center)
  v.controls.update()
  v.render()
}

/**
 * 模型对话右栏的「模型」页签（ADR 0025）：Agent 每次用 Blender 改完，服务端导出 scene.glb、版本号加一；
 * 这里轮询版本号，变了就重新加载，视角保持不动（只有第一次加载自动对准模型）。可以转、缩放、平移
 */
export function ModelPreview({ taskId, running }: { taskId: string; running: boolean }) {
  const host = useRef<HTMLDivElement>(null)
  const viewer = useViewer(host)
  const { meta, error } = useModelMeta(taskId, running)
  const [loading, setLoading] = useState(false)
  const [loadError, setLoadError] = useState('')
  const shown = useRef(0)
  const version = meta?.version ?? 0
  useEffect(() => {
    const v = viewer.current
    if (!v || !version || version === shown.current) return
    let alive = true
    setLoading(true)
    api
      .blenderGlb(taskId, version)
      .then((buf) => new GLTFLoader().parseAsync(buf, ''))
      .then((gltf) => {
        if (!alive || !viewer.current) return disposeObject(gltf.scene)
        const first = !v.model
        if (v.model) {
          v.scene.remove(v.model)
          disposeObject(v.model)
        }
        v.model = gltf.scene
        v.scene.add(gltf.scene)
        shown.current = version
        setLoadError('')
        if (first) fit(v, gltf.scene)
        else v.render()
      })
      .catch((e) => alive && setLoadError(t('加载模型失败：{error}', { error: (e as Error).message })))
      .finally(() => alive && setLoading(false))
    return () => {
      alive = false
    }
  }, [taskId, version, viewer])
  const refit = useCallback(() => {
    const v = viewer.current
    if (v?.model) fit(v, v.model)
  }, [viewer])
  const noGl = !!host.current && !viewer.current
  const problem = error || loadError || meta?.exportError
  return (
    <div className="flex min-h-0 flex-1 flex-col">
      <div className="flex h-[1.875rem] shrink-0 items-center gap-1.5 border-b pr-2.5 pl-4 text-footnote text-subtle">
        <Box className="h-[0.8125rem] w-[0.8125rem] shrink-0" strokeWidth={2.2} />
        <span className="min-w-0 truncate">
          {version
            ? t('第 {n} 版 · {count} 个物体', { n: version, count: meta?.objects.length ?? 0 })
            : t('还没有模型')}
        </span>
        {loading && <Loader2 className="h-3 w-3 shrink-0 animate-spin" />}
        <div className="ml-auto flex shrink-0 items-center gap-0.5">
          <IconButton icon={Maximize} label={t('对准模型')} size="2xs" disabled={!version} onClick={refit} />
          {/* 演示版的模型是浏览器里现场拼的，没有能下载的文件 */}
          {version > 0 && !import.meta.env.VITE_DEMO && (
            <a
              href={api.blenderGlbUrl(taskId, version)}
              download="scene.glb"
              aria-label={t('下载 glb')}
              title={t('下载 glb')}
              className="grid h-6 w-6 place-items-center rounded-md text-muted hover:bg-sel hover:text-fg"
            >
              <Download className="h-3 w-3" />
            </a>
          )}
        </div>
      </div>
      <div className="relative min-h-[240px] flex-1">
        <div ref={host} aria-label={t('模型预览')} className={cn('absolute inset-0', !version && 'invisible')} />
        {!version && (
          <div className="absolute inset-0 flex flex-col items-center justify-center gap-2 px-6 text-center">
            <Box className="h-6 w-6 text-subtle" strokeWidth={1.9} />
            <p className="text-body leading-relaxed text-subtle">
              {t('还没有模型。Agent 用 Blender 建模后，这里会实时显示，可以拖动旋转、滚轮缩放。')}
            </p>
          </div>
        )}
        {noGl && (
          <p className="absolute inset-x-4 top-4 text-footnote text-warning">
            {t('浏览器不支持 WebGL，没法预览模型；可以下载 glb 用别的软件看。')}
          </p>
        )}
      </div>
      {problem && <p className="shrink-0 border-t px-4 py-2 text-footnote leading-relaxed text-danger">{problem}</p>}
      {!!meta?.objects.length && (
        <ul aria-label={t('场景里的物体')} className="max-h-[35%] shrink-0 overflow-y-auto border-t py-1">
          {meta.objects.map((o) => (
            <li key={o.name} className="flex items-center gap-2 px-4 py-1 text-footnote">
              <span className={cn('min-w-0 flex-1 truncate', o.hidden && 'text-subtle line-through')}>{o.name}</span>
              <span className="shrink-0 font-mono text-caption text-subtle">
                {o.type}
                {o.faces !== undefined ? ` · ${t('{n} 面', { n: o.faces })}` : ''}
              </span>
            </li>
          ))}
        </ul>
      )}
    </div>
  )
}

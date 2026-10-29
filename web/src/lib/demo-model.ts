import * as THREE from 'three'
import { GLTFExporter } from 'three/examples/jsm/exporters/GLTFExporter.js'

/**
 * 在线演示没有 Blender：模型设计对话的「模型」页签用一只现场拼出来的宝箱演示预览（转、缩放、物体列表）。
 * 只在演示版里按需加载（见 api.blenderGlb），正式包不带它
 */
export const DEMO_MODEL_OBJECTS = [
  { name: 'Chest_Body', type: 'MESH', faces: 6, materials: ['Wood'] },
  { name: 'Chest_Lid', type: 'MESH', faces: 6, materials: ['Wood'] },
  { name: 'Trim_Front', type: 'MESH', faces: 6, materials: ['Gold'] },
  { name: 'Trim_Back', type: 'MESH', faces: 6, materials: ['Gold'] },
  { name: 'Lock', type: 'MESH', faces: 6, materials: ['Gold'] },
]

export async function demoModelGlb(): Promise<ArrayBuffer> {
  const wood = new THREE.MeshStandardMaterial({ name: 'Wood', color: 0x8b5a2b, roughness: 0.8 })
  const gold = new THREE.MeshStandardMaterial({ name: 'Gold', color: 0xd9a441, metalness: 0.8, roughness: 0.35 })
  const scene = new THREE.Scene()
  const add = (name: string, size: [number, number, number], pos: [number, number, number], mat: THREE.Material) => {
    const m = new THREE.Mesh(new THREE.BoxGeometry(...size), mat)
    m.name = name
    m.position.set(...pos)
    scene.add(m)
  }
  add('Chest_Body', [1.2, 0.6, 0.8], [0, 0.3, 0], wood)
  add('Chest_Lid', [1.24, 0.25, 0.84], [0, 0.73, 0], wood)
  add('Trim_Front', [1.26, 0.08, 0.06], [0, 0.6, 0.43], gold)
  add('Trim_Back', [1.26, 0.08, 0.06], [0, 0.6, -0.43], gold)
  add('Lock', [0.14, 0.18, 0.05], [0, 0.55, 0.45], gold)
  return (await new GLTFExporter().parseAsync(scene, { binary: true })) as ArrayBuffer
}

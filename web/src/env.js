// 当前环境的**共享状态**（M9）。
//
// 为什么单独开一个模块：环境徽标画在 App.vue 的头部，而「切环境」这个动作发生在 Environments.vue ——
// 两处必须读同一份状态。最初我在 App.vue 里写的是「路由变化时重取一次」，
// 结果真机验证当场抓到：**在 Environments 页里切环境不会引起路由变化**，
// 于是头部徽标一直显示上一个环境 —— 一个会撒谎的徽标比没有徽标更危险
// （你以为在打测试环境，其实平台已经切到别的环境了）。
//
// 做法与 auth.js 的 session 同一套路：状态放模块里（reactive 单例），谁改了谁来 set，谁要看谁来读。
import { reactive } from 'vue'
import { api } from './api.js'

export const envState = reactive({
  items: [],
  activeId: null,
  activeName: '',
  loaded: false,
})

/** 用一次「列表 + activeId」的响应整体对齐状态（唯一入口，避免各处自己算 activeName） */
export function applyEnvironments({ items = [], activeId = null } = {}) {
  envState.items = items
  envState.activeId = activeId || null
  envState.activeName = items.find((e) => e.id === envState.activeId)?.name || ''
  envState.loaded = true
  return envState
}

/** 从后端拉一次并对齐；失败时标成「已加载」但不编造内容（徽标会显示未选环境，而不是继承旧值） */
export async function refreshEnvironments() {
  try {
    applyEnvironments(await api.listEnvironments())
  } catch {
    applyEnvironments({ items: [], activeId: null })
  }
  return envState
}

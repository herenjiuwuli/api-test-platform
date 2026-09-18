import axios from 'axios'
import { getToken, clearSession } from './auth.js'

const http = axios.create({ baseURL: '/', timeout: 30000 })

// 请求拦截：自动附加 Bearer token
http.interceptors.request.use((cfg) => {
  const t = getToken()
  if (t) cfg.headers.Authorization = 'Bearer ' + t
  return cfg
})

// 响应拦截：401 视为登录失效，清 token 并跳登录页
http.interceptors.response.use(
  (r) => r,
  (err) => {
    if (err.response && err.response.status === 401) {
      clearSession()
      const cur = location.hash.replace(/^#/, '')
      if (cur !== '/login') location.hash = '/login'
    }
    return Promise.reject(err)
  },
)

export const api = {
  // M4：鉴权
  login: (username, password) => http.post('/api/auth/login', { username, password }).then((r) => r.data),
  register: (username, password) => http.post('/api/auth/register', { username, password }).then((r) => r.data),
  me: () => http.get('/api/auth/me').then((r) => r.data),
  changePassword: (oldPassword, newPassword) =>
    http.post('/api/auth/change-password', { oldPassword, newPassword }).then((r) => r.data),
  // 用例
  listCases: () => http.get('/api/cases').then((r) => r.data),
  // M8：请求体类型与文件夹具的可选值（唯一事实来源在后端）
  bodyOptions: () => http.get('/api/meta/body-options').then((r) => r.data),
  getCase: (id) => http.get(`/api/cases/${id}`).then((r) => r.data),
  createCase: (payload) => http.post('/api/cases', payload).then((r) => r.data),
  updateCase: (id, payload) => http.put(`/api/cases/${id}`, payload).then((r) => r.data),
  deleteCase: (id) => http.delete(`/api/cases/${id}`).then((r) => r.data),
  runCase: (id) => http.post(`/api/cases/${id}/run`).then((r) => r.data),
  // M12：run-all 支持 body 过滤 —— {prefix} 按名前缀 / {group} 按分组标签 / {ids} 显式指定。
  // 不传或传 {} 则跑全部用例。
  runAll: (body) => http.post('/api/run-all', body || {}).then((r) => r.data),
  // M9：环境变量集
  listEnvironments: () => http.get('/api/environments').then((r) => r.data),
  createEnvironment: (payload) => http.post('/api/environments', payload).then((r) => r.data),
  updateEnvironment: (id, payload) => http.put(`/api/environments/${id}`, payload).then((r) => r.data),
  deleteEnvironment: (id) => http.delete(`/api/environments/${id}`).then((r) => r.data),
  setActiveEnvironment: (id) => http.put('/api/environments/active', { id }).then((r) => r.data),
  // M11：套件导出 / 导入
  exportSuite: () => http.get('/api/suite/export').then((r) => r.data),
  importSuite: (payload, onConflict) =>
    http.post('/api/suite/import', payload, { params: { onConflict } }).then((r) => r.data),
  // M3：定时任务 + 报告
  listRuns: (params) => http.get('/api/runs', { params }).then((r) => r.data),
  getReportSummary: () => http.get('/api/reports/summary').then((r) => r.data),
  listSchedules: () => http.get('/api/schedules').then((r) => r.data),
  createSchedule: (payload) => http.post('/api/schedules', payload).then((r) => r.data),
  updateSchedule: (id, payload) => http.put(`/api/schedules/${id}`, payload).then((r) => r.data),
  deleteSchedule: (id) => http.delete(`/api/schedules/${id}`).then((r) => r.data),
  // M17：运行通知（定时任务跑完/失败落库，铃铛展示未读）
  listNotifications: (params) => http.get('/api/notifications', { params }).then((r) => r.data),
  unreadCount: () => http.get('/api/notifications/unread-count').then((r) => r.data),
  markNotificationRead: (id) => http.post(`/api/notifications/${id}/read`).then((r) => r.data),
  markAllNotificationsRead: () => http.post('/api/notifications/read-all').then((r) => r.data),
  // AI 生成用例（AI 响应较慢，单独放宽超时）
  aiGenerateCases: (payload) =>
    http.post('/api/ai/generate-cases', payload, { timeout: 120000 }).then((r) => r.data),
}

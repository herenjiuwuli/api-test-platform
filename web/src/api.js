import axios from 'axios'

const http = axios.create({ baseURL: '/', timeout: 30000 })

export const api = {
  listCases: () => http.get('/api/cases').then((r) => r.data),
  getCase: (id) => http.get(`/api/cases/${id}`).then((r) => r.data),
  createCase: (payload) => http.post('/api/cases', payload).then((r) => r.data),
  updateCase: (id, payload) => http.put(`/api/cases/${id}`, payload).then((r) => r.data),
  deleteCase: (id) => http.delete(`/api/cases/${id}`).then((r) => r.data),
  runCase: (id) => http.post(`/api/cases/${id}/run`).then((r) => r.data),
  runAll: () => http.post('/api/run-all').then((r) => r.data),
  // M3：定时任务 + 报告
  listRuns: (params) => http.get('/api/runs', { params }).then((r) => r.data),
  getReportSummary: () => http.get('/api/reports/summary').then((r) => r.data),
  listSchedules: () => http.get('/api/schedules').then((r) => r.data),
  createSchedule: (payload) => http.post('/api/schedules', payload).then((r) => r.data),
  updateSchedule: (id, payload) => http.put(`/api/schedules/${id}`, payload).then((r) => r.data),
  deleteSchedule: (id) => http.delete(`/api/schedules/${id}`).then((r) => r.data),
}

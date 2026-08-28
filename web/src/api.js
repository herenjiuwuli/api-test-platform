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
}

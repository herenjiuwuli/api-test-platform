import { createRouter, createWebHashHistory } from 'vue-router'
import CaseList from './views/CaseList.vue'
import CaseEditor from './views/CaseEditor.vue'
import Reports from './views/Reports.vue'
import Environments from './views/Environments.vue'
import Login from './views/Login.vue'

const router = createRouter({
  history: createWebHashHistory(),
  routes: [
    { path: '/login', name: 'login', component: Login },
    { path: '/', name: 'list', component: CaseList },
    { path: '/cases/new', name: 'new', component: CaseEditor },
    { path: '/cases/:id/edit', name: 'edit', component: CaseEditor },
    { path: '/reports', name: 'reports', component: Reports },
    { path: '/environments', name: 'environments', component: Environments },
  ],
})

// 路由守卫（M4）：未登录跳登录页；已登录访问登录页则回首页
router.beforeEach((to) => {
  const token = localStorage.getItem('atp_token')
  if (!token && to.path !== '/login') return '/login'
  if (token && to.path === '/login') return '/'
})

export default router

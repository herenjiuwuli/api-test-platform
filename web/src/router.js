import { createRouter, createWebHashHistory } from 'vue-router'
import CaseList from './views/CaseList.vue'
import CaseEditor from './views/CaseEditor.vue'
import Reports from './views/Reports.vue'

export default createRouter({
  history: createWebHashHistory(),
  routes: [
    { path: '/', name: 'list', component: CaseList },
    { path: '/cases/new', name: 'new', component: CaseEditor },
    { path: '/cases/:id/edit', name: 'edit', component: CaseEditor },
    { path: '/reports', name: 'reports', component: Reports },
  ],
})

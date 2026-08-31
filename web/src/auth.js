// 前端会话状态（M4）：token 存 localStorage，session 用 Vue reactive 驱动视图刷新。
import { reactive } from 'vue'

const KEY = 'atp_token'

export const session = reactive({
  token: localStorage.getItem(KEY) || '',
  username: '',
})

export function getToken() {
  return session.token
}

export function setSession(token, username) {
  session.token = token
  session.username = username
  localStorage.setItem(KEY, token)
}

export function clearSession() {
  session.token = ''
  session.username = ''
  localStorage.removeItem(KEY)
}

export function isLoggedIn() {
  return !!session.token
}

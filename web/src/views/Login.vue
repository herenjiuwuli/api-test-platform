<template>
  <div class="login-wrap">
    <el-card class="login-card" shadow="always">
      <div class="login-head">
        <div class="logo">⚡</div>
        <h2>API 自动化测试平台</h2>
        <p class="sub">M4 · 登录后使用</p>
      </div>

      <el-form :model="form" @submit.prevent="onLogin" label-position="top">
        <el-form-item label="用户名">
          <el-input v-model="form.username" placeholder="请输入用户名" clearable />
        </el-form-item>
        <el-form-item label="密码">
          <el-input v-model="form.password" type="password" placeholder="请输入密码" show-password @keyup.enter="onLogin" />
        </el-form-item>
        <el-alert v-if="error" :title="error" type="error" show-icon :closable="false" style="margin-bottom: 12px" />
        <el-button type="primary" :loading="loading" native-type="submit" style="width: 100%">登 录</el-button>
      </el-form>

      <div class="extra">
        <span>没有账号？</span>
        <el-button link type="primary" :loading="regLoading" @click="onRegister">注册并登录</el-button>
      </div>

      <el-alert
        v-if="showDemoHint"
        type="info"
        :closable="false"
        show-icon
        title="首次使用可用默认管理员"
        description="admin / admin123（服务首次启动自动创建，请尽快修改密码）"
        style="margin-top: 14px"
      />
    </el-card>
  </div>
</template>

<script setup>
import { reactive, ref } from 'vue'
import { useRouter } from 'vue-router'
import { api } from '../api.js'
import { setSession } from '../auth.js'

const router = useRouter()
const form = reactive({ username: '', password: '' })
const loading = ref(false)
const regLoading = ref(false)
const error = ref('')
const showDemoHint = ref(true)

async function onLogin() {
  error.value = ''
  if (!form.username || !form.password) {
    error.value = '请输入用户名和密码'
    return
  }
  loading.value = true
  try {
    const res = await api.login(form.username, form.password)
    setSession(res.token, res.user.username)
    router.push('/')
  } catch (e) {
    error.value = e.response?.data?.error || '登录失败'
  } finally {
    loading.value = false
  }
}

async function onRegister() {
  error.value = ''
  if (!form.username || !form.password) {
    error.value = '请输入用户名和密码（密码至少 6 位）'
    return
  }
  regLoading.value = true
  try {
    const res = await api.register(form.username, form.password)
    setSession(res.token, res.user.username)
    router.push('/')
  } catch (e) {
    error.value = e.response?.data?.error || '注册失败'
  } finally {
    regLoading.value = false
  }
}
</script>

<style scoped>
.login-wrap {
  min-height: 100vh;
  display: flex;
  align-items: center;
  justify-content: center;
  background: linear-gradient(135deg, #f5f7fa 0%, #e4ecfb 100%);
}
.login-card {
  width: 360px;
  border-radius: 14px;
}
.login-head {
  text-align: center;
  margin-bottom: 18px;
}
.logo {
  font-size: 36px;
}
.login-head h2 {
  margin: 6px 0 2px;
  font-size: 18px;
  color: #303133;
}
.sub {
  margin: 0;
  font-size: 12px;
  color: #909399;
}
.extra {
  margin-top: 14px;
  text-align: center;
  font-size: 13px;
  color: #606266;
}
</style>

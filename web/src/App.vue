<template>
  <router-view v-if="isLogin" />

  <el-container v-else class="app-shell">
    <el-header class="app-header">
      <div class="brand">
        <span class="brand-dot">⚡</span>
        <span class="brand-name">API 自动化测试平台</span>
        <span class="brand-sub">M11 · 用例链 + 文件上传 + 环境变量集 + 环境快照 + 套件导出导入</span>
      </div>
      <div class="nav">
        <el-tag v-if="activeEnvName" type="success" effect="plain" size="small" class="env-tag" @click="$router.push('/environments')">
          🌐 {{ activeEnvName }}
        </el-tag>
        <el-tag v-else type="warning" effect="plain" size="small" class="env-tag" @click="$router.push('/environments')">
          🌐 未选环境
        </el-tag>
        <el-dropdown v-if="session.username" trigger="click" @command="onCommand">
          <span class="who">👤 {{ session.username }} <span class="caret">▾</span></span>
          <template #dropdown>
            <el-dropdown-menu>
              <el-dropdown-item command="pwd">修改密码</el-dropdown-item>
              <el-dropdown-item command="logout" divided>退出登录</el-dropdown-item>
            </el-dropdown-menu>
          </template>
        </el-dropdown>
        <el-button text :type="isList ? 'primary' : ''" @click="$router.push('/')">用例列表</el-button>
        <el-button text :type="isReports ? 'primary' : ''" @click="$router.push('/reports')">报告 / 定时</el-button>
        <el-button text :type="isEnvs ? 'primary' : ''" @click="$router.push('/environments')">环境</el-button>
        <el-button type="primary" @click="$router.push('/cases/new')">+ 新建用例</el-button>
        <el-button v-if="!session.username" text type="danger" @click="logout">退出</el-button>
      </div>
    </el-header>
    <el-main class="app-main">
      <router-view />
    </el-main>

    <el-dialog v-model="pwdVisible" title="修改密码" width="420px" :close-on-click-modal="false">
      <el-form :model="pwdForm" label-width="84px">
        <el-form-item label="原密码">
          <el-input v-model="pwdForm.oldPassword" type="password" show-password placeholder="请输入当前密码" />
        </el-form-item>
        <el-form-item label="新密码">
          <el-input v-model="pwdForm.newPassword" type="password" show-password placeholder="至少 6 位" />
        </el-form-item>
        <el-form-item label="确认新密码">
          <el-input v-model="pwdForm.confirm" type="password" show-password placeholder="再次输入新密码" />
        </el-form-item>
      </el-form>
      <template #footer>
        <el-button @click="pwdVisible = false">取消</el-button>
        <el-button type="primary" :loading="pwdLoading" @click="submitPwd">确定修改</el-button>
      </template>
    </el-dialog>
  </el-container>
</template>

<script setup>
import { computed, onMounted, ref, watch } from 'vue'
import { useRoute, useRouter } from 'vue-router'
import { ElMessage } from 'element-plus'
import { session, clearSession } from './auth.js'
import { api } from './api.js'
import { envState, refreshEnvironments } from './env.js'

const route = useRoute()
const router = useRouter()
const isLogin = computed(() => route.path === '/login')
const isList = computed(() => route.path === '/')
const isReports = computed(() => route.path === '/reports')
const isEnvs = computed(() => route.path === '/environments')

// 当前环境徽标：让「这次打的是哪个环境」永远在视野里 ——
// 跑用例之前先看一眼这块标签，比事后翻报告里那条 URL 有用得多。
// 状态来自共享的 envState：在 Environments 页里切环境时它会同步变，不需要靠路由变化来对齐。
const activeEnvName = computed(() => envState.activeName)

// 修改密码弹窗状态
const pwdVisible = ref(false)
const pwdLoading = ref(false)
const pwdForm = ref({ oldPassword: '', newPassword: '', confirm: '' })

// 刷新后若已有 token，拉一次当前用户补全用户名
onMounted(async () => {
  if (session.token && !session.username) {
    try {
      const r = await api.me()
      session.username = r.user.username
    } catch {
      clearSession()
    }
  }
  if (session.token) await refreshEnvironments()
})

// 兜底再对齐一次（例如别处改了库、或页面被直接从外部带 hash 打开）：
// 环境是全局状态，多对齐一次的成本是一次很小的 GET，比"徽标撒谎"便宜得多。
watch(() => route.path, () => {
  if (session.token) refreshEnvironments()
})

function logout() {
  clearSession()
  router.push('/login')
}

function onCommand(cmd) {
  if (cmd === 'logout') logout()
  else if (cmd === 'pwd') {
    pwdForm.value = { oldPassword: '', newPassword: '', confirm: '' }
    pwdVisible.value = true
  }
}

async function submitPwd() {
  if (pwdForm.value.newPassword.length < 6) return ElMessage.error('新密码至少 6 位')
  if (pwdForm.value.newPassword !== pwdForm.value.confirm) return ElMessage.error('两次输入的新密码不一致')
  pwdLoading.value = true
  try {
    await api.changePassword(pwdForm.value.oldPassword, pwdForm.value.newPassword)
    ElMessage.success('密码已修改，请重新登录')
    pwdVisible.value = false
    clearSession()
    router.push('/login')
  } catch (e) {
    ElMessage.error(e.response?.data?.error || '修改失败')
  } finally {
    pwdLoading.value = false
  }
}
</script>

<style>
* { box-sizing: border-box; }
body { margin: 0; background: #f5f7fa; font-family: -apple-system, "Segoe UI", "Microsoft YaHei", sans-serif; }
.app-shell { min-height: 100vh; }
.app-header {
  display: flex;
  align-items: center;
  justify-content: space-between;
  background: #fff;
  border-bottom: 1px solid #e4e7ed;
  box-shadow: 0 1px 4px rgba(0, 0, 0, 0.04);
}
.brand { display: flex; align-items: center; gap: 8px; }
.brand-dot { font-size: 18px; }
.brand-name { font-size: 16px; font-weight: 600; color: #303133; }
.brand-sub { font-size: 12px; color: #909399; }
.nav { display: flex; align-items: center; gap: 4px; }
.env-tag { cursor: pointer; margin-right: 8px; }
.who { font-size: 13px; color: #606266; margin-right: 6px; cursor: pointer; user-select: none; }
.caret { font-size: 11px; opacity: 0.7; }
.app-main { padding: 20px; max-width: 1200px; margin: 0 auto; width: 100%; }
</style>

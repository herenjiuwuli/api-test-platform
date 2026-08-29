<template>
  <el-container class="app-shell">
    <el-header class="app-header">
      <div class="brand">
        <span class="brand-dot">⚡</span>
        <span class="brand-name">API 自动化测试平台</span>
        <span class="brand-sub">M3 · JSONPath 断言 + 定时任务 + 报告</span>
      </div>
      <div class="nav">
        <el-button text :type="isList ? 'primary' : ''" @click="$router.push('/')">用例列表</el-button>
        <el-button text :type="isReports ? 'primary' : ''" @click="$router.push('/reports')">报告 / 定时</el-button>
        <el-button type="primary" @click="$router.push('/cases/new')">+ 新建用例</el-button>
      </div>
    </el-header>
    <el-main class="app-main">
      <router-view />
    </el-main>
  </el-container>
</template>

<script setup>
import { computed } from 'vue'
import { useRoute } from 'vue-router'

const route = useRoute()
const isList = computed(() => route.path === '/')
const isReports = computed(() => route.path === '/reports')
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
.app-main { padding: 20px; max-width: 1200px; margin: 0 auto; width: 100%; }
</style>

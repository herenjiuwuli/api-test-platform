<template>
  <div class="envs">
    <el-alert type="info" :closable="false" show-icon class="tip">
      <template #title>环境变量集：把「打谁」从用例里拿出来</template>
      <div class="tip-body">
        用例的 URL 里写 <code>{{ BASE_TAG }}/api/xxx</code>，运行时按<strong>当前环境</strong>替换 —— 换环境不用改用例。
        另有两条规则：① 环境变量是<strong>基线</strong>，链上 <code>extract</code> 抽到的同名值优先（避免用过期 token 假装通过）；
        ② 环境请求头是<strong>默认值</strong>，用例里手写的同名头优先（大小写不敏感）。
      </div>
    </el-alert>

    <el-card class="sec" shadow="never">
      <template #header>
        <div class="sec-head">
          <span>🌐 环境列表</span>
          <span class="sec-head-right">
            <span v-if="activeId" class="active-hint">当前：{{ activeName }}</span>
            <span v-else class="no-active-hint">当前没有选中环境（用例里的 {{ BASE_TAG }} 会取不到值）</span>
            <el-button type="primary" size="small" @click="openNew">+ 新建环境</el-button>
          </span>
        </div>
      </template>

      <el-table :data="items" border size="small" v-loading="loading">
        <el-table-column label="当前" width="70">
          <template #default="{ row }">
            <el-tag v-if="row.id === activeId" type="success" size="small">使用中</el-tag>
            <span v-else class="dim">—</span>
          </template>
        </el-table-column>
        <el-table-column prop="name" label="环境名" min-width="140" show-overflow-tooltip />
        <el-table-column prop="baseUrl" :label="`地址（${BASE_TAG}）`" min-width="220" show-overflow-tooltip />
        <el-table-column label="变量 / 请求头" width="130">
          <template #default="{ row }">{{ Object.keys(row.vars || {}).length }} / {{ Object.keys(row.headers || {}).length }}</template>
        </el-table-column>
        <el-table-column label="操作" width="230">
          <template #default="{ row }">
            <el-button
              size="small"
              :type="row.id === activeId ? 'info' : 'primary'"
              :disabled="row.id === activeId"
              @click="activate(row.id)"
            >
              {{ row.id === activeId ? '已激活' : '设为当前' }}
            </el-button>
            <el-button size="small" @click="openEdit(row)">编辑</el-button>
            <el-button size="small" type="danger" @click="remove(row)">删除</el-button>
          </template>
        </el-table-column>
        <template #empty>还没有环境 —— 点右上角「新建环境」，填被测系统的地址</template>
      </el-table>

      <div v-if="activeId" class="foot">
        <el-button text type="info" @click="deactivate">取消当前环境</el-button>
      </div>
    </el-card>

    <el-dialog v-model="dialogVisible" :title="editing ? '编辑环境' : '新建环境'" width="560px" :close-on-click-modal="false">
      <el-form :model="form" label-width="96px">
        <el-form-item label="环境名" required>
          <el-input v-model="form.name" placeholder="如：office-oa（本地）" />
        </el-form-item>
        <el-form-item label="地址" required>
          <el-input v-model="form.baseUrl" placeholder="http://127.0.0.1:3200（结尾的 / 会自动去掉）" />
        </el-form-item>
        <el-form-item label="环境变量">
          <el-input
            v-model="form.varsText"
            type="textarea"
            :rows="3"
            placeholder='JSON 对象，如 {"tenantId":"t1"}；用例里用 {{tenantId}} 引用（变量名不能叫 base）'
          />
        </el-form-item>
        <el-form-item label="默认请求头">
          <el-input
            v-model="form.headersText"
            type="textarea"
            :rows="3"
            placeholder='JSON 对象，如 {"X-Env":"staging"}；用例里手写的同名头会覆盖它'
          />
        </el-form-item>
      </el-form>
      <template #footer>
        <el-button @click="dialogVisible = false">取消</el-button>
        <el-button type="primary" :loading="saving" @click="save">保存</el-button>
      </template>
    </el-dialog>
  </div>
</template>

<script setup>
import { computed, onMounted, ref } from 'vue'
import { ElMessage, ElMessageBox } from 'element-plus'
import { api } from '../api.js'
import { applyEnvironments } from '../env.js'

const loading = ref(false)
const saving = ref(false)
const items = ref([])
const activeId = ref(null)

// 模板里要**原样显示** {{base}} 这类占位符，但不能直接写 —— Vue 会把 `{{` 当插值起点解析。
const BASE_TAG = '{{base}}'

const dialogVisible = ref(false)
const editing = ref(null) // 非空 = 编辑中的环境对象
const form = ref({ name: '', baseUrl: '', varsText: '', headersText: '' })

const activeName = computed(() => items.value.find((e) => e.id === activeId.value)?.name || '')

onMounted(load)

async function load() {
  loading.value = true
  try {
    const r = await api.listEnvironments()
    items.value = r.items || []
    activeId.value = r.activeId || null
    // ★ 同步给共享状态：头部徽标读的是 envState，不是这个页面的局部 ref。
    //   不这么做的话「在页里切环境 → 头部徽标不动」—— 真机验证抓到的就是这个。
    applyEnvironments({ items: items.value, activeId: activeId.value })
  } catch (e) {
    ElMessage.error(e.response?.data?.error || '加载失败')
  } finally {
    loading.value = false
  }
}

function openNew() {
  editing.value = null
  form.value = { name: '', baseUrl: '', varsText: '', headersText: '' }
  dialogVisible.value = true
}

function openEdit(row) {
  editing.value = row
  form.value = {
    name: row.name,
    baseUrl: row.baseUrl,
    varsText: pretty(row.vars),
    headersText: pretty(row.headers),
  }
  dialogVisible.value = true
}

function pretty(obj) {
  const keys = Object.keys(obj || {})
  return keys.length ? JSON.stringify(obj, null, 2) : ''
}

// 前端只做「能不能提交」这层拦，合法性（协议、重名、JSON 形状）仍由后端判 ——
// 前端兜住体验，后端兜住正确性，两边都不越界。
function parseObj(text, label) {
  const s = String(text || '').trim()
  if (!s) return {}
  let parsed
  try {
    parsed = JSON.parse(s)
  } catch {
    throw new Error(`${label}不是合法 JSON`)
  }
  if (typeof parsed !== 'object' || parsed === null || Array.isArray(parsed)) {
    throw new Error(`${label}必须是 JSON 对象`)
  }
  return parsed
}

async function save() {
  if (!form.value.name.trim()) return ElMessage.error('环境名必填')
  if (!form.value.baseUrl.trim()) return ElMessage.error('地址必填')
  let vars
  let headers
  try {
    vars = parseObj(form.value.varsText, '环境变量')
    headers = parseObj(form.value.headersText, '默认请求头')
  } catch (e) {
    return ElMessage.error(e.message)
  }
  const payload = { name: form.value.name.trim(), baseUrl: form.value.baseUrl.trim(), vars, headers }

  saving.value = true
  try {
    if (editing.value) await api.updateEnvironment(editing.value.id, payload)
    else await api.createEnvironment(payload)
    ElMessage.success('已保存')
    dialogVisible.value = false
    await load()
  } catch (e) {
    ElMessage.error(e.response?.data?.error || '保存失败')
  } finally {
    saving.value = false
  }
}

async function activate(id) {
  try {
    await api.setActiveEnvironment(id)
    ElMessage.success('已切换当前环境')
    await load()
  } catch (e) {
    ElMessage.error(e.response?.data?.error || '切换失败')
  }
}

async function deactivate() {
  try {
    await api.setActiveEnvironment(null)
    ElMessage.success('已取消当前环境')
    await load()
  } catch (e) {
    ElMessage.error(e.response?.data?.error || '操作失败')
  }
}

async function remove(row) {
  try {
    await ElMessageBox.confirm(
      row.id === activeId.value
        ? `「${row.name}」正在使用中，删除后当前环境会被清空（用例里的 {{base}} 将取不到值）。确定删除？`
        : `确定删除环境「${row.name}」？`,
      '删除环境',
      { type: 'warning' },
    )
  } catch {
    return // 用户取消
  }
  try {
    const r = await api.deleteEnvironment(row.id)
    ElMessage.success(r.activeCleared ? '已删除，当前环境已清空' : '已删除')
    await load()
  } catch (e) {
    ElMessage.error(e.response?.data?.error || '删除失败')
  }
}
</script>

<style scoped>
.tip { margin-bottom: 14px; }
.tip-body { font-size: 12px; line-height: 1.8; color: #606266; }
.tip-body code { background: #f2f3f5; padding: 0 4px; border-radius: 3px; }
.sec { margin-bottom: 16px; }
.sec-head { display: flex; align-items: center; justify-content: space-between; }
.sec-head-right { display: flex; align-items: center; gap: 10px; }
.active-hint { font-size: 12px; color: #67c23a; }
.no-active-hint { font-size: 12px; color: #e6a23c; }
.dim { color: #c0c4cc; }
.foot { margin-top: 10px; }
</style>

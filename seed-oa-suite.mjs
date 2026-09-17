// 把「office-oa」的真实测试用例写进平台 —— 这就是「用自写测试平台测穿自写被测系统」的那一半。
//
// 设计要点（这是这份套件能拿来讲的地方）：
//  1. **一条链跑完一个业务闭环**：建单 → 提交 → 自批被拒 → 外部门经理被拒 → 本部门经理通过 → 归档后 409/403。
//     单据 id 不是写死的，而是从「建单」的响应里抽出来（extract rid=$.id）传给后面所有用例 ——
//     所以套件每跑一次都自己造数据，不依赖库里现成的单据 id。
//  2. **成对断言**：同一个「已归档单据」，审批人点 → 409、无关人员点 → 403。
//     这两个码必须分得清，否则「授权先于状态」这条设计就没被真正验证。
//  3. **断言的是语义，不是现状**：期望值全部来自 OA 的设计（403 是身份问题、409 是时序问题），
//     不是「跑一遍看它返回什么就写什么」—— 后者只能叫录播，抓不到回归。
//  4. **附件那一段真发文件（M8）**：执行器支持 bodyType=form-data + 内置夹具后，
//     「上传→列表→下载回读→魔数拦截→越权→删除」这条附件生命周期是在平台里跑完的，
//     不再是「平台发不出 multipart，这块交给被测系统自己的测试」。
//
// ⚠️ 必须先重置 office-oa 到种子态（`node seed.js --force`），否则账号/流程与断言不匹配。
// ⚠️ 跑之前 office-oa 必须**是新起进程**。踩过：端口上挂着 M2 之前的旧进程，
//    dept_scoped 和 token 黑名单看起来「失效」，其实是旧代码在回答 —— 断言会把好功能判成坏的。
//
// 运行：npm run seed:oa
import { getDb } from './src/db.js'
import { createCase } from './src/cases.js'
import { createEnvironment, listEnvironments, setActiveEnvironment, updateEnvironment } from './src/environments.js'

// 被测地址现在只活在**一处**：下面这个环境（M9）。
// 用例里一律写 {{base}}，所以「换一个被测环境」= 换这个环境对象，不用重写 44 条 URL。
const BASE = process.env.OA_BASE || 'http://127.0.0.1:3200'
const ENV_NAME = process.env.OA_ENV_NAME || 'office-oa（本地）'
const PWD = process.env.OA_PASSWORD || 'oa123456'
const TAG = 'OA-' // 用例名前缀，也是「只跑这一组」的分组标识

const json = (o) => JSON.stringify(o)
const login = (username) => ({
  method: 'POST',
  url: `{{base}}/api/auth/login`,
  headers: { 'Content-Type': 'application/json' },
  body: { username, password: PWD },
})
const auth = (tokenVar) => ({ Authorization: `Bearer {{${tokenVar}}}` })
const post = (url, tokenVar, body) => ({
  method: 'POST',
  url: `{{base}}${url}`,
  headers: { 'Content-Type': 'application/json', ...auth(tokenVar) },
  body,
})

// M8：真发 multipart/form-data（附件上传就是这条）。
//   注意**不手写 Content-Type** —— boundary 由执行器生成，手填的那个会被它覆盖；
//   这里只声明 bodyType + files，其余交给执行器（这也是「能力边界补上了」的落点）。
const upload = (url, tokenVar, files, fields = {}) => ({
  method: 'POST',
  url: `{{base}}${url}`,
  headers: { ...auth(tokenVar) },
  bodyType: 'form-data',
  body: fields,
  files,
})

const cases = [
  // ── A. 基础设施与鉴权入口 ─────────────────────────────────────────────
  {
    name: `${TAG}01 健康检查`,
    method: 'GET',
    url: `{{base}}/health`,
    expected: { status: 200, contains: 'office-oa', maxTimeMs: 1000, jsonChecks: [{ path: '$.ok', op: 'eq', value: true }] },
  },
  {
    name: `${TAG}02 未登录访问员工列表 → 401`,
    method: 'GET',
    url: `{{base}}/api/users`,
    expected: { status: 401, contains: '未登录或缺少 token' },
  },
  {
    name: `${TAG}03 伪造 token 访问 → 401`,
    method: 'GET',
    url: `{{base}}/api/users`,
    headers: { Authorization: 'Bearer fake.payload.signature' },
    expected: { status: 401, contains: 'token 无效或已过期' },
  },
  {
    // 守卫在路由之前生效：未登录时连「这个接口存不存在」都不告诉你
    name: `${TAG}04 未登录访问不存在的接口 → 401（不泄漏接口是否存在）`,
    method: 'GET',
    url: `{{base}}/api/not-exist-endpoint`,
    expected: { status: 401, contains: '未登录或缺少 token' },
  },

  // ── B. 登录与权限（纵向越权）──────────────────────────────────────────
  {
    name: `${TAG}05 管理员登录（抽出 token）`,
    ...login('admin'),
    expected: { status: 200, jsonChecks: [{ path: '$.token', op: 'exists' }, { path: '$.user.username', op: 'eq', value: 'admin' }] },
    extract: [{ name: 'token_admin', path: '$.token' }],
  },
  {
    name: `${TAG}06 密码错误 → 401（且不区分用户名/密码）`,
    method: 'POST',
    url: `{{base}}/api/auth/login`,
    headers: { 'Content-Type': 'application/json' },
    body: { username: 'admin', password: 'definitely-wrong' },
    expected: { status: 401, contains: '用户名或密码错误' },
  },
  {
    name: `${TAG}07 缺字段登录 → 400`,
    method: 'POST',
    url: `{{base}}/api/auth/login`,
    headers: { 'Content-Type': 'application/json' },
    body: {},
    expected: { status: 400, contains: '用户名和密码必填' },
  },
  {
    name: `${TAG}08 带 token 读自己的上下文`,
    method: 'GET',
    url: `{{base}}/api/me`,
    headers: auth('token_admin'),
    expected: {
      status: 200,
      jsonChecks: [
        { path: '$.username', op: 'eq', value: 'admin' },
        { path: '$.permissions', op: 'exists' },
        { path: '$.permissions[*]', op: 'contains', value: 'user:read' },
      ],
    },
  },
  {
    name: `${TAG}09 管理员读员工列表（有 user:read，放行）`,
    method: 'GET',
    url: `{{base}}/api/users`,
    headers: auth('token_admin'),
    expected: { status: 200, jsonChecks: [{ path: '$.items.length', op: 'gte', value: 8 }] },
  },
  {
    name: `${TAG}10 普通员工登录（抽出第二个 token）`,
    ...login('ops02'),
    expected: { status: 200 },
    extract: [{ name: 'token_emp', path: '$.token' }],
  },
  {
    name: `${TAG}11 普通员工读员工列表 → 403（纵向越权）`,
    method: 'GET',
    url: `{{base}}/api/users`,
    headers: auth('token_emp'),
    expected: { status: 403, contains: '缺少权限：user:read' },
  },

  // ── C. 建单 / 提交（业务链开始）──────────────────────────────────────
  {
    name: `${TAG}12 建单：不支持的类型 → 400`,
    ...post('/api/requests', 'token_emp', { type: 'not-a-type', title: 'x', formData: {} }),
    expected: { status: 400, contains: '不支持的单据类型' },
  },
  {
    name: `${TAG}13 建单：标题为空 → 400`,
    ...post('/api/requests', 'token_emp', { type: 'purchase', title: '', formData: { item: 'x', amount: 1, reason: 'r' } }),
    expected: { status: 400, contains: 'title 必填' },
  },
  {
    name: `${TAG}14 建采购单（草稿，抽出单据 id）`,
    ...post('/api/requests', 'token_emp', {
      type: 'purchase',
      title: '平台链式用例-采购申请',
      formData: { item: '测试物料', amount: 100, reason: '由 api-test-platform 自动创建' },
    }),
    expected: {
      status: 201,
      jsonChecks: [
        { path: '$.status', op: 'eq', value: 'draft' },
        { path: '$.currentStep', op: 'eq', value: 0 },
        { path: '$.applicantName', op: 'eq', value: '赵西' },
      ],
    },
    extract: [{ name: 'rid', path: '$.id' }],
  },
  {
    name: `${TAG}15 提交单据 → 进入待审（currentStep=1）`,
    method: 'POST',
    url: `{{base}}/api/requests/{{rid}}/submit`,
    headers: auth('token_emp'),
    expected: {
      status: 200,
      jsonChecks: [
        { path: '$.status', op: 'eq', value: 'pending' },
        { path: '$.currentStep', op: 'eq', value: 1 },
        { path: '$.round', op: 'eq', value: 1 },
      ],
    },
  },

  // ── D. 审批引擎：一次性把「谁不能批」全钉住 ───────────────────────────
  {
    name: `${TAG}16 申请人审批自己的单 → 403（防自批）`,
    ...post('/api/requests/{{rid}}/approve', 'token_emp', { comment: '自己批自己' }),
    expected: { status: 403, contains: '不能审批自己提交的单据' },
  },
  {
    name: `${TAG}17 外部门经理登录（抽出 token_other_mgr）`,
    ...login('exe01'),
    expected: { status: 200 },
    extract: [{ name: 'token_other_mgr', path: '$.token' }],
  },
  {
    // ★ 这条断言的就是 M2「审批人按部门收敛」：purchase 步骤 dept_scoped=1，
    //   外部门经理根本没被分配任务 → 连「跟这张单有关系」都不成立 → 403
    name: `${TAG}18 ★ 外部门经理审批本部门单据 → 403（部门收敛）`,
    ...post('/api/requests/{{rid}}/approve', 'token_other_mgr', { comment: '越部门抢批' }),
    expected: { status: 403, contains: '你不是该单据的审批人' },
  },
  {
    name: `${TAG}19 本部门经理登录（抽出 token_mgr）`,
    ...login('ops01'),
    expected: { status: 200 },
    extract: [{ name: 'token_mgr', path: '$.token' }],
  },
  {
    name: `${TAG}20 ★ 本部门经理审批 → 通过并归档`,
    ...post('/api/requests/{{rid}}/approve', 'token_mgr', { comment: '同意' }),
    expected: {
      status: 200,
      jsonChecks: [
        { path: '$.status', op: 'eq', value: 'approved' },
        { path: '$.currentStep', op: 'eq', value: 1 },
      ],
    },
  },
  {
    // ★ 与 23 成对：同一个人、同一张已归档单据，审批人得到 409
    name: `${TAG}21 ★ 归档后再审 → 409（有身份、状态不允许）`,
    ...post('/api/requests/{{rid}}/approve', 'token_mgr', { comment: '再点一次' }),
    expected: { status: 409, contains: '不可审批' },
  },
  {
    name: `${TAG}22 无关人员登录（抽出 token_hr）`,
    ...login('hr01'),
    expected: { status: 200 },
    extract: [{ name: 'token_hr', path: '$.token' }],
  },
  {
    // ★★ 与 21 成对：无关人员对**同一张已归档单据**必须拿到 403 而不是 409 ——
    //    这就是「授权先于状态」：先确认你有没有关系，再谈状态，否则 409 会变成「这单存不存在」的探针
    name: `${TAG}23 ★ 无关人员审已归档单 → 403（不是 409，授权先于状态）`,
    ...post('/api/requests/{{rid}}/approve', 'token_hr', { comment: '我是谁我在哪' }),
    expected: { status: 403, contains: '你不是该单据的审批人' },
  },
  {
    name: `${TAG}24 审批不存在的单据 → 404`,
    ...post('/api/requests/999999/approve', 'token_mgr', { comment: 'x' }),
    expected: { status: 404, contains: '单据不存在' },
  },

  // ── E. 附件与登出（M2 两个安全点）────────────────────────────────────
  {
    name: `${TAG}25 未授权下载附件 → 401`,
    method: 'GET',
    url: `{{base}}/api/attachments/1`,
    expected: { status: 401, contains: '未登录或缺少 token' },
  },
  {
    name: `${TAG}26 越权访问不存在的附件（登录但无此资源）→ 404`,
    method: 'GET',
    url: `{{base}}/api/attachments/1`,
    headers: auth('token_emp'),
    expected: { status: 404, contains: '附件不存在' },
  },
  {
    name: `${TAG}27 待登出账号登录（抽出 token_doomed）`,
    ...login('gy01'),
    expected: { status: 200 },
    extract: [{ name: 'token_doomed', path: '$.token' }],
  },
  {
    name: `${TAG}28 ★ 登出（把当前 token 作废）`,
    method: 'POST',
    url: `{{base}}/api/auth/logout`,
    headers: auth('token_doomed'),
    expected: { status: 200, jsonChecks: [{ path: '$.ok', op: 'eq', value: true }] },
  },
  {
    // ★ 与 28 成对：JWT 本来是无状态的，服务端不记「你登出过」。
    //   这一条断言的就是 M2 的 token 黑名单：登出后旧 token 必须立刻 401，而不是等 24h 过期。
    name: `${TAG}29 ★ 用已登出的 token 再访问 → 401（登出即作废）`,
    method: 'GET',
    url: `{{base}}/api/me`,
    headers: auth('token_doomed'),
    expected: { status: 401, contains: 'token 已登出' },
  },

  // ── F. 附件的「边界面」：只覆盖**不看 body** 的那几条分支（父资源先判 / 守卫在前 / 可见性）──
  // 「真正传文件」的几条放在 G 段；G 段依赖 M8 的执行器能力（bodyType=form-data + 内置夹具）。
  // F 段之所以保留：它验的是**顺序**（授权在状态前、父资源在 body 校验前），
  //   这些分支用 JSON 请求就能打出来，不依赖 multipart 能力，是执行器之外的那层防线。
  {
    name: `${TAG}30 未登录看附件列表 → 401（守卫在前，连单据存在与否都不谈）`,
    method: 'GET',
    url: `{{base}}/api/requests/1/attachments`,
    expected: { status: 401, contains: '未登录或缺少 token' },
  },
  {
    name: `${TAG}31 再建一张草稿（抽出 rid2，给附件用例当靶子）`,
    ...post('/api/requests', 'token_emp', {
      type: 'purchase',
      title: '平台链式用例-附件靶子',
      formData: { item: '附件靶子物料', amount: 1, reason: '给附件边界断言当靶子' },
    }),
    expected: { status: 201, jsonChecks: [{ path: '$.status', op: 'eq', value: 'draft' }] },
    extract: [{ name: 'rid2', path: '$.id' }],
  },
  {
    name: `${TAG}32 ★ 附件列表：申请人看自己的草稿 → 200（横向越权的正面对照）`,
    method: 'GET',
    url: `{{base}}/api/requests/{{rid2}}/attachments`,
    headers: auth('token_emp'),
    expected: { status: 200, jsonChecks: [{ path: '$.total', op: 'eq', value: 0 }] },
  },
  {
    name: `${TAG}33 ★ 附件列表：外部门经理看别人的单据 → 403（和单据详情同一道可见性）`,
    method: 'GET',
    url: `{{base}}/api/requests/{{rid2}}/attachments`,
    headers: auth('token_other_mgr'),
    expected: { status: 403, contains: '无权查看该单据' },
  },
  {
    // 顺序钉死：附件接口本身是 multipart 的，但「父资源存不存在」必须**先**判。
    //   否则一个不存在的单据会先收到「请用 multipart 上传」，等于把父资源校验让到了 body 校验后面。
    name: `${TAG}34 ★ 给不存在的单据传附件 → 404（父资源先于 body 校验）`,
    ...post('/api/requests/999999/attachments', 'token_emp', { file: 'whatever' }),
    expected: { status: 404, contains: '单据不存在' },
  },
  {
    // 单据存在、也是可编辑态，但 body 不是 multipart → 400。这条同时是**能力边界的标记**：
    //   平台能验到「非 multipart 会被挡」，但它发不出一个真正的 multipart 请求。
    name: `${TAG}35 ★ 用 JSON 上传附件 → 400（该接口只收 multipart/form-data）`,
    ...post('/api/requests/{{rid2}}/attachments', 'token_emp', { file: 'not-a-file' }),
    expected: { status: 400, contains: 'multipart/form-data' },
  },
  {
    name: `${TAG}36 ★ 删除不存在的附件 → 404`,
    method: 'DELETE',
    url: `{{base}}/api/attachments/999999`,
    headers: auth('token_emp'),
    expected: { status: 404, contains: '附件不存在' },
  },

  // ── G. 附件全生命周期（M8：执行器真发 multipart/form-data）────────────────────
  // 这一段的意义不在「又多了 8 条」，而在于：上一轮 F 段顶上写的是「平台发不出 multipart，
  //   这是能力边界」。执行器补上之后，那行字变成了 8 条真跑过的断言 ——
  //   边界是在代码里消掉的，不是在文档里改口的。
  // 两张靶子：rid2（自己的草稿，可编辑态） / rid（已归档，状态不允许）。
  {
    name: `${TAG}37 ★ 真发 multipart 上传 PNG → 201（抽 aid；mime 由服务端按字节判出）`,
    ...upload('/api/requests/{{rid2}}/attachments', 'token_emp', [{ name: 'file', fixture: 'png' }], {
      note: '平台链式用例上传的附件',
    }),
    expected: {
      status: 201,
      jsonChecks: [
        { path: '$.name', op: 'eq', value: 'fixture.png' },
        { path: '$.mime', op: 'eq', value: 'image/png' },
        { path: '$.size', op: 'eq', value: 41 },
      ],
    },
    extract: [{ name: 'aid', path: '$.id' }],
  },
  {
    name: `${TAG}38 ★ 上传后附件列表 total=1（列表和上传认的是同一条记录）`,
    method: 'GET',
    url: `{{base}}/api/requests/{{rid2}}/attachments`,
    headers: auth('token_emp'),
    expected: { status: 200, jsonChecks: [{ path: '$.total', op: 'eq', value: 1 }] },
  },
  {
    // 二进制回读：落盘名是随机 UUID、下载接口按单据可见性鉴权，所以这一条同时证明
    //   ① 字节真的落盘又原样回来 ② 下载不是「URL 猜不到就等于安全」
    name: `${TAG}39 ★ 下载刚上传的附件 → 200 且字节回读一致（contains 夹具正文）`,
    method: 'GET',
    url: `{{base}}/api/attachments/{{aid}}`,
    headers: auth('token_emp'),
    expected: { status: 200, contains: 'iVBORw0KGgo-fake-png-body-content' },
  },
  {
    name: `${TAG}40 ★ 上传伪装成 PNG 的可执行文件（MZ 头）→ 400（只认字节不认名字）`,
    ...upload('/api/requests/{{rid2}}/attachments', 'token_emp', [{ name: 'file', fixture: 'fake-exe' }]),
    expected: { status: 400, contains: '不支持的文件类型' },
  },
  {
    // ★ 与 42 成对：同一张已归档单据，申请人本人传 → 409（有身份，是状态不允许）
    name: `${TAG}41 ★ 给已归档单据传附件（本人）→ 409（只有可编辑态能增删）`,
    ...upload('/api/requests/{{rid}}/attachments', 'token_emp', [{ name: 'file', fixture: 'png' }]),
    expected: { status: 409, contains: '不允许增删附件' },
  },
  {
    // ★★ 与 41 成对：同一张单据、同一个动作，身份不对 → 必须 403 而不是 409。
    //   顺序反了（先判状态）就等于让人靠 409 探测出「这张单已归档」—— 那是信息泄漏。
    name: `${TAG}42 ★★ 给已归档单据传附件（非申请人）→ 403（不是 409，授权先于状态）`,
    ...upload('/api/requests/{{rid}}/attachments', 'token_other_mgr', [{ name: 'file', fixture: 'png' }]),
    expected: { status: 403, contains: '只有申请人本人' },
  },
  {
    name: `${TAG}43 ★ 删掉自己刚上传的附件 → 200`,
    method: 'DELETE',
    url: `{{base}}/api/attachments/{{aid}}`,
    headers: auth('token_emp'),
    expected: { status: 200, jsonChecks: [{ path: '$.ok', op: 'eq', value: true }] },
  },
  {
    name: `${TAG}44 ★ 删除后列表回到 0（记录和落盘文件一起清）`,
    method: 'GET',
    url: `{{base}}/api/requests/{{rid2}}/attachments`,
    headers: auth('token_emp'),
    expected: { status: 200, jsonChecks: [{ path: '$.total', op: 'eq', value: 0 }] },
  },

  // ── H. 站内通知（M3）：用平台把「通知子系统」也测穿 ─────────────────────
  // 这一段证明的不是「通知接口能返回 200」，而是「引擎挂钩真的在新事件上触发了」：
  //   提交流程如果忘了给审批人发通知，下面那条 unread>0 就会先红。
  {
    // ★ 提交后审批人（ops01）的未读应 > 0 —— 引擎 submit 挂钩发「待你审批」了
    name: `${TAG}45 提交后审批人未读数 > 0（挂钩真的触发）`,
    method: 'GET',
    url: `{{base}}/api/notifications/unread-count`,
    headers: auth('token_mgr'),
    expected: { status: 200, jsonChecks: [{ path: '$.unread', op: 'gte', value: 1 }] },
  },
  {
    // ★ 审批人收件箱最新一条就是本单的 task_assigned，且未读（抽 id 给越权用例用）
    name: `${TAG}46 审批人通知列表含本单 task（抽 nid_task）`,
    method: 'GET',
    url: `{{base}}/api/notifications`,
    headers: auth('token_mgr'),
    expected: {
      status: 200,
      jsonChecks: [
        { path: '$.items[0].type', op: 'eq', value: 'task' },
        { path: '$.items[0].title', op: 'contains', value: '平台链式用例-采购申请' },
        { path: '$.items[0].read', op: 'eq', value: false },
      ],
    },
    extract: [{ name: 'nid_task', path: '$.items[0].id' }],
  },
  {
    // ★ 归档后申请人（ops02）收到「已通过」，且 round=1 是事件发生时的快照（抽 id 给标已读用例）
    name: `${TAG}47 归档后申请人收到已通过通知（round=1 快照，抽 nid_approved）`,
    method: 'GET',
    url: `{{base}}/api/notifications`,
    headers: auth('token_emp'),
    expected: {
      status: 200,
      jsonChecks: [
        { path: '$.items[0].type', op: 'eq', value: 'approved' },
        { path: '$.items[0].title', op: 'contains', value: '平台链式用例-采购申请' },
        { path: '$.items[0].round', op: 'eq', value: 1 },
      ],
    },
    extract: [{ name: 'nid_approved', path: '$.items[0].id' }],
  },
  {
    // ★ 收件人隔离：外部门经理（exe01）收件箱应为空 —— 不是靠前端过滤
    name: `${TAG}48 外部门经理收件箱为空（收件人隔离）`,
    method: 'GET',
    url: `{{base}}/api/notifications`,
    headers: auth('token_other_mgr'),
    expected: { status: 200, jsonChecks: [{ path: '$.items.length', op: 'eq', value: 0 }] },
  },
  {
    // ★ 标已读：返回 read=true，且 unread 重算为 0（角标不会多算）
    name: `${TAG}49 标记已通过通知为已读 → 200 且 unread 归零`,
    method: 'POST',
    url: `{{base}}/api/notifications/{{nid_approved}}/read`,
    headers: auth('token_emp'),
    expected: {
      status: 200,
      jsonChecks: [
        { path: '$.read', op: 'eq', value: true },
        { path: '$.unread', op: 'eq', value: 0 },
      ],
    },
  },
  {
    // ★ 已读幂等：再标一次仍 200，changed=false（不是 409/500）
    name: `${TAG}50 重复标已读 → 200（幂等，changed=false）`,
    method: 'POST',
    url: `{{base}}/api/notifications/{{nid_approved}}/read`,
    headers: auth('token_emp'),
    expected: {
      status: 200,
      jsonChecks: [
        { path: '$.read', op: 'eq', value: true },
        { path: '$.changed', op: 'eq', value: false },
      ],
    },
  },
  {
    // ★★ 写路径隔离：用别人的 token 标我的通知 → 404（和「不存在」同一口径，不泄漏存在性）
    name: `${TAG}51 他人 token 标我的通知 → 404（授权先于状态）`,
    method: 'POST',
    url: `{{base}}/api/notifications/{{nid_approved}}/read`,
    headers: auth('token_other_mgr'),
    expected: { status: 404, contains: '通知不存在' },
  },
  {
    // ★ 反向也拦：申请人标审批人的通知 → 404
    name: `${TAG}52 申请人标审批人通知 → 404（收件人隔离）`,
    method: 'POST',
    url: `{{base}}/api/notifications/{{nid_task}}/read`,
    headers: auth('token_emp'),
    expected: { status: 404, contains: '通知不存在' },
  },
]

// ── M12：按 OA-NN 编号给每条用例打上业务分组标签 ───────────────────────
// 分组用于平台的「列表筛选 / 按组运行 / 报告按组看通过率」。一个平台里常挂多个被测系统的用例，
// 这里把 OA 这 52 条按业务主题收成 8 组（A 入口鉴权 → H 站内通知）。
// 用编号映射而非按数组下标切，是因为各段条数以后可能微调，而「OA-18 属于审批引擎」这条事实不会变。
function groupOf(name) {
  const m = String(name).match(/OA-(\d+)/)
  if (!m) return ''
  const n = Number(m[1])
  if (n <= 4) return '入口鉴权'
  if (n <= 11) return '登录权限'
  if (n <= 15) return '建单提交'
  if (n <= 24) return '审批引擎'
  if (n <= 29) return '登出令牌'
  if (n <= 36) return '附件边界'
  if (n <= 44) return '附件全周期'
  return '站内通知'
}
for (const c of cases) c.group = groupOf(c.name)

// —— 幂等写入：先清掉上一版 OA- 用例（连带定时任务），再按顺序插入 ——
const db = getDb()
db.prepare(`DELETE FROM schedules WHERE case_id IN (SELECT id FROM test_cases WHERE name LIKE ?)`).run(`${TAG}%`)
const removed = db.prepare(`DELETE FROM test_cases WHERE name LIKE ?`).run(`${TAG}%`).changes

// —— 环境变量集（M9）：被测地址只定义在这里，并设为「当前环境」——
// 幂等：同名环境已存在就更新地址（比如换了端口），不重复建。
const existingEnv = listEnvironments().find((e) => e.name === ENV_NAME)
const env = existingEnv
  ? updateEnvironment(existingEnv.id, { baseUrl: BASE })
  : createEnvironment({ name: ENV_NAME, baseUrl: BASE })
setActiveEnvironment(env.id)

for (const c of cases) createCase(c)

console.log(`[oa-suite] 当前环境「${ENV_NAME}」→ ${env.baseUrl}（用例里写 {{base}}，换环境不用改用例）`)
console.log(`[oa-suite] 已写入 OA 用例 ${cases.length} 条（清理旧用例 ${removed} 条）`)
console.log(`[oa-suite] 分组标签（M12）：入口鉴权/登录权限/建单提交/审批引擎/登出令牌/附件边界/附件全周期/站内通知`)
console.log(`[oa-suite] 用例链顺序即创建顺序：登录抽 token → 建单抽 id → 审批 → 登出作废`)
console.log(`[oa-suite] 跑法：npm run test:oa   （等价于 POST /api/run-all {"prefix":"${TAG}"}）`)
console.log(`[oa-suite] 示例断言：${TAG}18 部门收敛 / ${TAG}23 授权先于状态 / ${TAG}29 登出即作废 / ${TAG}42 附件越权先于状态 / ${TAG}45 引擎挂钩发通知 / ${TAG}47 通知 round 快照 / ${TAG}51 通知写路径 404`)

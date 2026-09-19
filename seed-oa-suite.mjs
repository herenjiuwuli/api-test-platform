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

// M4：导出注入用例的「坏输入」—— 标题本身就是一个 CSV 公式载荷。
// 真实威胁不是「我这条单显示难看」，而是：这条单被导出成 CSV、审批人用 Excel 打开，
// 就在**审批人的机器上**执行了申请人写的东西。
const INJECT_TITLE = "=cmd|'/c calc'!A1"

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

  // ── I. 导出 CSV（M4）：闭环里第一次「被测系统倒逼工具长能力」────────────────
  // 这一段不是「再加几条用例」，而是平台的能力边界被顶出来了：
  //   ① expected 原来只有 status / contains / maxTimeMs / jsonChecks —— **断言不了响应头**；
  //   ② `res.text()` 按 Fetch 规范会吃掉响应体开头的 BOM，所以「导出有没有带 BOM」也断言不了。
  // 两条这一轮都补掉了（api-test-platform M14）。闭环的意义就在这：SUT 长出新面，
  // 工具跟着长出新的断言能力 —— 而不是「验证不了就换个方式糊过去」。
  {
    // ★ 先造一条「标题就是 CSV 公式载荷」的采购申请 —— 注入防护需要一个真实的坏输入
    name: `${TAG}53 建一条标题为公式载荷的采购申请（抽 rid_inject）`,
    ...post('/api/requests', 'token_emp', {
      type: 'purchase',
      title: INJECT_TITLE,
      formData: { item: '一次性雨衣 100 件', amount: 300, reason: '导出注入用例' },
    }),
    expected: { status: 201, jsonChecks: [{ path: '$.title', op: 'eq', value: INJECT_TITLE }] },
    extract: [{ name: 'rid_inject', path: '$.id' }],
  },
  {
    name: `${TAG}54 提交这条载荷单 → 200`,
    ...post('/api/requests/{{rid_inject}}/submit', 'token_emp', {}),
    expected: { status: 200, jsonChecks: [{ path: '$.status', op: 'eq', value: 'pending' }] },
  },
  {
    // ⭐ 头断言（M14 新能力）：导出必须是 text/csv
    //   用 contains 而不是 eq：服务端回的是 `text/csv; charset=utf-8`，
    //   写 eq 'text/csv' 会红 —— 而「该写 eq 还是 contains」本身就是断言设计的取舍题
    name: `${TAG}55 导出：Content-Type 含 text/csv（⭐头断言）`,
    method: 'GET',
    url: `{{base}}/api/requests/export.csv`,
    headers: auth('token_emp'),
    expected: {
      status: 200,
      headers: [{ name: 'content-type', op: 'contains', value: 'text/csv' }],
    },
  },
  {
    // ⭐ 头断言：必须是「附件下载」，且文件名来自服务端（前端不自己编名字）
    name: `${TAG}56 导出：Content-Disposition 是 attachment + 带文件名（⭐头断言）`,
    method: 'GET',
    url: `{{base}}/api/requests/export.csv`,
    headers: auth('token_emp'),
    expected: {
      status: 200,
      headers: [
        { name: 'Content-Disposition', op: 'contains', value: 'attachment' },
        { name: 'Content-Disposition', op: 'contains', value: 'filename="requests-' },
      ],
    },
  },
  {
    // ⭐⭐ BOM：以前这条**写不出来** —— Fetch 的 text() 会把 BOM 吃掉，看什么都是「没有 BOM」。
    //    现在执行器自己按字节解码，BOM 就留在 text 里了。
    //    顺带把表头顺序也钉住：`\ufeff单据号,类型,标题` 这一段连着断言，一次证明两件事。
    name: `${TAG}57 导出体以 UTF-8 BOM 开头，且首行是表头（⭐⭐BOM 断言）`,
    method: 'GET',
    url: `{{base}}/api/requests/export.csv`,
    headers: auth('token_emp'),
    expected: { status: 200, contains: '\ufeff单据号,类型,标题,申请人' },
  },
  {
    // ⭐⭐ 公式注入：标题里的 `=cmd|...` 到了 CSV 里必须**带单引号前缀**（Excel 才会当文本）。
    //    反证（「不能出现裸公式」）平台现在还表达不了 —— 断言模型只有正向断言，没有 notContains。
    //    所以那半边靠 office-oa 自己的单测（tests/export.test.js）兜底。
    name: `${TAG}58 导出：载荷标题被加前缀，Excel 不会执行（⭐⭐公式注入）`,
    method: 'GET',
    url: `{{base}}/api/requests/export.csv?status=pending`,
    headers: auth('token_emp'),
    expected: { status: 200, contains: `'${INJECT_TITLE}` },
  },
  {
    // ⭐ 数据范围（正向表达）：有 request:read:all 的角色能导出到**别人**的单据。
    //    用「链上那条采购申请」当探针 —— 它不是 ops02 提的，只有全量范围才看得到。
    name: `${TAG}59 管理员导出能看到别人的单据（request:read:all 生效）`,
    method: 'GET',
    url: `{{base}}/api/requests/export.csv`,
    headers: auth('token_admin'),
    expected: { status: 200, contains: '平台链式用例-采购申请' },
  },
  {
    // ⭐ 数据范围的反面，用**正向**方式表达：外部门经理（没有 read:all）一条都导不到。
    //    为什么用 X-Total-Count 而不是「不含某某」：断言模型没有负向断言，
    //    而「条数恰好是 0」本身就是「一条别人的都没给」的等价说法，且能被正向断言钉住。
    name: `${TAG}60 无全量权限的经理导出 0 条（数据范围收敛）`,
    method: 'GET',
    url: `{{base}}/api/requests/export.csv`,
    headers: auth('token_other_mgr'),
    expected: {
      status: 200,
      headers: [{ name: 'X-Total-Count', op: 'eq', value: '0' }],
    },
  },

  // ── J. 会议室预订（OA M5）────────────────────────────────────
  // ⭐ 这一段的靶子是「时段冲突的防线在哪一层」：同一时段订两次必须 409、
  //    部分重叠也算冲突、取消后同时段能重订（证明占用槽真的被释放，不是只改状态）。
  // 日期用**固定远期**（2027-06-01）：平台用例是静态 body，拿不到「明天」，
  // 而过去时段会被 400 拒 —— 固定一个足够远的日期，套件什么时候跑都成立。
  {
    name: `${TAG}61 会议室列表：至少 4 间且停用排最后`,
    method: 'GET',
    url: `{{base}}/api/meeting-rooms`,
    headers: auth('token_emp'),
    expected: {
      status: 200,
      jsonChecks: [
        { path: '$.total', op: 'gte', value: 4 },
        { path: '$.items[3].status', op: 'eq', value: 'disabled' },
      ],
    },
  },
  {
    name: `${TAG}62 预订成功 → 201（抽预订 id 供后续取消）`,
    ...post('/api/room-bookings', 'token_emp', {
      roomId: 1, date: '2027-06-01', startTime: '09:00', endTime: '10:00', title: '平台链路测试会',
    }),
    expected: { status: 201, jsonChecks: [{ path: '$.status', op: 'eq', value: 'booked' }] },
    extract: [{ name: 'bid1', path: '$.id' }],
  },
  {
    name: `${TAG}63 ★ 同一时段订两次 → 409，且错误里写明被谁占了哪一段`,
    ...post('/api/room-bookings', 'token_emp', {
      roomId: 1, date: '2027-06-01', startTime: '09:00', endTime: '10:00', title: '抢占',
    }),
    expected: { status: 409, contains: '已被占用' },
  },
  {
    name: `${TAG}64 ★ 部分重叠（09:30–10:30 撞 09:00–10:00）→ 409`,
    ...post('/api/room-bookings', 'token_emp', {
      roomId: 1, date: '2027-06-01', startTime: '09:30', endTime: '10:30', title: '半个重叠',
    }),
    expected: { status: 409 },
  },
  {
    name: `${TAG}65 时间不对齐半点（09:15）→ 400`,
    ...post('/api/room-bookings', 'token_emp', {
      roomId: 1, date: '2027-06-01', startTime: '09:15', endTime: '10:00', title: '不对齐',
    }),
    expected: { status: 400, contains: '整点或半点' },
  },
  {
    name: `${TAG}66 停用的会议室不能订 → 400`,
    ...post('/api/room-bookings', 'token_emp', {
      roomId: 4, date: '2027-06-01', startTime: '09:00', endTime: '10:00', title: '订停用房',
    }),
    expected: { status: 400, contains: '停用' },
  },
  {
    name: `${TAG}67 单次超 4 小时 → 400（防占满一整天）`,
    ...post('/api/room-bookings', 'token_emp', {
      roomId: 1, date: '2027-06-01', startTime: '08:00', endTime: '13:00', title: '占半天',
    }),
    expected: { status: 400, contains: '4 小时' },
  },
  {
    name: `${TAG}68 admin 订一间（造一条「别人的预订」供越权取消用）`,
    ...post('/api/room-bookings', 'token_admin', {
      roomId: 3, date: '2027-06-02', startTime: '15:00', endTime: '15:30', title: '经理碰头',
    }),
    expected: { status: 201 },
    extract: [{ name: 'bid_admin', path: '$.id' }],
  },
  {
    name: `${TAG}69 ★ 横向越权：普通员工取消别人的预订 → 403`,
    method: 'DELETE',
    url: `{{base}}/api/room-bookings/{{bid_admin}}`,
    headers: auth('token_emp'),
    expected: { status: 403, contains: '只能取消自己的预订' },
  },
  {
    name: `${TAG}70 本人取消 → 200`,
    method: 'DELETE',
    url: `{{base}}/api/room-bookings/{{bid1}}`,
    headers: auth('token_emp'),
    expected: { status: 200, jsonChecks: [{ path: '$.status', op: 'eq', value: 'cancelled' }] },
  },
  {
    name: `${TAG}71 ★ 取消后同时段可重订（占用槽真的被释放，不是只改状态）`,
    ...post('/api/room-bookings', 'token_emp', {
      roomId: 1, date: '2027-06-01', startTime: '09:00', endTime: '10:00', title: '释放后再订',
    }),
    expected: { status: 201 },
    extract: [{ name: 'bid2', path: '$.id' }],
  },
  {
    name: `${TAG}72 收尾：取消 71 留下的预订（套件不留测试数据）`,
    method: 'DELETE',
    url: `{{base}}/api/room-bookings/{{bid2}}`,
    headers: auth('token_emp'),
    expected: { status: 200 },
  },

  // ── K. 统计报表（OA M6）──────────────────────────────────────
  // 靶子是聚合接口的「数据范围权限」：单据详情的越权面是「一行」，
  // 统计的越权面是「一批」—— 员工反复按状态请求就能拼出全公司组织画像。
  // scope 超出自己最高可用范围必须 403（静默降级会让错误结论无法察觉）。
  {
    name: `${TAG}73 员工默认统计：scope 落在 mine`,
    method: 'GET',
    url: `{{base}}/api/stats/overview`,
    headers: auth('token_emp'),
    expected: {
      status: 200,
      jsonChecks: [
        { path: '$.scope', op: 'eq', value: 'mine' },
        { path: '$.maxScope', op: 'eq', value: 'mine' },
      ],
    },
  },
  {
    name: `${TAG}74 ★ 员工请求 scope=all → 403（聚合接口不静默降级）`,
    method: 'GET',
    url: `{{base}}/api/stats/overview`,
    headers: auth('token_emp'),
    query: { scope: 'all' },
    expected: { status: 403, contains: 'mine' },
  },
  {
    name: `${TAG}75 经理可用本部门范围（dept）`,
    method: 'GET',
    url: `{{base}}/api/stats/overview`,
    headers: auth('token_other_mgr'),
    query: { scope: 'dept' },
    expected: { status: 200, jsonChecks: [{ path: '$.scope', op: 'eq', value: 'dept' }] },
  },
  {
    name: `${TAG}76 经理请求 all 仍 → 403（request:read:all 才是全公司钥匙）`,
    method: 'GET',
    url: `{{base}}/api/stats/overview`,
    headers: auth('token_other_mgr'),
    query: { scope: 'all' },
    expected: { status: 403 },
  },
  {
    name: `${TAG}77 admin 全公司统计：状态分布之和 == 总数（分项自洽）`,
    method: 'GET',
    url: `{{base}}/api/stats/overview`,
    headers: auth('token_admin'),
    query: { scope: 'all' },
    expected: {
      status: 200,
      jsonChecks: [
        { path: '$.scope', op: 'eq', value: 'all' },
        { path: '$.requests.total', op: 'gte', value: 3 },
        { path: '$.monthly', op: 'exists' },
        { path: '$.efficiency.archivedCount', op: 'gte', value: 1 },
      ],
    },
  },
  {
    name: `${TAG}78 未登录拉统计 → 401`,
    method: 'GET',
    url: `{{base}}/api/stats/overview`,
    expected: { status: 401 },
  },
]

// ── M12：按 OA-NN 编号给每条用例打上业务分组标签 ───────────────────────
// 分组用于平台的「列表筛选 / 按组运行 / 报告按组看通过率」。一个平台里常挂多个被测系统的用例，
// 这里把 OA 这 72 条按业务主题收成 10 组（A 入口鉴权 → J 会议室）。
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
  if (n <= 52) return '站内通知'
  if (n <= 60) return '导出'
  if (n <= 72) return '会议室'
  return '统计'
}
for (const c of cases) c.group = groupOf(c.name)

// —— 幂等写入：先清掉上一版 OA- 用例（连带定时任务与执行记录），再按顺序插入 ——
// ⚠️ 执行记录必须一起清理：`runs.case_id` 不是外键，只删用例的话每重新 seed 一次就留一批孤儿，
//    报告里会冒出一堆无名的「用例#id」（本机实测积到 791 条）。
//    顺序有讲究：先 schedules、再 runs、最后 cases —— 后两步都靠子查询找到「待删用例」。
const db = getDb()
db.prepare(`DELETE FROM schedules WHERE case_id IN (SELECT id FROM test_cases WHERE name LIKE ?)`).run(`${TAG}%`)
const removedRuns = db.prepare(`DELETE FROM runs WHERE case_id IN (SELECT id FROM test_cases WHERE name LIKE ?)`).run(`${TAG}%`).changes
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
console.log(`[oa-suite] 已写入 OA 用例 ${cases.length} 条（清理旧用例 ${removed} 条、旧执行记录 ${removedRuns} 条）`)
console.log(`[oa-suite] 分组标签（M12）：入口鉴权/登录权限/建单提交/审批引擎/登出令牌/附件边界/附件全周期/站内通知/导出/会议室`)
console.log(`[oa-suite] 用例链顺序即创建顺序：登录抽 token → 建单抽 id → 审批 → 登出作废`)
console.log(`[oa-suite] 跑法：npm run test:oa   （等价于 POST /api/run-all {"prefix":"${TAG}"}）`)
console.log(`[oa-suite] 示例断言：${TAG}18 部门收敛 / ${TAG}23 授权先于状态 / ${TAG}29 登出即作废 / ${TAG}42 附件越权先于状态 / ${TAG}45 引擎挂钩发通知 / ${TAG}47 通知 round 快照 / ${TAG}55 导出的 Content-Type（头断言） / ${TAG}57 BOM / ${TAG}58 CSV 公式注入`)

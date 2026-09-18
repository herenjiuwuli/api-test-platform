// M13 · 截图导览（给「平台长什么样」留一组可复看的图）
//
// 为什么单独一个脚本：m9~m12 的产物是「断言通过/失败」，这个的产物是**人看的图**。
// 产物性质不同，就别硬塞进已有的断言脚本里——否则以后想只跑截图也得连断言一起跑。
//
// 走一遍主链路（用例列表 → 用例链运行 → 编辑器 → 报告 → 定时任务/通知 → 环境 → 移动端），
// 每步存一张 PNG，同时把「页面真的渲染出业务内容」当断言跑。
// 截图落在 shots/（已 gitignore）。
// ⚠️ 刻意不放 test-results/：那边 Playwright 每次启动都会清空 —— 截图放那儿会被下次 E2E 顺手删掉。
//
// 用法：
//   node scripts/m13-shot-tour.mjs                 # 默认打 http://127.0.0.1:3001
//   ATP_BASE=http://localhost:3001 node scripts/m13-shot-tour.mjs
//   SKIP_RUN=1 node scripts/m13-shot-tour.mjs      # 跳过「全部运行」（改脚本时反复调试用）
//   TOUR_TIMEOUT_MS=300000 node ...                # 改看门狗阈值（默认 8 分钟）
//
// ⚠️ 两条「不留副作用」的硬规矩（都是踩出来才补的，别删）：
//   1. 收尾删除必须写在 finally + 看门狗里，不能只写在正常路径末尾 —— 中途挂死会把临时用例
//      和「每分钟触发」的定时任务留在主人的库里，而且无人看管时它会一直触发。
//   2. CDP 的每次调用都必须有超时（见 lib/cdp.mjs 的 send）—— 否则超时循环是假超时。

import fs from 'node:fs'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import { withBrowser, checks, PAGE_HELPERS, tempPlatformToken, loginByToken, sleep } from './lib/cdp.mjs'

const BASE = process.env.ATP_BASE || 'http://127.0.0.1:3001'
const OUT = path.resolve(fileURLToPath(new URL('../shots', import.meta.url)))

const c = checks()

async function main() {
  fs.rmSync(OUT, { recursive: true, force: true })
  fs.mkdirSync(OUT, { recursive: true })
  console.log(`目标 ${BASE}  →  截图目录 ${OUT}\n`)

  // 只打印状态码/长度，绝不打印 token 本身
  const { token } = await tempPlatformToken(BASE, 'tour')

  // ⚠️ 两套头要分开：有 body 的请求才带 Content-Type。
  // 空 body 却带 `Content-Type: application/json` → Fastify 直接 400 FST_ERR_CTP_EMPTY_JSON_BODY，
  // 而「删除成功」的调用可能不报错、只是悄悄没删掉 —— 这个坑在 cdp-browser-check skill 里记过一条，我又踩了一次。
  const authOnly = { Authorization: 'Bearer ' + token }
  const authHeaders = { ...authOnly, 'Content-Type': 'application/json' }

  // ── 副作用收尾 ────────────────────────────────────────────────
  // ⭐ 本次运行建的临时对象（必红用例 / 定时任务）必须删掉，而且**必须放在 finally + 看门狗里**。
  //    教训：清理只写在「正常路径末尾」= 脚本中途一挂就全留着。实测代价（2026-09-18）：
  //    脚本在一次 eval 上挂死 3 小时 31 分，库里留了一个 TEMP 用例 + 一个「每分钟触发」的定时任务，
  //    那个定时任务在无人看管下一直跑、一直在攒通知。
  //    cleanup 只用 HTTP API，不碰浏览器 —— 这样浏览器已经卡死时它照样能干活。
  const created = { caseId: null, schId: null }
  const listOf = async (path) => {
    const r = await fetch(BASE + path, { headers: authOnly })
    const j = await r.json().catch(() => [])
    return j.items || j || []
  }
  // 清掉历史残留的 TEMP-*（上次挂死留下的脏数据）。运行前 + 收尾各调一次 ——
  // 运行前调是为了让「全部运行」的汇总不被上轮的临时用例污染（否则会看到 73/74 而不是 73/73）。
  const sweepTemps = async () => {
    const schs = (await listOf('/api/schedules')).filter((x) => /^TEMP-/.test(x.caseName || x.name || ''))
    for (const s of schs) {
      await fetch(`${BASE}/api/schedules/${s.id}`, { method: 'DELETE', headers: authOnly }).catch(() => {})
      console.log(`  INFO  清掉残留的临时定时任务 #${s.id}`)
    }
    const cases = (await listOf('/api/cases')).filter((x) => /^TEMP-/.test(x.name || ''))
    for (const s of cases) {
      await fetch(`${BASE}/api/cases/${s.id}`, { method: 'DELETE', headers: authOnly }).catch(() => {})
      console.log(`  INFO  清掉残留的临时用例 #${s.id}`)
    }
  }

  const cleanup = async (why) => {
    const jobs = []
    if (created.schId) jobs.push(['schedules', created.schId, '收尾删掉临时定时任务（不留副作用）'])
    if (created.caseId) jobs.push(['cases', created.caseId, '收尾删掉临时必红用例（不留副作用）'])
    for (const [kind, id, label] of jobs) {
      let ok = false
      try {
        ok = (await fetch(`${BASE}/api/${kind}/${id}`, { method: 'DELETE', headers: authOnly })).ok
      } catch {}
      const still = (await listOf(`/api/${kind}`)).some((x) => x.id === id)
      c.check(label, ok && !still, `${why} · 删除=${ok} 仍在=${still}`)
      if (!still) {
        if (kind === 'schedules') created.schId = null
        else created.caseId = null
      }
    }
    // 兜底：任何历史残留的 TEMP- 一并清掉（上一次挂死留下的，靠这次运行自愈）
    await sweepTemps()
  }

  // ⭐ 看门狗：无人值守时脚本绝不能「挂着不动」。到点就收尾 + 强制退出，别让半个进程占着 Chrome 和端口。
  const WATCHDOG_MS = Number(process.env.TOUR_TIMEOUT_MS || 8 * 60 * 1000)
  const watchdog = setTimeout(async () => {
    console.error(`\n⚠️  导览总时长超过 ${Math.round(WATCHDOG_MS / 1000)} 秒，判定卡死 —— 看门狗收尾后强制退出`)
    try { await cleanup('看门狗兜底') } catch (e) { console.error('  看门狗清理失败：', e.message) }
    process.exit(2)
  }, WATCHDOG_MS)
  watchdog.unref?.()

  let failure = null
  try {
    await withBrowser(async (cdp) => {
    // ⭐ 先装「观测脚本」（必须在目标文档的任何页面脚本之前执行 → addScriptToEvaluateOnNewDocument）。
    // 为什么：**别拿瞬时的 toast 当断言判据**。ElMessage 只活 4 秒，靠轮询去撞它必然时中时不中
    //（实测：同一份脚本第一次跑抓到了 toast、第二次没抓到 → 这种断言就是 flake 制造机）。
    // 改成记录两个**确定性**事实：① EventSource 真收到了几帧 notification；② body 里挂过几次 .el-message。
    // 抓帧只看事实，截图仍求「好看」——两者分开，脚本才可重复运行。
    await cdp.send('Page.addScriptToEvaluateOnNewDocument', {
      source: `(() => {
        window.__sseLog = [];
        window.__toastLog = [];
        window.__addLog = [];
        const Orig = window.EventSource;
        if (Orig) {
          const W = function (...a) {
            const es = new Orig(...a);
            es.addEventListener('message', (ev) => { try { window.__sseLog.push(String(ev.data)); } catch {} });
            return es;
          };
          W.prototype = Orig.prototype;
          window.EventSource = W;
        }
        new MutationObserver((ms) => {
          for (const m of ms) for (const n of m.addedNodes) {
            if (n.nodeType !== 1) continue;
            const cls = String(n.className || '');
            if (window.__addLog.length < 60) window.__addLog.push(cls);
            if (n.classList && n.classList.contains('el-message')) {
              window.__toastLog.push({ t: Date.now(), text: (n.innerText || '').trim() });
            }
          }
        }).observe(document.documentElement || document, { childList: true, subtree: true });
      })();`,
    })

    const inject = () => cdp.eval(PAGE_HELPERS)
    /** 导航 + 注入页面工具 + 等业务就绪（不等 load 事件，SPA 里它早于渲染完成） */
    const go = async (hash, readyExpr, label) => {
      await cdp.nav(BASE + hash)
      await inject()
      await cdp.waitFor(readyExpr, label)
      await sleep(400) // 留给过渡动画，否则截到半透明的中间态
    }
    const shot = async (name) => {
      const r = await cdp.send('Page.captureScreenshot', { format: 'png' })
      fs.writeFileSync(path.join(OUT, name), Buffer.from(r.data, 'base64'))
      console.log(`  📷 ${name}`)
    }
    const esc = async () => {
      await cdp.send('Input.dispatchKeyEvent', { type: 'keyDown', key: 'Escape', code: 'Escape', windowsVirtualKeyCode: 27 })
      await cdp.send('Input.dispatchKeyEvent', { type: 'keyUp', key: 'Escape', code: 'Escape', windowsVirtualKeyCode: 27 })
      await sleep(400)
    }
    const scrollTo = async (text) => {
      await cdp.eval(`(() => {
        const h = [...document.querySelectorAll('.el-card__header')].find(e => e.innerText.includes(${JSON.stringify(text)}));
        if (h) h.scrollIntoView({ block: 'start' });
        else window.scrollTo(0, document.body.scrollHeight);
        return 'ok';
      })()`)
      await sleep(500)
    }

    // ── 0. 登录（现场注册临时账号，不碰任何既有凭据）──────────────
    await loginByToken(cdp, BASE, token, { key: 'atp_token' })
    console.log('已登录（临时账号，不碰既有凭据）\n')

    // ⭐ 第一件事：清掉上轮可能残留的临时对象，保证「全部运行」的汇总是在干净库上跑出来的。
    //    这一步曾经写在「全部运行」之后（顺序反了），一旦上轮挂死留了条必红临时用例，
    //    这轮的汇总就变成 73/74，看着像平台坏了、其实是自己的脏数据。
    await sweepTemps()

    // ── 1. 用例列表 ────────────────────────────────────────────
    await go('/#/', "document.querySelectorAll('tbody tr').length > 0", '用例列表加载')
    const rowCount = await cdp.eval("document.querySelectorAll('tbody tr').length")
    c.check('用例列表渲染出数据行', rowCount > 0, `${rowCount} 行`)

    // 顶栏别被文案挤换行 —— 这是真实踩过的回归：把副标题从 M18 改到 M21、多写了几个字，
    // 「API 自动化测试平台」就被挤成两行了。凡是改顶栏/导航文案，这条会拦住。
    const head = await cdp.eval(`(() => {
      const n = document.querySelector('.brand-name');
      const s = document.querySelector('.brand-sub');
      const h = document.querySelector('.app-header');
      const cs = getComputedStyle(n);
      const lineH = parseFloat(cs.lineHeight) || parseFloat(cs.fontSize) * 1.2;
      return {
        nameH: Math.round(n.getBoundingClientRect().height),
        lineH: Math.round(lineH),
        headerH: h ? Math.round(h.getBoundingClientRect().height) : -1,
        subClipped: s ? s.scrollWidth > s.clientWidth + 1 : false,
      };
    })()`)
    c.check(
      '顶栏单行（品牌名没被文案挤断）',
      head.nameH <= head.lineH * 1.4,
      `品牌名高 ${head.nameH}px / 行高 ${head.lineH}px；顶栏高 ${head.headerH}px${head.subClipped ? '；副标题已截断' : ''}`,
    )
    await shot('01-用例列表.png')

    // ── 2. 跑整条链（不是单条）──────────────────────────────────
    // 单跑一条会必红：用例之间靠 {{token_xxx}} 传值，变量袋是空的。
    // 「全部运行」才是这个平台的主能力，导览就该展示它。
    if (process.env.SKIP_RUN === '1') {
      console.log('  (SKIP_RUN=1：跳过「全部运行」，沿用上一轮截图)')
    } else {
      const clicked = await cdp.eval("window.__h.click('全部运行')")
      c.check('能点到「全部运行」', clicked === 'CLICKED', clicked)
      // ⚠️ 这个弹窗是**跑完之后**才挂上 DOM 的（CaseList 里 `allVisible=true` 写在 `await api.runAll()` 之后），
      //    所以这里的等待时长要覆盖「全库用例串行跑一遍」的耗时，不是 UI 渲染耗时。
      //    曾经写 20s —— 本机 74 条跑到 20 秒出头，直接假失败（看着像平台坏了，其实是我自己的计时太紧）。
      await cdp.waitFor(
        "(document.querySelector('.el-dialog__title')||{}).innerText === '全部运行汇总'",
        '全部运行汇总内容',
        180000,
      )
      const dialogText = await cdp.eval("document.querySelector('.el-dialog').innerText")
      c.check('汇总弹窗带出逐条结论', /通过|失败/.test(dialogText), dialogText.replace(/\n/g, ' | ').slice(0, 70))
      await shot('02-用例链运行汇总.png')
      await esc()
    }

    // ── 3. 用例编辑器 ──────────────────────────────────────────
    await go('/#/cases/new', "document.body.innerText.includes('新建用例') || document.querySelectorAll('input').length > 3", '用例编辑器')
    await shot('03-用例编辑器.png')

    // ── 4. 报告：环境/分组汇总 + 通知出口 ────────────────────────
    await go('/#/reports', "document.querySelectorAll('tbody tr').length > 0", '报告页加载')
    c.check('报告页有汇总明细', (await cdp.eval("document.querySelectorAll('tbody tr').length")) > 0)
    await shot('04-报告-环境与分组汇总.png')

    c.check('报告页有「通知出口」卡片（M21）', await cdp.eval("document.body.innerText.includes('通知出口')"))
    await scrollTo('通知出口')
    await shot('05-报告-通知出口.png')

    // ── 5. 定时任务 + 通知链路 ──────────────────────────────────
    // 为什么不直接点铃铛截图：手动「全部运行」**不落通知**（M17 的设计：只有定时任务才落），
    // 直接截只能截到「暂无通知」的空态。要看到真通知，就得让定时任务自己跑一次。
    //
    // ⭐ 演示用的「必红用例」由脚本**自己建、自己删**，不从库里挑。
    //    曾经的做法是「找一条 expected.status===405 的用例」——依赖库里恰好有一条红的，
    //    后来那条期望被修正成 404（Fastify 的真实语义），脚本立刻失效。
    //    现在改成建一条 期望 599（不可能出现的状态码）的临时用例 → 在任何库上都必然红，
    //    且收尾会删掉它，不给主人的库留垃圾。
    // 前置清理见脚本开头（sweepTemps 在「全部运行」之前就调过了）——这里不再重复扫。

    const mkBad = await fetch(BASE + '/api/cases', {
      method: 'POST',
      headers: authHeaders,
      body: JSON.stringify({
        name: 'TEMP-导览演示用(必红·脚本自建)',
        method: 'GET',
        url: `${BASE}/health`,
        expected: { status: 599 }, // 服务端永远不会回 599 → 必然失败
        group: '',
      }),
    })
    const badCase = await mkBad.json().catch(() => ({}))
    const failCase = badCase.id ? badCase : null
    created.caseId = failCase ? failCase.id : null // 立刻登记，收尾才兜得住
    c.check('能建临时必红用例（用于演示定时通知）', !!failCase, `id=${badCase.id || '-'} status=${mkBad.status}`)

    let schId = null
    if (!failCase) {
      console.log('  (临时用例没建起来，跳过定时任务与通知演示)')
    } else {
      // ⭐ 先把历史未读清掉，让角标从 0 开始。
      // 不清的话：上一轮留下的未读会让等待循环**一上来就「命中」角标**，
      // 于是立刻跳出、错过真正要验的「新通知 → toast 实时弹出」——脚本第二次跑就会假失败。
      await fetch(BASE + '/api/notifications/read-all', { method: 'POST', headers: authOnly })

      const mk = await fetch(BASE + '/api/schedules', {
        method: 'POST',
        headers: authHeaders,
        body: JSON.stringify({ caseId: failCase.id, cron: '* * * * *', notifyOn: 'all' }),
      })
      schId = (await mk.json().catch(() => ({}))).id || null
      created.schId = schId // 立刻登记，收尾才兜得住
      c.check('能建定时任务（每分钟触发 · 失败也通知）', mk.ok && !!schId, `caseId=${failCase.id} status=${mk.status}`)

      await go('/#/reports', "document.body.innerText.includes('定时任务')", '报告页定时区')
      await scrollTo('定时任务')
      await shot('06-报告-定时任务.png')

      // 回列表页等 cron 自己触发。
      // 判据用观测脚本记下的「确定事实」，不用瞬时 toast（理由见脚本开头）。
      await go('/#/', "document.querySelectorAll('tbody tr').length > 0", '回列表等通知')
      const probe = () => cdp.eval(`(() => {
        const b = document.querySelector('.notif-bell .el-badge__content');
        return {
          badge: (b && window.__h.vis(b)) ? b.innerText.trim() : '',
          notifFrames: (window.__sseLog || []).filter((d) => d.includes('notification')).length,
          toasts: (window.__toastLog || []).length,
        };
      })()`)
      let seen = { badge: '', notifFrames: 0, toasts: 0 }
      let firstFrameAt = 0
      let probeFails = 0
      const t0 = Date.now()
      while (Date.now() - t0 < 95000) {
        let s
        try {
          s = await probe()
        } catch (e) {
          // 页面正在导航 / 执行上下文被销毁时 eval 会失败，属正常抖动 → 容忍几次，别把整轮导览带崩
          if (++probeFails > 10) throw new Error(`等待通知时连续观测失败（${probeFails} 次）：${e.message}`)
          await sleep(300)
          continue
        }
        seen = {
          badge: s.badge || seen.badge,
          notifFrames: Math.max(seen.notifFrames, s.notifFrames),
          toasts: Math.max(seen.toasts, s.toasts),
        }
        if (seen.notifFrames > 0 && !firstFrameAt) firstFrameAt = Date.now()
        // 帧到了 + toast 真弹了 → 立刻跳出截图（toast 只活 4 秒，这是唯一要抢时间的动作）
        if (seen.notifFrames > 0 && seen.toasts > 0) break
        // 帧到了、又多等 6 秒仍没等到 toast：跳出并打诊断，别把 95 秒卡满
        if (firstFrameAt && Date.now() - firstFrameAt > 6000) break
        await sleep(120)
      }
      c.check('SSE 把通知实时推到页面（EventSource 真收到 notification 帧）', seen.notifFrames > 0, `收到 ${seen.notifFrames} 帧`)
      c.check('未读角标亮起', !!seen.badge, `badge=${seen.badge || '-'}`)
      c.check('推送到达时页面弹了 toast（不手动刷新）', seen.toasts > 0, `弹了 ${seen.toasts} 次`)
      if (seen.toasts === 0) {
        const dbg = await cdp.eval(`JSON.stringify({
          addLog: (window.__addLog || []).slice(-14),
          addCount: (window.__addLog || []).length,
          liveMsg: (document.querySelector('.el-message') ? document.querySelector('.el-message').className : null),
        })`)
        console.log('  （诊断）收到的 toast 观测日志：', dbg)
      }
      await sleep(250) // 等 toast 的入场动画走完，否则截到半透明
      await shot('07-实时通知弹出.png')

      const bell = await cdp.eval("window.__h.click('🔔 通知')")
      if (bell === 'CLICKED') {
        await cdp.waitFor("!!document.querySelector('.el-dialog')", '通知弹窗', 8000)
        await sleep(500)
        const nt = await cdp.eval("document.querySelector('.el-dialog').innerText")
        c.check('通知弹窗有真实通知正文', /失败|通过/.test(nt), nt.replace(/\n/g, ' | ').slice(0, 60))
        await shot('08-运行通知.png')
        await esc()
      }
    }

    // ── 6. 环境变量集 ──────────────────────────────────────────
    await go('/#/environments', "document.querySelectorAll('tbody tr').length > 0", '环境页')
    const envText = await cdp.eval('document.body.innerText')
    c.check('环境页显示当前环境指向 OA', envText.includes('3200') || envText.includes('office-oa'), envText.replace(/\n/g, ' | ').slice(0, 60))
    await shot('09-环境变量集.png')

    // ── 7. 移动端（真改视口，不靠截图裁剪）──────────────────────
    // 不判负：这个平台是桌面端管理工具，移动端适配不在需求内 —— 这里只**量**出来，当已知边界记录。
    await cdp.send('Emulation.setDeviceMetricsOverride', { width: 390, height: 844, deviceScaleFactor: 2, mobile: true })
    await go('/#/', "document.querySelectorAll('tbody tr').length > 0", '移动端列表')
    const of = await cdp.eval('window.__h.overflow()')
    console.log(`  INFO  移动端（390px）横向溢出：${of.overflow ? '有' : '无'}  scrollWidth=${of.scrollWidth} clientWidth=${of.clientWidth}（已知边界，非回归）`)
    await shot('10-移动端-用例列表.png')
    await cdp.send('Emulation.clearDeviceMetricsOverride')

  }, { port: 9337 })
  } catch (e) {
    failure = e
  }
  // ⭐ 收尾放在这里（而不是 finally 里）：正常结束 / 断言失败 / eval 超时 / 任何异常都要走到，
  //    而且**收尾的断言结果也要能被 c.finish() 打印出来**。
  //    第一次修的时候我写在 finally 里，异常直接穿过 c.finish() —— 收尾到底删没删干净，屏幕上看不见。
  clearTimeout(watchdog)
  try {
    await cleanup(failure ? '异常收尾' : '正常收尾')
  } catch (e) {
    console.error('收尾清理失败：', e.message)
  }

  console.log(`\n截图 ${fs.readdirSync(OUT).length} 张：${OUT}`)
  c.finish()
  if (failure) throw failure
}

main().catch((e) => {
  console.error('\n脚本异常：', e.message)
  process.exitCode = 1
})

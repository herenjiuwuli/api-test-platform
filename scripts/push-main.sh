#!/usr/bin/env bash
# 把 api-test-platform 主分支推到 GitHub。
# 用法：  bash scripts/push-main.sh
#
# 背景（三个都踩过，别再踩）：
#   1) PortableGit 的 bash 解析「带大写变量名的单行 unset」会报引号不匹配，
#      所以推送命令必须写在脚本文件里执行，不能直接粘到终端。
#   2) PortableGit 系统级 gitconfig 里 credential.helper=helper-selector，
#      它在 push 末尾的 store 阶段会卡住等交互 → push 永远「零输出、像卡死」，
#      **即使网络完全正常**。绕法：-c credential.helper= 清空，只留 GCM。
#   3) 「curl 探 github.com = 200」不代表 push 能成：今天实测探通 200，
#      push 却 Recv failure / Connection reset。所以本脚本不靠 curl 判断，
#      **推送后直接问远端 sha**，与本地 HEAD 一致才算成功，否则换下一条通道。
#   通道：直连 → 沙箱透明代理 1212 → Clash 7897。
set -u
cd "$(dirname "$0")/.." || exit 1

OWNER="herenjiuwuli"
NAME="api-test-platform"
URL="https://github.com/$OWNER/$NAME.git"
GCM="C:/Users/29322/.workbuddy/binaries/PortableGit/versions/1.2.0/mingw64/bin/git-credential-manager.exe"
LOCAL_SHA=$(git rev-parse HEAD)

if ! git remote get-url origin >/dev/null 2>&1; then
  echo "还没配 origin。先在 GitHub 网页建仓库（30 秒）："
  echo "    1) 打开 https://github.com/new"
  echo "    2) Repository name 填：$NAME"
  echo "    3) 选 Public；不要勾 Add README / .gitignore / license（保持空仓库）"
  echo "    4) 建好后执行："
  echo "         git remote add origin $URL"
  echo "       然后再跑一次本脚本"
  exit 1
fi

# 作者已本地提交 17aab42 时若推送中断，这里是幂等的：已推上去会显示 up-to-date。
echo "本地 HEAD = $LOCAL_SHA"

unset http_proxy https_proxy HTTP_PROXY HTTPS_PROXY all_proxy ALL_PROXY >/dev/null 2>&1

# 关键：-c credential.helper= 清空 helper 列表，绕开会卡死的 helper-selector
CRED=(-c credential.helper= -c "credential.helper=!\"$GCM\"")

remote_sha() {  # 直接问 GitHub API，不信 git 的本地记录；多通道取到为止
  local url="https://api.github.com/repos/$OWNER/$NAME/git/refs/heads/main" raw=""
  raw=$(curl -s --noproxy "*" --connect-timeout 8 "$url" 2>/dev/null)
  if [ -z "$raw" ]; then
    raw=$(curl -s --proxy http://127.0.0.1:1212 --connect-timeout 8 "$url" 2>/dev/null)
  fi
  echo "$raw" | grep -o '"sha": "[a-f0-9]*"' | head -1 | sed 's/.*"\([a-f0-9]*\)".*/\1/'
}

try_channel() {  # $1 = 代理地址（空串 = 直连）；成功返回 0
  local proxy="$1" label
  if [ -z "$proxy" ]; then label="直连"; else label="代理 $proxy"; fi

  if [ -z "$proxy" ]; then
    PROXY=(-c http.proxy= -c https.proxy=)
    probe=$(curl --noproxy "*" -s -o /dev/null -w "%{http_code}" --connect-timeout 8 https://github.com 2>/dev/null)
  else
    PROXY=(-c "http.proxy=$proxy" -c "https.proxy=$proxy")
    probe=$(curl -s -o /dev/null -w "%{http_code}" --proxy "$proxy" --connect-timeout 8 https://github.com 2>/dev/null)
  fi

  echo ""
  echo "== $label（curl 探 github.com = $probe）=="
  if [ "$probe" != "200" ]; then
    echo "   探测不通，跳过"
    return 1
  fi

  # lowSpeedLimit/Time + timeout：直连抖动时「push 卡死 10 分钟」比失败更烦人
  timeout 180 env GIT_TERMINAL_PROMPT=0 GCM_INTERACTIVE=never git \
    "${PROXY[@]}" "${CRED[@]}" \
    -c http.lowSpeedLimit=1000 -c http.lowSpeedTime=30 \
    push -u origin main 2>&1 | tail -6

  got=$(remote_sha)
  echo "   远端 main = ${got:-<取不到>}"
  if [ "$got" = "$LOCAL_SHA" ]; then
    echo "✅ 推送成功（$label）"
    return 0
  fi
  echo "   该通道没推上去，换下一条"
  return 1
}

for cand in "" "http://127.0.0.1:1212" "http://127.0.0.1:7897"; do
  try_channel "$cand" && exit 0
done

echo ""
echo "❌ 三条通道都没成功。选一个："
echo "   a) 等几分钟再跑本脚本（直连时段性中断，通常约 30 分钟恢复）"
echo "   b) 开 Clash 后重跑本脚本（会自动用 7897）"
exit 2

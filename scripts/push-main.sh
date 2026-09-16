#!/usr/bin/env bash
# 把 api-test-platform 主分支推到 GitHub（走直连，不走代理）
# 用法：  bash scripts/push-main.sh
# 背景：PortableGit 的 bash 解析「带大写变量名的单行 unset」会报引号不匹配，
#       所以推送命令必须写在脚本文件里执行，不能直接粘到终端。
set -u
cd "$(dirname "$0")/.." || exit 1

OWNER="herenjiuwuli"
NAME="api-test-platform"
URL="https://github.com/$OWNER/$NAME.git"

if ! git remote get-url origin >/dev/null 2>&1; then
  echo "⚠️  还没配 origin。先在 GitHub 网页建仓库（30 秒）："
  echo "    1) 打开 https://github.com/new"
  echo "    2) Repository name 填：$NAME"
  echo "    3) 选 Public；**不要**勾 Add README / .gitignore / license（保持空仓库）"
  echo "    4) 建好后执行："
  echo "         git remote add origin $URL"
  echo "       然后再跑一次本脚本"
  exit 1
fi

echo "网络检查（直连）…"
code=$(curl --noproxy "*" -s -o /dev/null -w "%{http_code}" --connect-timeout 10 https://github.com 2>/dev/null)
echo "  github.com = $code"
if [ "$code" != "200" ]; then
  echo "❌ 直连不可达（$code）。选一个："
  echo "   a) 等几分钟再跑本脚本（直连时段性中断，通常约 30 分钟恢复）"
  echo "   b) 开 Clash 后改用代理推送："
  echo "        git -c http.proxy=http://127.0.0.1:7897 -c https.proxy=http://127.0.0.1:7897 push -u origin main"
  exit 2
fi

unset http_proxy https_proxy HTTP_PROXY HTTPS_PROXY all_proxy ALL_PROXY
# lowSpeedLimit/Time + timeout：直连抖动时「单次 push 卡死 10 分钟」比失败更烦人
timeout 180 env GIT_TERMINAL_PROMPT=0 git -c http.proxy= -c https.proxy= \
  -c http.lowSpeedLimit=1000 -c http.lowSpeedTime=30 push -u origin main 2>&1 && echo "PUSH_OK"

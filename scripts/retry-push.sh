#!/usr/bin/env bash
# 直连抖动时的推送重试：反复调 push-main.sh，直到成功或超过轮数。
# 用法：  bash scripts/retry-push.sh [轮数] [间隔秒]
#        默认 8 轮 / 240 秒（直连中断通常约 30 分钟恢复）
# 为什么单独一个脚本：单次 push 撞上中断窗口会白等几分钟，而重试必须**自动**跑完，
# 否则人得一直盯着 —— 这个动作就该交给后台轮询。
set -u
cd "$(dirname "$0")/.." || exit 1

ROUNDS="${1:-8}"
GAP="${2:-240}"

for i in $(seq 1 "$ROUNDS"); do
  echo "=== 第 $i/$ROUNDS 轮 $(date '+%H:%M:%S') ==="
  if bash scripts/push-main.sh; then
    echo "PUSH_OK（第 $i 轮成功）"
    exit 0
  fi
  if [ "$i" -lt "$ROUNDS" ]; then
    echo "本轮未成功，等 ${GAP}s 再试…"
    sleep "$GAP"
  fi
done

echo "❌ $ROUNDS 轮都没推上去。提交已在本地安全落盘，稍后手动再跑一次本脚本即可。"
exit 1

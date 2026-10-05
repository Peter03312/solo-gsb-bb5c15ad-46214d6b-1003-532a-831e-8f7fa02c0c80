#!/bin/sh
set -e

# 容器启动即完成依赖（镜像构建时已安装）与数据库初始化（首请求/启动时自动建表）。
# SEED_DEMO=1 时写入一组演示草稿数据（仅在库为空时）。
if [ "${SEED_DEMO:-}" = "1" ]; then
  echo "SEED_DEMO=1：检查并写入演示数据…"
  node src/seed.js || true
fi

exec "$@"

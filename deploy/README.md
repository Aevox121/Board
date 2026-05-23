# Board 中继服务器部署

把 Board 部署成一台可被多人访问的中继服务器（PRD §4.2）。两个核心要求：

1. **公网可达**：`BOARD_HOST=0.0.0.0` 监听全部网卡 + 反向代理转 80/443。
2. **token 鉴权**：`BOARD_REQUIRE_TOKEN=true` 强制；URL 里的 `?token=...`
   就是访问凭证（谁有 URL 谁能编辑，软归属语义 PRD §8.3）。

本目录给两套示例：
- `docker-compose.yml` —— 一键起 `board-server` + `caddy` 反向代理
- `Caddyfile` —— Caddy v2 配置（自动 TLS）

> 单 / 多 board 都用同一套。多 board 时往 `BOARD_DIRS` 加路径即可。

## 快速起步

```bash
# 1. 先在宿主机准备一份白板目录，例如：
#    /srv/board/boards/
#    ├── 旅行计划.board/
#    └── 菜谱.board/

# 2. 改 docker-compose.yml 里的卷映射 + 域名

# 3. 起
docker compose up -d

# 4. 看 token（首次启动每个 board 自动补 token 并落盘）
docker compose logs board-server | grep token
# 输出形如：
#   token: a3b1f9e2d8c47165...

# 5. 给协作者发链接
docker compose exec board-server node /app/packages/cli/dist/index.js \
  share /boards/旅行计划.board \
  --host board.example.com --port 443 --scheme https
# 输出 URL：https://board.example.com/?board=旅行计划&token=a3b1f9e2...
```

## docker-compose.yml 字段说明

| 字段 | 用途 |
|---|---|
| `volumes: ./boards:/boards` | 把宿主机的 boards 目录映射进容器；`.board` 文件夹放这里 |
| `BOARD_HOST=0.0.0.0` | 监听全部网卡（容器内）。外部访问由 caddy 把 443 转 4500 |
| `BOARD_REQUIRE_TOKEN=true` | 强制 token 鉴权 |
| `command` 里列出每个 .board 路径 | 多 board 模式逐个声明 |

## Caddyfile 字段说明

| 段 | 作用 |
|---|---|
| `board.example.com` | 你的域名；Caddy 自动从 Let's Encrypt 取证书 |
| `reverse_proxy /api/* board-server:4500` | HTTP API 转发 |
| `reverse_proxy /yjs/* board-server:4500` | Yjs ws 转发（Caddy 自动识别 Upgrade 头） |
| `reverse_proxy /* board-server:4510` 或静态站点 | 把 web 资源对外暴露；可静态构建 + 由 caddy 直接 serve `packages/web/dist` |

> 本目录的 `Caddyfile` 走最简方案：web 资源走静态文件（`packages/web/dist/`），
> API + ws 走反向代理。需要 dev 热更新就把 `/*` 也指向 `vite dev` 实例。

## nginx 替代

要用 nginx 替代 caddy，关键是给 `/yjs/` 加 `Upgrade` 头：

```nginx
location /yjs/ {
    proxy_pass http://127.0.0.1:4500;
    proxy_http_version 1.1;
    proxy_set_header Upgrade $http_upgrade;
    proxy_set_header Connection "upgrade";
    proxy_set_header Host $host;
    proxy_read_timeout 86400;  # ws 长连接需要长超时
}
location /api/ {
    proxy_pass http://127.0.0.1:4500;
    proxy_set_header Host $host;
}
location / {
    root /srv/board/web/dist;
    try_files $uri /index.html;
}
```

## 安全说明

- 没引入用户帐号 / RBAC —— 与 PRD「白板级权限」一致，token 即凭证
- token 是 128 bit 随机 hex（`@board/core` 的 `newShareToken()`），暴力穷举不实际
- 但 **URL 会被浏览器历史 / 服务器日志 / Referer 等记录**；把链接当口令，别发到公开渠道
- 想轮换 token？删 `meta.json` 里的 `shareToken` 字段重启 server，会自动补一个新的
- 公网中继**强烈建议加 HTTPS**（caddy 自带 / nginx 配 Let's Encrypt）

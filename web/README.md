# BitChat 私聊 PWA

这是一个独立的 Web/PWA 前端，面向“无需注册、只和指定的人聊天”的使用方式。它不使用蓝牙；远距离聊天通过 WebSocket 中继转发加密消息。

## 当前能力

- 首次打开自动生成本机身份，不需要账号或注册。
- 双方互相导入邀请；推荐发送分享链接，对方点击即可自动导入，也可以读取剪贴板或使用摄像头扫描 QR 邀请。
- 使用浏览器 Web Crypto 的 P-256 ECDH + ECDSA + AES-GCM；开发版可用公开 Nostr 中继，正式使用建议部署项目自带的 Cloudflare Durable Object 中继。中继只能转发加密消息包，不能读取聊天正文。
- 任意一方可以执行“删除双方记录”。删除指令也会加密发送给对方；双方客户端收到后清空本地记录并切换到新的聊天代次，旧中继消息不会重新显示。
- Service Worker 缓存应用外壳，支持添加到 iPhone 主屏幕。

## 本地运行

在 `web` 目录执行：

```text
npm install
npm test
npm run build
```

启动本地中继：

```text
npm run relay
```

另开一个终端启动 PWA：

```text
npm run dev -- --host 0.0.0.0
```

本地电脑访问 `http://localhost:5173`，中继地址保持默认的 `ws://localhost:8787/ws`。手机要访问电脑上的开发服务，需要把中继地址改成电脑局域网 IP；但 iPhone 摄像头和 Service Worker 的完整能力需要 HTTPS。

正式部署到 GitHub Pages 或 Cloudflare Pages 后，生产构建默认使用项目专用的 Cloudflare Worker 中继。由于部分网络无法连接公开 Nostr 中继，项目也保留了 `nostr://public` 作为备用选项；公开中继和自建中继都只能看到会话编号、时间和加密包大小等元数据。

## 部署 Cloudflare 专用中继

在已登录 Cloudflare 的电脑上执行：

```text
npx wrangler login
npx wrangler deploy --config relay/wrangler.toml
```

部署后把 Cloudflare 显示的 Worker 地址（`https://...`）填入 PWA 的“设置 -> 中继地址”。HTTPS 模式每 3 秒轮询一次，不依赖 WebSocket 长连接；也支持填入 `wss://.../ws` 使用实时模式。网页客户端会自动把会话编号附加到中继请求；中继按会话隔离并保存最近 500 条加密消息，最多保留 7 天。

## 用 iPhone 测试

1. 打开 Fork 的 `Settings -> Pages`，把 Source 设为 **GitHub Actions**。
2. 打开 `Actions`，等待 **Deploy PWA to GitHub Pages** 变绿。
3. 在两部 iPhone 的 Safari 打开 `https://trinhngocmai14835-dev.github.io/bitchat/`，可通过“分享 -> 添加到主屏幕”安装。
4. 两部手机各设置一个本机名称。A 创建邀请并分享链接，B 点击链接自动导入后显示回传邀请，A 再导入回传邀请。
5. 保持默认的 `nostr://public` 中继即可开始远程聊天。右上角菜单里的“删除双方记录”会向对方发送加密删除指令。

## 配对方式

1. A 点“新建邀请”，优先点“分享链接”发给 B；也可以发送 QR 或邀请文本。
2. B 点击分享链接即可自动导入；如果使用文本，点“读取剪贴板”或扫描二维码。然后点“显示我的回传邀请”，把 B 的邀请发回 A。
3. A 导入回传邀请。双方都完成一次导入后即可双向聊天。

这不是传统账号系统：身份密钥保存在当前浏览器的本地存储中。清理浏览器数据会丢失本机身份和联系人，因此当前版本不要把它当作密钥备份方案。

## 重要限制

“删除双方记录”是对双方遵守协议的客户端做加密删除同步，不能删除截图、复制出去的文本、系统通知、浏览器备份，也不能保证第三方恶意修改的客户端会配合删除。中继当前只做有限的内存缓存，重启会丢失未送达消息；正式上线还需要 HTTPS/WSS、持久化策略、限流、监控和安全审计。

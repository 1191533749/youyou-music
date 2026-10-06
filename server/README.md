# 一起听中继服务器

零依赖 Node 服务（只用标准库），负责：房间与播放同步、聊天、找听友、赠礼、支付宝充值下单与轮询到账。

## 目录

```
server/
├── index.mjs     # HTTP + WebSocket 服务、消息路由、余额与订单
├── ws.mjs        # 极简 WebSocket 实现（握手/帧编解码）
├── gifts.mjs     # 礼物目录（服务端权威价格）
├── alipay.mjs    # 支付宝当面付（RSA2 签名、预下单、订单查询）
└── data/         # 运行时生成：state.json（余额/订单）、alipay-key.pem（应用私钥）
```

`server/data/` 已在 .gitignore 中：**应用私钥绝不能进仓库**。

## 本地运行

```powershell
node server/index.mjs            # 默认 8787 端口
$env:PORT=9000; node server/index.mjs
curl http://127.0.0.1:8787/health
```

自测（启动服务器 + 两个模拟客户端跑完整流程）：

```powershell
node scripts/test-relay.mjs      # 期望输出 RELAY-E2E OK
```

## 部署到公网服务器

1. 服务器安装 Node 20+（`node -v` 确认）。
2. 拷贝 `server/` 目录到服务器（例如 `/opt/youyou-relay/`）。
3. 放置支付宝应用私钥（**只在服务器上**，权限 600）：
   ```
   /opt/youyou-relay/data/alipay-key.pem     # 内容为完整 PEM 或一行 base64
   ```
   或用环境变量 `ALIPAY_PRIVATE_KEY` / `ALIPAY_APP_ID`。
4. 放通端口（示例 8787）：云厂商安全组 + 系统防火墙（`ufw allow 8787` 或 `firewall-cmd`）。
5. 用 systemd 常驻（示例）：
   ```ini
   # /etc/systemd/system/youyou-relay.service
   [Unit]
   Description=Youyou Music Listen-Together Relay
   After=network.target

   [Service]
   WorkingDirectory=/opt/youyou-relay
   Environment=PORT=8787
   Environment=ALIPAY_APP_ID=2019101168266558
   ExecStart=/usr/bin/node /opt/youyou-relay/index.mjs
   Restart=always
   User=root

   [Install]
   WantedBy=multi-user.target
   ```
   ```bash
   systemctl daemon-reload && systemctl enable --now youyou-relay
   systemctl status youyou-relay
   ```
6. 验证：浏览器或 curl 打开 `http://<服务器IP>:8787/health`，应返回 `{"ok":true,...,"alipay":true}`。

## 客户端连接

客户端在「一起听」页面填写中继地址，例如 `ws://198.44.179.69:8787`。

安全提示：当前协议未做身份认证与传输加密，属于内部/自用级别的实现；若要对外提供服务，建议加 TLS（`wss://` + 域名证书）并引入登录态校验。

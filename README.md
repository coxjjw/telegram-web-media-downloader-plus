# Telegram 网页版媒体下载器 -Plus

> 从 Telegram Web（web.telegram.org）下载 / 批量保存图片与视频，
> 即使在「禁止转发 / 禁止保存」的受限聊天里也能用；并新增 **ZF 批量转发** 功能。

- 原名（英文）：**Telegram Web Media Downloader Plus**
- 版本：`2.0`
- 许可证：**MIT**
- 作者：Dharan Tej（原作者）｜ 二次修改完善：**coxjjw**
- 原始脚本：<https://greasyfork.org/scripts/585543>

---

## ✨ 功能

| 按钮 | 作用 |
| --- | --- |
| **D/L** | 批量下载选中的图片 / 视频。可固定一个保存文件夹，之后整批只问一次。 |
| **⚙️** | 下载设置：选择 / 更换 / 取消固定保存文件夹，配置自动询问行为。 |
| **ZF** | 批量转发：把选中媒体**先下载到内存、再以全新文件上传**到你指定的会话（群 / 频道 / 私聊 / 收藏夹）。不走转发 API，因此受限媒体也能「转」出去，且目标里没有「转发自」标记。 |
| 右键菜单 | 在受限聊天的消息上右键，新增 **Download** 一项，单独保存该条媒体。 |
| 复制文本 | 自动解除受限消息的「禁止复制」，Ctrl+C 即可复制文字。 |

所有功能仅在 Telegram Web 的 **WebK（/k/）** 版本生效；其他入口会自动跳转到 `/k/`。

---

## 📦 安装

### 方式一：GreasyFork（推荐，带自动更新）
1. 安装浏览器扩展：[Tampermonkey](https://www.tampermonkey.net/) 或 Violentmonkey。
2. 打开本脚本在 GreasyFork 的页面，点击「安装」。
3. 之后每次本仓库推送更新，GreasyFork 会自动同步，Tampermonkey 也会提示更新。

> GreasyFork 地址在你首次发布后生成（见下方「部署」一节）。

### 方式二：直接从 GitHub 安装（开发者 / 想抢先体验）
点击仓库里的
[`telegram-web-media-downloader-plus.user.js`](https://raw.githubusercontent.com/coxjjw/telegram-web-media-downloader-plus/main/telegram-web-media-downloader-plus.user.js)
，Tampermonkey 会识别 `.user.js` 并弹出安装框。
脚本头里已写好 `@downloadURL` / `@updateURL` 指向本仓库 raw 文件，因此也能自动更新。

---

## 🛠 使用方法

1. 打开 <https://web.telegram.org/k/> 并进入任意会话。
2. **多选**若干条含媒体的消息（勾选后底部出现选择工具栏），点 **D/L** 下载，或点 **ZF** 转发。
3. **受限聊天**里：右键消息 → `Download` 单条保存；选中后 **ZF** 仍可用。
4. 首次点 **D/L** 会询问保存位置：选一个文件夹后会被记住，后续整批只问一次（可随时用 **⚙️** 取消固定）。

> 说明：「禁止保存 / 禁止转发」只是 Telegram 界面层的开关，媒体本身已在页面内解密，
> 脚本直接调用 App 自带的下载例程，因此受限聊天也能保存 / 转发。

---

## 🚀 部署（GitHub + GreasyFork 自动同步）

本仓库是**唯一事实来源**：代码推到 GitHub，GreasyFork 从 GitHub 同步，用户从 GreasyFork（或 GitHub raw）安装并更新。

### 第 1 步：把代码推到 GitHub
仓库已建好（公开）：`https://github.com/coxjjw/telegram-web-media-downloader-plus`
- `telegram-web-media-downloader-plus.user.js` —— 脚本本体（含完整元数据头）
- `README.md` —— 本说明
- `LICENSE` —— MIT

### 第 2 步：在 GreasyFork 发布（一次性，需你登录 greasyfork.org）
1. 注册 / 登录 <https://greasyfork.org>。
2. 进入 <https://greasyfork.org/scripts/new>。
3. 选择「**从 URL 导入**」或直接把 `telegram-web-media-downloader-plus.user.js` 的内容粘贴进编辑器，提交。
4. 发布成功后，进入该脚本的**管理页面 → 源代码同步（Source Code Sync）**。

### 第 3 步：设置 GitHub → GreasyFork 自动同步
在「源代码同步」里填写：

```
同步方式：自动
同步 URL：https://raw.githubusercontent.com/coxjjw/telegram-web-media-downloader-plus/main/telegram-web-media-downloader-plus.user.js
```

点击「更新设置并立即同步」。此后每次向 GitHub `main` 分支推送，GreasyFork 会在数小时内拉取新版本。

### 第 4 步（可选）：配置 Webhook 实现「推送即更新」
GreasyFork 默认的定时同步有延迟。想要**推送后立刻更新**，配置 GitHub Webhook：
1. 在 GreasyFork 脚本管理页打开「设置 Webhook」教程，复制 **Payload URL** 和 **密钥（Secret）**。
2. 打开 GitHub 仓库 `Settings → Webhooks → Add webhook`：
   - Payload URL：粘贴上面复制的地址
   - Content type：`application/json`
   - Secret：粘贴上面复制的密钥
   - 触发事件：选 **Just the push event**
3. 保存后 GitHub 会发一个 ping；若 Webhook 前出现绿色对勾，即握手成功。

### ⚠️ 更新版本的重要约定
每次修改脚本后，**必须** bump 元数据里的 `@version`（例如 `2.0` → `2.1`）。
只改代码、不升 `@version`，GreasyFork 会抓到新代码，但**不会提示用户更新**。
建议格式：`主版本.次版本`，或用日期戳 `YYYY.MM.DD`。

---

## 📝 元数据说明（开发者）

- 本 fork 重新启用了 `@downloadURL` / `@updateURL` 并指向本 GitHub 仓库。
  原作者的上游脚本曾刻意删除这两个字段，以免 Tampermonkey 自动更新把 ZF 等改动覆盖回官方版；
  作为独立维护的 fork，重新启用可让用户获取本项目的更新。
- `@namespace` 已改为 `coxjjw`，明确归属本 fork。
- 脚本为自包含实现，不加载任何外部脚本，符合 GreasyFork 的发布规范。

---

## 📄 许可证

[MIT](LICENSE) © Dharan Tej（原作者）｜ © coxjjw（二次修改）。

在保留原作者版权声明与 MIT 许可的前提下，可自由使用、修改与再分发。

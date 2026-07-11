# Codex 技能同步器

一个面向 macOS 和 Windows 的中文桌面工具，在多台电脑之间自动同步个人 Codex 技能。

它只处理包含 `SKILL.md` 的技能文件夹，不会同步 GPT/Codex 登录状态、API Key、token、聊天记录、缓存或整个 `~/.codex` 目录。

## 账号与隐私

- 不需要登录 GPT，也不调用 OpenAI API。
- 使用 GitHub 作为私人技能仓库时，需要一个 GitHub 账号。
- 软件不会要求、读取或保存 GitHub 密码。
- 点击“使用浏览器连接 GitHub”后，登录和验证码都在 GitHub 官方页面完成。
- GitHub 授权由官方 GitHub CLI 处理，并优先保存在 macOS 钥匙串或 Windows 凭据管理器中。
- 软件自动创建的 `codex-skill-sync` 仓库是私有仓库。
- 软件会自动识别环境变量、系统代理以及 ClashX 等工具常用的本机 HTTP 代理端口，并将同一代理用于 GitHub 登录和技能同步。

GitHub 已停止使用账号密码验证 Git 操作。本工具使用 GitHub 官方浏览器授权，不需要用户生成或粘贴 Personal Access Token。

## 第一次设置

第一次打开只需完成四步：

1. 确认软件自动发现的本机技能数量。
2. 点击“使用浏览器连接 GitHub”，在 GitHub 官方页面完成授权。
3. 选择这台电脑是“技能最完整的电脑”还是“从其他电脑获取技能”。
4. 点击“开始同步”。

软件会自动完成私人仓库创建、路径配置、第一次同步、后台自动同步和 Codex 启动同步，不需要手动填写 GitHub 仓库地址。

连接时，软件会把一次性授权码带入 GitHub 官方设备页面并尝试自动填好，同时也会把授权码复制到剪贴板。如果系统没有自动打开浏览器，可以点击“浏览器没有打开？重新打开”；如果 GitHub 页面仍为空，直接粘贴即可。

### 第一台电脑

在技能最完整的电脑上选择“这台电脑的技能最完整”。本机技能会成为 GitHub 中保存的第一份版本。

### 其他电脑

使用同一个 GitHub 账号连接，然后选择“我要从其他电脑获取技能”。软件会先获取 GitHub 上已有版本；遇到同名但内容不同的技能时会暂停，不会悄悄覆盖。

## 日常使用

配置完成后不需要手动上传或下载：

- 软件启动时检查一次。
- 技能文件变化约 2.5 秒后自动同步。
- 默认每 30 秒获取其他电脑的更新。
- 打开 Codex 新任务时可以再检查一次。
- 临时离线后会在后续检查中自动重试。
- 同一文件发生冲突时暂停自动同步并保留两个版本。

首页只保留同步状态、技能列表、“立即同步”和四个常用开关。仓库路径、Git 命令和维修操作收在“高级设置与故障排查”中。

## 安装包

```text
macOS Apple Silicon  release/Codex-Skill-Sync-0.3.3-mac-arm64.zip
Windows x64          release/Codex-Skill-Sync-0.3.3-win-x64.exe
```

macOS 包使用本地 ad-hoc 签名，没有 Apple Developer 公证；Windows 包没有商业代码签名证书。复制到其他电脑后，系统可能显示“未知开发者”或“未知发布者”。正式公开分发时需要补 Developer ID、公证和 Windows 代码签名。

当前版本仍要求电脑上有可用的 Git。软件会在第一步自动检查；大多数使用 Codex 开发的电脑已经具备 Git。

## 开发与构建

```bash
npm install
npm test
npm run desktop
npm run desktop:mac
npm run desktop:win
```

构建产物写入 `release/`。Windows 安装包可以在 Mac 上交叉构建，但正式发布前仍应在 Windows 真机验证安装、系统托盘和凭据管理器。

## 同步安全

日常同步会按顺序执行：

1. 保存本机技能改动并创建 Git 版本。
2. 获取远程版本并尝试自动合并。
3. 合并成功后上传最新版本。
4. 将最终结果应用到 Codex 技能目录。

两台电脑修改同一文件的同一位置时，同步会停止。用于比较的本机和远程副本保存在：

```text
~/.codex-skill-sync/conflicts/
```

默认本地位置：

```text
配置文件     ~/.codex-skill-sync/config.json
桌面设置     ~/.codex-skill-sync/desktop.json
同步仓库     ~/.codex-skill-sync/repo
技能目录     自动发现 ~/.agents/skills 或 ~/.codex/skills
```

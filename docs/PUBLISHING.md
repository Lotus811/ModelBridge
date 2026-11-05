# 发布到 GitHub

项目已经初始化 Git，默认分支为 `main`。保留现有提交历史即可，无需重新执行 `git init`。

## 首次发布

1. 登录 GitHub，在 <https://github.com/new> 创建名为 `ModelBridge` 的仓库，选择 Public。
2. 保持仓库为空：不要勾选自动添加 README、.gitignore 或 License，本项目已包含这些文件。
3. 在项目目录打开 PowerShell，先确认改动，再提交：

```powershell
git status --short
git add -A
git diff --cached --stat
git commit -m "Prepare ModelBridge v1.11.0 for public release"
```

4. 将下面的 `YOUR_USERNAME` 替换为自己的 GitHub 用户名，再连接远程仓库并推送：

```powershell
git remote add origin https://github.com/YOUR_USERNAME/ModelBridge.git
git push -u origin main
```

出现登录提示时完成 GitHub 身份验证。若命令行要求输入 HTTPS 密码，应使用 Personal Access Token，而非 GitHub 账户密码；优先使用 Git Credential Manager 提供的登录流程。

如果提示 `remote origin already exists`，先运行 `git remote -v` 确认地址；只有地址不正确时才执行：

```powershell
git remote set-url origin https://github.com/YOUR_USERNAME/ModelBridge.git
```

若提示未设置提交身份，只为当前仓库配置自己的姓名与邮箱，再重新执行 commit：

```powershell
git config user.name "你的署名"
git config user.email "你的 GitHub 提交邮箱"
```

可以使用 GitHub 邮箱设置中提供的 noreply 地址。

## 文件范围

- 根目录保留 README、许可证、安全说明、示例配置、启动器和后端入口。
- `web/` 为前端，`scripts/` 为开发辅助脚本，`test/` 为自动化测试，`.github/` 为 CI 与 Issue 模板。
- `docs/` 保存发布指南、界面设计说明及模拟数据截图。
- `api.txt`、`config.local.json`、`.env`、`.ui-artifacts/`、`node_modules/`、`releases/` 均由 `.gitignore` 排除。不要使用 `git add -f` 加入这些私密或生成文件。
- `package.json` 中的 `private: true` 用于防止意外发布到 npm，不妨碍 GitHub 开源或 MIT 授权。

## 验证与打包

```powershell
npm run check
npm test
git diff --check
git check-ignore api.txt config.local.json
```

如果本机 npm 安装损坏，可先运行 `node --test`，语法检查仍需按 `package.json` 的 check 脚本执行；应用可直接用 `node server.mjs` 启动。

可在项目目录使用 Node.js 生成干净的源码 ZIP，无需安装依赖：

```powershell
node scripts/package-release.mjs
```

输出为 `releases/ModelBridge-v1.11.0.zip`。脚本从当前工作区读取 Git 跟踪文件和未被忽略的新文件，因此包含尚未提交的更改；先确认并提交最终内容，再制作正式 Release 包。ZIP 不包含 `.git/`、本地配置或测试产物。用户解压后可双击 Windows 启动器；macOS/Linux 按 README 操作。

为避免覆盖已经发布的文件，目标 ZIP 已存在时脚本会报错；需要重新打包时，先自行重命名或删除旧 ZIP。

## 后续更新与版本发布

普通更新：

```powershell
git add -A
git commit -m "Describe the changes"
git push
```

首次推送成功后，在仓库 Actions 页面查看 CI。CI 通过后，可为当前提交打版本标签并在 GitHub 的 Releases 页面创建版本，附上更新说明和源码 ZIP：

```powershell
git tag v1.11.0
git push origin v1.11.0
```

后续版本应同时更新 package.json、server.mjs 和 web/app.js 中的版本号；版本一致性由测试检查。

参考：[GitHub 官方：推送本地项目](https://docs.github.com/en/migrations/importing-source-code/using-the-command-line-to-import-source-code/adding-locally-hosted-code-to-github)。

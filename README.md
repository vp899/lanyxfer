# 📡 Localxfer - 局域网文件传输

手机扫码，双向传输文件。支持文件夹上传、文件下载、自定义共享目录。

[![Build](../../actions/workflows/build.yml/badge.svg)](../../actions/workflows/build.yml)

## ⚡ 功能

- 📱 **手机→电脑**：上传文件/文件夹，保留目录结构
- 📥 **电脑→手机**：手机浏览电脑文件，按需下载
- 📂 **自定义目录**：随时切换共享文件夹
- 🖥️ **原生窗口**：Electron 桌面应用
- 🔒 **纯局域网**：不经过外网

## 📦 下载

前往 [Releases](../../releases) 下载：

| 平台 | 文件 |
|------|------|
| Windows | `Localxfer Setup *.exe` 或 `Localxfer *.exe` |
| macOS | `Localxfer-*-arm64.dmg` |

## 🛠 开发

```bash
npm install
npm start          # 运行
npm run dist       # 打包当前平台
npm run dist:win   # Windows
npm run dist:mac   # macOS
```

## 发布

```bash
git tag v1.0.0
git push origin v1.0.0
```

## 使用方法

1. 双击打开 Localxfer
2. 手机扫码或输入地址
3. 上传：选择文件/文件夹 → 上传
4. 下载：切换到下载标签 → 浏览 → 点击下载
5. 设置：点「更改」切换共享目录

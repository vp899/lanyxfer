# 📸 LAN Photo Transfer - 局域网照片传输

手机扫码，一键传照片/视频到电脑。基于 Electron，全平台原生体验。

[![Build](../../actions/workflows/build.yml/badge.svg)](../../actions/workflows/build.yml)

## ⚡ 功能

- 📱 手机扫码或打开网址上传
- 🖼️ 支持照片、视频等大文件（最大 4GB）
- 🖥️ 原生桌面窗口，显示 QR 码
- 📂 文件保存到桌面 / LAN_Photos
- 🔒 纯局域网传输，不经过外网

## 📦 下载

前往 [Releases](../../releases) 下载：

| 平台 | 文件 |
|------|------|
| Windows | `LAN Photo Transfer Setup *.exe` 或 `LAN Photo Transfer *.exe`（免安装） |
| macOS | `LAN Photo Transfer-*-arm64.dmg` |

## 🛠 开发

```bash
# 安装依赖
npm install

# 运行
npm start

# 打包
npm run dist          # 当前平台
npm run dist:win      # Windows
npm run dist:mac      # macOS
```

## 📤 GitHub Actions 自动发布

```bash
git tag v1.0.0
git push origin v1.0.0
```

自动编译 Windows + macOS，生成 Release。

## 🔧 配置

编辑 `main.js` 顶部：

```javascript
const PORT = 9876;           // 服务端口
const MAX_UPLOAD = 4GB;      // 最大上传大小
```

## 使用方法

1. 双击打开程序
2. 窗口显示 QR 码和地址
3. 手机扫码 → 选择照片 → 上传
4. 文件保存到 `桌面/LAN_Photos`

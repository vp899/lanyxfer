# 📸 LAN Photo Transfer - 局域网照片传输工具

> 手机拍的照片，一键传到电脑。免安装、免数据线、免第三方服务。

[![Build All Platforms](../../actions/workflows/build.yml/badge.svg)](../../actions/workflows/build.yml)

## ⚡ 快速开始

### 方式一：下载编译好的程序（推荐）

前往 [Releases](../../releases) 页面下载对应平台的可执行文件，双击运行：

| 平台 | 文件 |
|------|------|
| Windows 64位 | `lan_photo_transfer_win64.exe` |
| Windows 32位 | `lan_photo_transfer_win32.exe` |
| Windows ARM64 | `lan_photo_transfer_win_arm64.exe` |
| macOS Intel | `lan_photo_transfer_macos_x64` |
| macOS Apple Silicon | `lan_photo_transfer_macos_arm64` |
| Linux x64 | `lan_photo_transfer_linux_x64` |

**无需安装 Python，无需安装任何依赖。**

### 方式二：用 Python 直接运行

```bash
# 需要 Python 3.8+，零依赖
python lan_photo_transfer.py
```

## 📱 使用方法

1. 双击运行程序
2. 电脑自动打开浏览器，显示二维码和网址
3. **手机扫描二维码**，或在手机浏览器输入显示的网址
4. 在手机页面选择照片，点击上传
5. 照片自动保存到 **桌面 / LAN_Photos** 文件夹

```
┌──────────┐    WiFi     ┌──────────┐
│   手机    │ ──────────→ │   电脑    │
│  扫码上传  │  局域网直传  │  自动保存  │
└──────────┘            └──────────┘
```

## 🔧 自定义配置

编辑 `lan_photo_transfer.py` 顶部：

```python
PORT = 9876                              # 服务端口
UPLOAD_DIR = Path.home() / "Desktop" / "LAN_Photos"  # 保存路径
MAX_UPLOAD_SIZE = 4 * 1024 * 1024 * 1024      # 最大上传 4GB
```

## 🛠 从源码构建

### 本地构建

```bash
pip install pyinstaller
pyinstaller --onefile --name lan_photo_transfer lan_photo_transfer.py
# 产出在 dist/ 目录
```

### GitHub Actions 自动构建

Push 一个 tag 即可自动编译全平台并发布 Release：

```bash
git tag v1.0.0
git push origin v1.0.0
```

GitHub Actions 会自动：
1. 编译 Windows (x86 / x64 / ARM64)
2. 编译 macOS (Intel / Apple Silicon)
3. 编译 Linux (x64)
4. 创建 Release 并上传所有产物

## 📋 支持的格式

图片：JPG / PNG / GIF / WebP / HEIC / HEIF / BMP / TIFF
视频：MP4 / MOV / AVI / MKV

## 🔒 安全说明

- ✅ 纯局域网传输，不经过任何外网服务器
- ✅ 不收集、不上传任何数据
- ✅ 关闭程序即停止服务
- ✅ 源码完全公开，可自行审计

## ❓ 常见问题

**Q: 手机打不开页面？**
A: 确认手机和电脑连接同一个 WiFi。公司网络可能有 AP 隔离，试试手机热点。

**Q: 上传很慢？**
A: 取决于路由器速度。建议用 5GHz WiFi。

**Q: 端口被占用？**
A: 修改源码中的 `PORT` 值。

**Q: macOS 提示"无法验证开发者"？**
A: 右键点击文件 → 打开 → 确认打开。或在 系统设置 → 隐私与安全性 中允许。

## 📄 License

MIT

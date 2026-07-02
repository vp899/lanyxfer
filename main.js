const { app, BrowserWindow, shell, clipboard, dialog, Tray, Menu, nativeImage, ipcMain } = require('electron');
const http = require('http');
const path = require('path');
const fs = require('fs');
const os = require('os');
const QRCode = require('qrcode');

const PORT = 9876;
const MAX_UPLOAD = 4 * 1024 * 1024 * 1024; // 4GB

// ─── 获取局域网 IP ──────────────────────────────────────
function getLocalIP() {
  const interfaces = os.networkInterfaces();
  const candidates = [];
  
  // 虚拟网卡关键词
  const virtualKeywords = [
    'vmware', 'virtualbox', 'vbox', 'docker', 'br-', 'veth',
    'loopback', 'lo', 'tun', 'tap', 'wg', 'utun', 'bridge',
    'hamachi', 'radmin', 'nord', 'tailscale', 'zerotier'
  ];
  
  for (const name of Object.keys(interfaces)) {
    // 跳过虚拟网卡

    const lowerName = name.toLowerCase();
    if (virtualKeywords.some(k => lowerName.includes(k))) continue;
    
    for (const iface of interfaces[name]) {
      if (iface.family !== 'IPv4' || iface.internal) continue;
      
      const ip = iface.address;
      const parts = ip.split('.').map(Number);
      
      // 优先级：192.168.x.x > 10.x.x.x > 172.16-31.x.x > 其他
      let priority = 0;
      if (parts[0] === 192 && parts[1] === 168) priority = 3;
      else if (parts[0] === 10) priority = 2;
      else if (parts[0] === 172 && parts[1] >= 16 && parts[1] <= 31) priority = 1;
      
      candidates.push({ ip, name, priority });
    }
  }
  
  // 按优先级排序，取最高的
  candidates.sort((a, b) => b.priority - a.priority);
  
  if (candidates.length > 0) {
    console.log(`检测到 ${candidates.length} 个网络接口，使用: ${candidates[0].ip} (${candidates[0].name})`);
    return candidates[0].ip;
  }
  
  return '127.0.0.1';
}

// ─── 上传目录 ──────────────────────────────────────────
function getUploadDir() {
  const desktop = path.join(os.homedir(), 'Desktop');
  const dir = path.join(desktop, 'LAN_Photos');
  if (!fs.existsSync(dir)) fs.mkdirSync(dir, { recursive: true });
  return dir;
}

// ─── 解析 multipart ────────────────────────────────────
function bufferSplit(buf, delim) {
  const parts = [];
  let start = 0;
  while (start <= buf.length) {
    const idx = buf.indexOf(delim, start);
    if (idx === -1) {
      parts.push(buf.slice(start));
      break;
    }
    parts.push(buf.slice(start, idx));
    start = idx + delim.length;
  }
  return parts;
}

function parseMultipart(body, boundary) {
  const delimiter = Buffer.from('--' + boundary);
  const eol = Buffer.from('\r\n');
  const doubleEol = Buffer.from('\r\n\r\n');
  const files = [];
  const parts = bufferSplit(body, delimiter);

  for (let seg of parts) {
    // 去掉开头的 \r\n
    if (seg.length >= 2 && seg[0] === 0x0d && seg[1] === 0x0a) seg = seg.slice(2);
    // 去掉结尾的 --
    if (seg.length >= 2 && seg[seg.length - 2] === 0x2d && seg[seg.length - 1] === 0x2d) seg = seg.slice(0, -2);
    // 去掉尾部 \r\n
    if (seg.length >= 2 && seg[seg.length - 2] === 0x0d && seg[seg.length - 1] === 0x0a) seg = seg.slice(0, -2);
    if (seg.length === 0) continue;

    const sepIdx = seg.indexOf(doubleEol);
    if (sepIdx < 0) continue;

    const hdr = seg.slice(0, sepIdx).toString('utf8');
    const fdata = seg.slice(sepIdx + 4);

    let filename = null;
    for (const line of hdr.split('\r\n')) {
      const m = line.match(/filename="(.+?)"/);
      if (m) { filename = m[1]; break; }
    }
    if (!filename || fdata.length === 0) continue;

    filename = path.basename(filename).replace(/\x00/g, '');
    if (!filename) continue;

    files.push({ filename, data: fdata });
  }
  return files;
}

// ─── HTTP 服务 ─────────────────────────────────────────
let mainWindow = null;
let uploadCount = 0;

function createServer(uploadDir) {
  const server = http.createServer((req, res) => {
    if (req.method === 'GET') {
      if (req.url === '/' || req.url === '/index.html') {
        const ua = (req.headers['user-agent'] || '').toLowerCase();
        const isMobile = /mobile|iphone|android|ipad/.test(ua);
        if (isMobile) {
          res.writeHead(302, { Location: '/upload' });
          res.end();
          return;
        }
        res.writeHead(200, { 'Content-Type': 'text/html; charset=utf-8' });
        res.end(getIndexPage());
        return;
      }
      if (req.url === '/upload' || req.url === '/mobile') {
        res.writeHead(200, { 'Content-Type': 'text/html; charset=utf-8' });
        res.end(getMobilePage());
        return;
      }
      res.writeHead(404);
      res.end();
      return;
    }

    if (req.method === 'POST' && req.url === '/upload') {
      const ct = req.headers['content-type'] || '';
      const cl = parseInt(req.headers['content-length'] || '0');
      if (cl > MAX_UPLOAD) { res.writeHead(413); res.end('{"error":"文件太大"}'); return; }

      const boundaryMatch = ct.match(/boundary=(.+)/);
      if (!boundaryMatch) { res.writeHead(400); res.end('{"error":"无效请求"}'); return; }

      const chunks = [];
      req.on('data', chunk => chunks.push(chunk));
      req.on('end', () => {
        const body = Buffer.concat(chunks);
        try {
          const files = parseMultipart(body, boundaryMatch[1]);
          const saved = [];
          for (const f of files) {
            let savePath = path.join(uploadDir, f.filename);
            if (fs.existsSync(savePath)) {
              const ext = path.extname(f.filename);
              const base = path.basename(f.filename, ext);
              let n = 1;
              while (fs.existsSync(savePath)) {
                savePath = path.join(uploadDir, `${base}_${n}${ext}`);
                n++;
              }
            }
            fs.writeFileSync(savePath, f.data);
            saved.push(path.basename(savePath));
            uploadCount++;
            if (mainWindow) mainWindow.webContents.send('upload-done', uploadCount);
          }
          res.writeHead(200, { 'Content-Type': 'application/json' });
          res.end(JSON.stringify({ success: true, count: saved.length, files: saved }));
        } catch (e) {
          res.writeHead(500);
          res.end(JSON.stringify({ error: e.message }));
        }
      });
      return;
    }

    res.writeHead(404);
    res.end();
  });

  server.on('error', (e) => {
    if (e.code === 'EADDRINUSE') {
      dialog.showErrorBox('端口占用', `端口 ${PORT} 已被占用，请关闭占用程序后重试。`);
      app.quit();
    }
  });

  return server;
}

// ─── 窗口 ─────────────────────────────────────────────
function createWindow(lanUrl) {
  mainWindow = new BrowserWindow({
    width: 420,
    height: 640,
    resizable: false,
    title: '局域网照片传输',
    icon: path.join(__dirname, 'renderer', 'icon.png'),
    webPreferences: {
      preload: path.join(__dirname, 'preload.js'),
      contextIsolation: true,
      nodeIntegration: false,
    },
  });

  mainWindow.loadFile(path.join(__dirname, 'renderer', 'index.html'));
  mainWindow.setMenuBarVisibility(false);

  // 把 URL 传给渲染进程
  mainWindow.webContents.on('did-finish-load', () => {
    mainWindow.webContents.send('init', { lanUrl, uploadDir: getUploadDir() });
  });

  mainWindow.on('closed', () => { mainWindow = null; });
}

// ─── IPC ───────────────────────────────────────────────
ipcMain.handle('copy-text', (_, text) => {
  clipboard.writeText(text);
  return true;
});

ipcMain.handle('open-external', (_, url) => {
  shell.openExternal(url);
});

ipcMain.handle('open-folder', (_, folderPath) => {
  shell.openPath(folderPath);
});

ipcMain.handle('generate-qr', async (_, text) => {
  try {
    return await QRCode.toDataURL(text, { width: 200, margin: 2, color: { dark: '#000000', light: '#ffffff' } });
  } catch (e) {
    return null;
  }
});

ipcMain.handle('get-all-ips', () => {
  const interfaces = os.networkInterfaces();
  const virtualKeywords = [
    'vmware', 'virtualbox', 'vbox', 'docker', 'br-', 'veth',
    'loopback', 'lo', 'tun', 'tap', 'wg', 'utun', 'bridge',
    'hamachi', 'radmin', 'nord', 'tailscale', 'zerotier'
  ];
  const result = [];
  for (const name of Object.keys(interfaces)) {
    const lowerName = name.toLowerCase();
    if (virtualKeywords.some(k => lowerName.includes(k))) continue;
    for (const iface of interfaces[name]) {
      if (iface.family !== 'IPv4' || iface.internal) continue;
      result.push({ ip: iface.address, name });
    }
  }
  return result;
});

// ─── HTML 页面（手机上传用）────────────────────────────
function getMobilePage() {
  return `<!DOCTYPE html>
<html lang="zh-CN">
<head>
<meta charset="UTF-8">
<meta name="viewport" content="width=device-width,initial-scale=1,user-scalable=no">
<title>上传照片</title>
<style>
*{margin:0;padding:0;box-sizing:border-box}
body{font-family:-apple-system,BlinkMacSystemFont,"Segoe UI",Roboto,sans-serif;background:linear-gradient(135deg,#667eea,#764ba2);min-height:100vh;display:flex;flex-direction:column;align-items:center;padding:16px;color:#333}
.c{background:#fff;border-radius:20px;padding:28px 20px;width:100%;max-width:420px;box-shadow:0 20px 60px rgba(0,0,0,.3);margin-top:16px}
h1{text-align:center;font-size:1.4em;margin-bottom:6px}
.sub{text-align:center;color:#888;font-size:.88em;margin-bottom:20px}
.drop{border:3px dashed #ddd;border-radius:16px;padding:36px 16px;text-align:center;cursor:pointer;background:#fafafa;position:relative}
.drop:hover,.drop.over{border-color:#667eea;background:#f0f0ff}
.drop .ic{font-size:48px;margin-bottom:10px}
.drop p{color:#666;font-size:.92em}
.drop input{position:absolute;top:0;left:0;width:100%;height:100%;opacity:0;cursor:pointer}
.pv{margin-top:18px;display:none}.pv.on{display:block}
.pg{display:grid;grid-template-columns:repeat(3,1fr);gap:6px;margin-bottom:14px}
.pi{position:relative;aspect-ratio:1;border-radius:8px;overflow:hidden}
.pi img{width:100%;height:100%;object-fit:cover}
.pi .bd{position:absolute;top:3px;right:3px;background:rgba(0,0,0,.6);color:#fff;font-size:10px;padding:2px 5px;border-radius:8px}
.btn{display:block;width:100%;padding:13px;border:none;border-radius:12px;font-size:1.05em;font-weight:600;cursor:pointer}
.bp{background:linear-gradient(135deg,#667eea,#764ba2);color:#fff}
.bp:hover{transform:scale(1.02)}
.bp:disabled{background:#ccc;cursor:not-allowed;transform:none}
.pro{display:none;margin-top:14px}.pro.on{display:block}
.pb{height:7px;background:#eee;border-radius:4px;overflow:hidden}
.pf{height:100%;background:linear-gradient(90deg,#667eea,#764ba2);border-radius:4px;transition:width .3s;width:0}
.pt{text-align:center;margin-top:6px;color:#666;font-size:.82em}
.rs{display:none;margin-top:14px;padding:14px;border-radius:12px;text-align:center;font-size:.95em}
.rs.ok{background:#e8f5e9;color:#2e7d32;display:block}
.rs.er{background:#ffebee;color:#c62828;display:block}
.fc{text-align:center;margin-top:10px;color:#667eea;font-weight:600;font-size:.88em}
</style>
</head>
<body>
<div class="c">
<h1>&#x1F4F8; 上传照片到电脑</h1>
<p class="sub">选择照片后点击上传</p>
<div class="drop" id="dz">
<div class="ic">&#x1F4C1;</div>
<p><strong>点击选择照片/视频</strong></p>
<p style="font-size:.78em;color:#aaa;margin-top:6px">JPG / PNG / HEIC / MP4 / MOV ...</p>
<input type="file" id="fi" multiple accept="image/*,video/*,.heic,.heif,.mov,.mp4">
</div>
<div class="fc" id="fc"></div>
<div class="pv" id="pv">
<div class="pg" id="pg"></div>
<button class="btn bp" id="ub" onclick="go()">&#x1F680; 上传到电脑</button>
</div>
<div class="pro" id="pr">
<div class="pb"><div class="pf" id="pf"></div></div>
<div class="pt" id="ptt">准备中...</div>
</div>
<div class="rs" id="rs"></div>
</div>
<script>
var dz=document.getElementById("dz"),fi=document.getElementById("fi"),pv=document.getElementById("pv"),pg=document.getElementById("pg"),fc=document.getElementById("fc"),ub=document.getElementById("ub"),pr=document.getElementById("pr"),pf=document.getElementById("pf"),ptt=document.getElementById("ptt"),rs=document.getElementById("rs"),files=[];
dz.addEventListener("dragover",function(e){e.preventDefault();dz.classList.add("over")});
dz.addEventListener("dragleave",function(){dz.classList.remove("over")});
dz.addEventListener("drop",function(e){e.preventDefault();dz.classList.remove("over");hf(e.dataTransfer.files)});
fi.addEventListener("change",function(){hf(fi.files)});
function hf(f){files=Array.from(f);pg.innerHTML="";files.forEach(function(x,i){var d=document.createElement("div");d.className="pi";if(x.type.startsWith("image/")){var img=document.createElement("img");img.src=URL.createObjectURL(x);d.appendChild(img)}else{d.innerHTML='<div style="display:flex;align-items:center;justify-content:center;height:100%;background:#f0f0f0;font-size:24px">&#x1F4C4;</div>'}var b=document.createElement("div");b.className="bd";b.textContent=fs(x.size);d.appendChild(b);pg.appendChild(d)});pv.classList.add("on");fc.textContent="已选择 "+files.length+" 个文件";rs.className="rs"}
function fs(b){if(b<1024)return b+"B";if(b<1048576)return(b/1024).toFixed(1)+"KB";return(b/1048576).toFixed(1)+"MB"}
async function go(){if(!files.length)return;ub.disabled=1;pr.classList.add("on");rs.className="rs";var ok=0,fail=0;for(var i=0;i<files.length;i++){ptt.textContent="上传 "+(i+1)+"/"+files.length+": "+files[i].name;try{var fd=new FormData();fd.append("file",files[i]);await new Promise(function(res,rej){var x=new XMLHttpRequest();x.upload.onprogress=function(e){if(e.lengthComputable)pf.style.width=((ok+e.loaded/e.total)/files.length*100)+"%"};x.onload=function(){if(x.status==200)ok++;else fail++;res()};x.onerror=function(){fail++;res()};x.open("POST","/upload");x.send(fd)})}catch(e){fail++}}pf.style.width="100%";ptt.textContent="完成";if(fail==0){rs.className="rs ok";rs.innerHTML="&#x2705; 成功上传 "+ok+" 个文件到电脑！"}else{rs.className="rs er";rs.innerHTML="&#x26A0;&#xFE0F; 成功 "+ok+"，失败 "+fail}ub.disabled=0;files=[];fi.value="";setTimeout(function(){pr.classList.remove("on")},2500)}
</script>
</body>
</html>`;
}

function getIndexPage() {
  const ip = getLocalIP();
  const url = `http://${ip}:${PORT}`;
  return `<!DOCTYPE html><html><body style="font-family:sans-serif;text-align:center;padding:40px">
<h2>📸 局域网照片传输</h2>
<p>服务运行中: <a href="${url}/upload">${url}/upload</a></p>
</body></html>`;
}

// ─── 启动 ─────────────────────────────────────────────
app.whenReady().then(() => {
  const uploadDir = getUploadDir();
  const ip = getLocalIP();
  const lanUrl = `http://${ip}:${PORT}`;

  const server = createServer(uploadDir);
  server.listen(PORT, '0.0.0.0', () => {
    console.log(`Server running at ${lanUrl}`);
    createWindow(lanUrl);
  });

  app.on('activate', () => {
    if (BrowserWindow.getAllWindows().length === 0) createWindow(lanUrl);
  });
});

app.on('window-all-closed', () => {
  app.quit();
});

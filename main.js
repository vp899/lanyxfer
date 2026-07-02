const { app, BrowserWindow, shell, clipboard, dialog, ipcMain } = require('electron');
const http = require('http');
const path = require('path');
const fs = require('fs');
const os = require('os');
const QRCode = require('qrcode');

const PORT = 9876;
const MAX_UPLOAD = 4 * 1024 * 1024 * 1024; // 4GB
const CONFIG_FILE = path.join(app.getPath('userData'), 'config.json');

// ─── 配置 ─────────────────────────────────────────────
function loadConfig() {
  try {
    if (fs.existsSync(CONFIG_FILE)) {
      return JSON.parse(fs.readFileSync(CONFIG_FILE, 'utf8'));
    }
  } catch (e) {}
  return {};
}

function saveConfig(cfg) {
  fs.mkdirSync(path.dirname(CONFIG_FILE), { recursive: true });
  fs.writeFileSync(CONFIG_FILE, JSON.stringify(cfg, null, 2));
}

function getSharedDir() {
  const cfg = loadConfig();
  if (cfg.sharedDir && fs.existsSync(cfg.sharedDir)) return cfg.sharedDir;
  const dir = path.join(os.homedir(), 'Desktop', 'Localxfer');
  fs.mkdirSync(dir, { recursive: true });
  return dir;
}

// ─── 获取局域网 IP ──────────────────────────────────────
function getLocalIP() {
  const interfaces = os.networkInterfaces();
  const candidates = [];
  const virtualKeywords = [
    'vmware', 'virtualbox', 'vbox', 'docker', 'br-', 'veth',
    'loopback', 'lo', 'tun', 'tap', 'wg', 'utun', 'bridge',
    'hamachi', 'radmin', 'nord', 'tailscale', 'zerotier'
  ];
  for (const name of Object.keys(interfaces)) {
    if (virtualKeywords.some(k => name.toLowerCase().includes(k))) continue;
    for (const iface of interfaces[name]) {
      if (iface.family !== 'IPv4' || iface.internal) continue;
      const parts = iface.address.split('.').map(Number);
      let priority = 0;
      if (parts[0] === 192 && parts[1] === 168) priority = 3;
      else if (parts[0] === 10) priority = 2;
      else if (parts[0] === 172 && parts[1] >= 16 && parts[1] <= 31) priority = 1;
      candidates.push({ ip: iface.address, name, priority });
    }
  }
  candidates.sort((a, b) => b.priority - a.priority);
  return candidates.length > 0 ? candidates[0].ip : '127.0.0.1';
}

// ─── Multipart 解析 ────────────────────────────────────
function bufferSplit(buf, delim) {
  const parts = [];
  let start = 0;
  while (start <= buf.length) {
    const idx = buf.indexOf(delim, start);
    if (idx === -1) { parts.push(buf.slice(start)); break; }
    parts.push(buf.slice(start, idx));
    start = idx + delim.length;
  }
  return parts;
}

function parseMultipart(body, boundary) {
  const delimiter = Buffer.from('--' + boundary);
  const doubleEol = Buffer.from('\r\n\r\n');
  const files = [];
  const parts = bufferSplit(body, delimiter);

  for (let seg of parts) {
    if (seg.length >= 2 && seg[0] === 0x0d && seg[1] === 0x0a) seg = seg.slice(2);
    if (seg.length >= 2 && seg[seg.length - 2] === 0x2d && seg[seg.length - 1] === 0x2d) seg = seg.slice(0, -2);
    if (seg.length >= 2 && seg[seg.length - 2] === 0x0d && seg[seg.length - 1] === 0x0a) seg = seg.slice(0, -2);
    if (seg.length === 0) continue;

    const sepIdx = seg.indexOf(doubleEol);
    if (sepIdx < 0) continue;

    const hdr = seg.slice(0, sepIdx).toString('utf8');
    const fdata = seg.slice(sepIdx + 4);

    let filename = null;
    let relativePath = null;
    for (const line of hdr.split('\r\n')) {
      // 文件夹上传时 webkitRelativePath 会作为 form field，但 filename 包含相对路径
      const m = line.match(/filename="(.+?)"/);
      if (m) { filename = m[1]; }
    }
    if (!filename || fdata.length === 0) continue;

    // 保留文件夹结构：filename 可能是 "folder/subfolder/file.jpg"
    relativePath = filename;
    filename = path.basename(filename).replace(/\x00/g, '');
    if (!filename) continue;

    files.push({ filename, relativePath, data: fdata });
  }
  return files;
}

// ─── 安全路径检查 ──────────────────────────────────────
function safePath(base, rel) {
  const resolved = path.resolve(base, rel);
  if (!resolved.startsWith(path.resolve(base))) return null;
  return resolved;
}

// ─── HTTP 服务 ─────────────────────────────────────────
let mainWindow = null;
let uploadCount = 0;

function createServer() {
  const server = http.createServer((req, res) => {
    const url = new URL(req.url, `http://${req.headers.host}`);
    const pathname = url.pathname;

    // ── GET 请求 ──
    if (req.method === 'GET') {
      // 手机端页面
      if (pathname === '/upload' || pathname === '/mobile') {
        res.writeHead(200, { 'Content-Type': 'text/html; charset=utf-8' });
        res.end(getMobilePage());
        return;
      }

      // 文件列表 API
      if (pathname === '/api/files') {
        const dir = getSharedDir();
        const rel = url.searchParams.get('path') || '';
        const target = safePath(dir, rel);
        if (!target) { res.writeHead(403); res.end('{"error":"禁止访问"}'); return; }
        try {
          const items = fs.readdirSync(target, { withFileTypes: true });
          const list = items.map(item => {
            const fullPath = path.join(target, item.name);
            const stat = fs.statSync(fullPath);
            return {
              name: item.name,
              isDir: item.isDirectory(),
              size: stat.size,
              mtime: stat.mtimeMs,
              path: path.relative(dir, fullPath).replace(/\\/g, '/'),
            };
          }).sort((a, b) => {
            if (a.isDir !== b.isDir) return a.isDir ? -1 : 1;
            return a.name.localeCompare(b.name);
          });
          res.writeHead(200, { 'Content-Type': 'application/json' });
          res.end(JSON.stringify({ success: true, path: rel, items: list }));
        } catch (e) {
          res.writeHead(500);
          res.end(JSON.stringify({ error: e.message }));
        }
        return;
      }

      // 文件下载
      if (pathname === '/download') {
        const dir = getSharedDir();
        const rel = url.searchParams.get('path') || '';
        const filePath = safePath(dir, rel);
        if (!filePath) { res.writeHead(403); res.end('禁止'); return; }
        try {
          const stat = fs.statSync(filePath);
          if (stat.isDirectory()) { res.writeHead(400); res.end('不能下载文件夹'); return; }
          const fname = path.basename(filePath);
          res.writeHead(200, {
            'Content-Type': 'application/octet-stream',
            'Content-Disposition': `attachment; filename*=UTF-8''${encodeURIComponent(fname)}`,
            'Content-Length': stat.size,
          });
          fs.createReadStream(filePath).pipe(res);
        } catch (e) {
          res.writeHead(404);
          res.end('文件不存在');
        }
        return;
      }

      // 桌面端页面
      if (pathname === '/' || pathname === '/index.html') {
        const ua = (req.headers['user-agent'] || '').toLowerCase();
        if (/mobile|iphone|android|ipad/.test(ua)) {
          res.writeHead(302, { Location: '/upload' });
          res.end();
          return;
        }
        res.writeHead(200, { 'Content-Type': 'text/html; charset=utf-8' });
        res.end(getIndexPage());
        return;
      }

      res.writeHead(404);
      res.end();
      return;
    }

    // ── POST 请求 ──
    if (req.method === 'POST') {
      // 上传
      if (pathname === '/upload') {
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
            const dir = getSharedDir();
            const saved = [];
            for (const f of files) {
              // 保留文件夹结构
              let relPath = f.relativePath.replace(/\\/g, '/');
              // 去掉开头的 /
              if (relPath.startsWith('/')) relPath = relPath.slice(1);
              // 安全检查
              let savePath = safePath(dir, relPath);
              if (!savePath) savePath = path.join(dir, f.filename);

              // 创建子目录
              const dirName = path.dirname(savePath);
              if (!fs.existsSync(dirName)) fs.mkdirSync(dirName, { recursive: true });

              // 重名处理
              if (fs.existsSync(savePath)) {
                const ext = path.extname(savePath);
                const base = path.basename(savePath, ext);
                const parent = path.dirname(savePath);
                let n = 1;
                while (fs.existsSync(savePath)) {
                  savePath = path.join(parent, `${base}_${n}${ext}`);
                  n++;
                }
              }

              fs.writeFileSync(savePath, f.data);
              saved.push(path.relative(dir, savePath).replace(/\\/g, '/'));
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

      // 设置
      if (pathname === '/api/settings') {
        const chunks = [];
        req.on('data', chunk => chunks.push(chunk));
        req.on('end', () => {
          try {
            const data = JSON.parse(Buffer.concat(chunks).toString());
            if (data.sharedDir) {
              if (!fs.existsSync(data.sharedDir)) {
                fs.mkdirSync(data.sharedDir, { recursive: true });
              }
              saveConfig({ sharedDir: data.sharedDir });
              if (mainWindow) mainWindow.webContents.send('dir-changed', data.sharedDir);
            }
            res.writeHead(200, { 'Content-Type': 'application/json' });
            res.end(JSON.stringify({ success: true, sharedDir: getSharedDir() }));
          } catch (e) {
            res.writeHead(400);
            res.end(JSON.stringify({ error: e.message }));
          }
        });
        return;
      }
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
    height: 680,
    resizable: false,
    title: 'Localxfer',
    icon: path.join(__dirname, 'renderer', 'icon.png'),
    webPreferences: {
      preload: path.join(__dirname, 'preload.js'),
      contextIsolation: true,
      nodeIntegration: false,
    },
  });

  mainWindow.loadFile(path.join(__dirname, 'renderer', 'index.html'));
  mainWindow.setMenuBarVisibility(false);

  mainWindow.webContents.on('did-finish-load', () => {
    mainWindow.webContents.send('init', {
      lanUrl,
      sharedDir: getSharedDir(),
    });
  });

  mainWindow.on('closed', () => { mainWindow = null; });
}

// ─── IPC ───────────────────────────────────────────────
ipcMain.handle('copy-text', (_, text) => { clipboard.writeText(text); return true; });
ipcMain.handle('open-external', (_, url) => { shell.openExternal(url); });
ipcMain.handle('open-folder', (_, p) => { shell.openPath(p); });

ipcMain.handle('generate-qr', async (_, text) => {
  try { return await QRCode.toDataURL(text, { width: 200, margin: 2 }); }
  catch (e) { return null; }
});

ipcMain.handle('get-all-ips', () => {
  const interfaces = os.networkInterfaces();
  const vk = ['vmware','virtualbox','vbox','docker','br-','veth','loopback','lo','tun','tap','wg','utun','bridge','hamachi','radmin','nord','tailscale','zerotier'];
  const result = [];
  for (const name of Object.keys(interfaces)) {
    if (vk.some(k => name.toLowerCase().includes(k))) continue;
    for (const iface of interfaces[name]) {
      if (iface.family !== 'IPv4' || iface.internal) continue;
      result.push({ ip: iface.address, name });
    }
  }
  return result;
});

ipcMain.handle('pick-folder', async () => {
  const result = await dialog.showOpenDialog(mainWindow, {
    properties: ['openDirectory'],
    defaultPath: getSharedDir(),
  });
  if (!result.canceled && result.filePaths.length > 0) {
    const dir = result.filePaths[0];
    saveConfig({ sharedDir: dir });
    return dir;
  }
  return null;
});

ipcMain.handle('get-shared-dir', () => getSharedDir());

// ─── 手机端页面 ───────────────────────────────────────
function getMobilePage() {
  return `<!DOCTYPE html>
<html lang="zh-CN">
<head>
<meta charset="UTF-8">
<meta name="viewport" content="width=device-width,initial-scale=1,user-scalable=no">
<title>Localxfer</title>
<style>
*{margin:0;padding:0;box-sizing:border-box}
body{font-family:-apple-system,BlinkMacSystemFont,"Segoe UI",Roboto,sans-serif;background:linear-gradient(135deg,#667eea,#764ba2);min-height:100vh;padding:16px;color:#333}
.tabs{display:flex;gap:8px;margin-bottom:16px}
.tab{flex:1;padding:10px;border:none;border-radius:10px;font-size:.95em;font-weight:600;cursor:pointer;background:rgba(255,255,255,.3);color:#fff;transition:.2s}
.tab.on{background:#fff;color:#333}
.panel{display:none;background:#fff;border-radius:20px;padding:24px 16px;box-shadow:0 20px 60px rgba(0,0,0,.3)}
.panel.on{display:block}
h1{text-align:center;font-size:1.3em;margin-bottom:16px}
.drop{border:3px dashed #ddd;border-radius:16px;padding:32px 12px;text-align:center;cursor:pointer;background:#fafafa;position:relative}
.drop:hover,.drop.over{border-color:#667eea;background:#f0f0ff}
.drop .ic{font-size:42px;margin-bottom:8px}
.drop p{color:#666;font-size:.88em}
.drop input{position:absolute;top:0;left:0;width:100%;height:100%;opacity:0;cursor:pointer}
.fc{text-align:center;margin-top:10px;color:#667eea;font-weight:600;font-size:.85em}
.btn{display:block;width:100%;padding:12px;border:none;border-radius:12px;font-size:1em;font-weight:600;cursor:pointer;margin-top:12px}
.bp{background:linear-gradient(135deg,#667eea,#764ba2);color:#fff}
.bp:disabled{background:#ccc;cursor:not-allowed}
.pro{display:none;margin-top:12px}.pro.on{display:block}
.pb{height:6px;background:#eee;border-radius:4px;overflow:hidden}
.pf{height:100%;background:linear-gradient(90deg,#667eea,#764ba2);border-radius:4px;transition:width .3s;width:0}
.pt{text-align:center;margin-top:4px;color:#666;font-size:.8em}
.rs{display:none;margin-top:12px;padding:12px;border-radius:12px;text-align:center;font-size:.9em}
.rs.ok{background:#e8f5e9;color:#2e7d32;display:block}
.rs.er{background:#ffebee;color:#c62828;display:block}
/* 文件列表 */
.breadcrumb{display:flex;gap:4px;margin-bottom:12px;flex-wrap:wrap;align-items:center}
.bc{background:#f0f0f0;padding:3px 8px;border-radius:6px;font-size:.8em;cursor:pointer;color:#667eea}
.bc:hover{background:#e0e0e0}
.flist{max-height:50vh;overflow-y:auto}
.fitem{display:flex;align-items:center;padding:10px 8px;border-bottom:1px solid #f5f5f5;cursor:pointer;transition:.15s}
.fitem:hover{background:#f8f8ff}
.fitem .icon{font-size:24px;margin-right:10px;width:32px;text-align:center}
.fitem .name{flex:1;font-size:.9em;overflow:hidden;text-overflow:ellipsis;white-space:nowrap}
.fitem .size{color:#999;font-size:.78em;margin-left:8px}
.fitem .dl{background:#667eea;color:#fff;border:none;border-radius:6px;padding:4px 10px;font-size:.78em;cursor:pointer;margin-left:8px}
.fempty{text-align:center;color:#999;padding:40px;font-size:.9em}
</style>
</head>
<body>
<div class="tabs">
<button class="tab on" onclick="showTab(0)">&#x1F4E4; 上传</button>
<button class="tab" onclick="showTab(1)">&#x1F4E5; 下载</button>
</div>

<!-- 上传面板 -->
<div class="panel on" id="p0">
<h1>&#x1F4F8; 上传到电脑</h1>
<div class="drop" id="dz">
<div class="ic">&#x1F4C1;</div>
<p><strong>选择文件或文件夹</strong></p>
<p style="font-size:.75em;color:#aaa;margin-top:4px">支持文件夹整体上传，保留目录结构</p>
<input type="file" id="fi" multiple accept="image/*,video/*,.heic,.heif,.mov,.mp4,.zip,.rar,.pdf,.doc,.docx,.xls,.xlsx,.ppt,.pptx,.txt">
</div>
<div style="text-align:center;margin-top:8px">
<label style="font-size:.82em;color:#667eea;cursor:pointer">
<input type="file" id="fd" webkitdirectory directory style="display:none" onchange="pickDir(this)">
&#x1F4C2; 选择文件夹上传
</label>
</div>
<div class="fc" id="fc"></div>
<div id="pv" style="display:none;margin-top:12px">
<div id="fl" style="max-height:200px;overflow-y:auto;margin-bottom:10px"></div>
<button class="btn bp" id="ub" onclick="go()">&#x1F680; 上传</button>
</div>
<div class="pro" id="pr">
<div class="pb"><div class="pf" id="pf"></div></div>
<div class="pt" id="ptt"></div>
</div>
<div class="rs" id="rs"></div>
</div>

<!-- 下载面板 -->
<div class="panel" id="p1">
<h1>&#x1F4E5; 从电脑下载</h1>
<div class="breadcrumb" id="bc"></div>
<div class="flist" id="flist"><div class="fempty">加载中...</div></div>
</div>

<script>
var files=[],curPath='';
function showTab(i){document.querySelectorAll('.tab').forEach(function(t,j){t.classList.toggle('on',j===i)});document.querySelectorAll('.panel').forEach(function(p,j){p.classList.toggle('on',j===i)});if(i===1)loadDir('')}
function fs(b){if(b<1024)return b+'B';if(b<1048576)return(b/1024).toFixed(1)+'KB';return(b/1048576).toFixed(1)+'MB'}

// 上传
var dz=document.getElementById('dz'),fi=document.getElementById('fi');
dz.addEventListener('dragover',function(e){e.preventDefault();dz.classList.add('over')});
dz.addEventListener('dragleave',function(){dz.classList.remove('over')});
dz.addEventListener('drop',function(e){e.preventDefault();dz.classList.remove('over');hf(e.dataTransfer.files)});
fi.addEventListener('change',function(){hf(fi.files)});
function pickDir(el){if(el.files.length)hf(el.files)}
function hf(f){files=Array.from(f);var fl=document.getElementById('fl');fl.innerHTML='';files.forEach(function(x){var d=document.createElement('div');d.style.cssText='display:flex;align-items:center;padding:4px 0;font-size:.82em;border-bottom:1px solid #f0f0f0';var rel=x.webkitRelativePath||x.name;d.innerHTML='<span style="flex:1;overflow:hidden;text-overflow:ellipsis;white-space:nowrap">'+rel+'</span><span style="color:#999;margin-left:8px">'+fs(x.size)+'</span>';fl.appendChild(d)});document.getElementById('pv').style.display='block';document.getElementById('fc').textContent='已选择 '+files.length+' 个文件';document.getElementById('rs').className='rs'}
async function go(){if(!files.length)return;document.getElementById('ub').disabled=1;document.getElementById('pr').classList.add('on');document.getElementById('rs').className='rs';var ok=0,fail=0;for(var i=0;i<files.length;i++){document.getElementById('ptt').textContent='上传 '+(i+1)+'/'+files.length;try{var fd=new FormData();fd.append('file',files[i],files[i].webkitRelativePath||files[i].name);await new Promise(function(res){var x=new XMLHttpRequest();x.upload.onprogress=function(e){if(e.lengthComputable)document.getElementById('pf').style.width=((ok+e.loaded/e.total)/files.length*100)+'%'};x.onload=function(){if(x.status==200)ok++;else fail++;res()};x.onerror=function(){fail++;res()};x.open('POST','/upload');x.send(fd)})}catch(e){fail++}}document.getElementById('pf').style.width='100%';document.getElementById('ptt').textContent='完成';var rs=document.getElementById('rs');if(fail==0){rs.className='rs ok';rs.innerHTML='&#x2705; 成功上传 '+ok+' 个文件'}else{rs.className='rs er';rs.innerHTML='&#x26A0;&#xFE0F; 成功 '+ok+'，失败 '+fail}document.getElementById('ub').disabled=0;files=[];fi.value='';document.getElementById('fd').value='';setTimeout(function(){document.getElementById('pr').classList.remove('on')},2500)}

// 下载
function loadDir(p){curPath=p;var bc=document.getElementById('bc');bc.innerHTML='';var parts=p?p.split('/'):[];var cum='';var home=document.createElement('span');home.className='bc';home.textContent='&#x1F3E0;';home.onclick=function(){loadDir('')};bc.appendChild(home);parts.forEach(function(part,idx){cum+=(idx>0?'/':'')+part;var sp=document.createElement('span');sp.textContent=' / '+part;sp.style.cssText='font-size:.8em;color:#999';bc.appendChild(sp);var cPath=cum;var cl=document.createElement('span');cl.className='bc';cl.textContent=part;cl.onclick=function(){loadDir(cPath)};bc.appendChild(cl)});
fetch('/api/files?path='+encodeURIComponent(p)).then(function(r){return r.json()}).then(function(d){var list=document.getElementById('flist');if(!d.items||!d.items.length){list.innerHTML='<div class="fempty">&#x1F4ED; 空文件夹</div>';return}list.innerHTML='';d.items.forEach(function(item){var div=document.createElement('div');div.className='fitem';div.innerHTML='<span class="icon">'+(item.isDir?'&#x1F4C1;':'&#x1F4C4;')+'</span><span class="name">'+item.name+'</span><span class="size">'+(item.isDir?'':fs(item.size))+'</span>'+(item.isDir?'':'<button class="dl" onclick="event.stopPropagation()">下载</button>');if(item.isDir){div.onclick=function(){loadDir(item.path)}}else{div.querySelector('.dl').onclick=function(e){e.stopPropagation();window.open('/download?path='+encodeURIComponent(item.path))}}list.appendChild(div)})}
)}

// 初始化
loadDir('');
</script>
</body>
</html>`;
}

function getIndexPage() {
  const ip = getLocalIP();
  const url = `http://${ip}:${PORT}`;
  return `<!DOCTYPE html><html><body style="font-family:sans-serif;text-align:center;padding:40px">
<h2>Localxfer</h2>
<p>服务运行中: <a href="${url}/upload">${url}/upload</a></p>
</body></html>`;
}

// ─── 启动 ─────────────────────────────────────────────
app.whenReady().then(() => {
  const sharedDir = getSharedDir();
  const ip = getLocalIP();
  const lanUrl = `http://${ip}:${PORT}`;

  const server = createServer();
  server.listen(PORT, '0.0.0.0', () => {
    console.log(`Server running at ${lanUrl}`);
    createWindow(lanUrl);
  });

  app.on('activate', () => {
    if (BrowserWindow.getAllWindows().length === 0) createWindow(lanUrl);
  });
});

app.on('window-all-closed', () => { app.quit(); });

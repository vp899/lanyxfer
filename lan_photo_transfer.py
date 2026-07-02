#!/usr/bin/env python3
"""
LAN Photo Transfer - 局域网照片传输工具
免安装，手机扫码或打开网址即可上传照片到电脑。
Windows / macOS / Linux 通用。
"""

import http.server
import socket
import socketserver
import json
import os
import sys
import webbrowser
import urllib.parse
import mimetypes
import threading
import time
from pathlib import Path
from datetime import datetime

# ─── 配置 ───────────────────────────────────────────────
PORT = 9876
UPLOAD_DIR = Path.home() / "Desktop" / "LAN_Photos"
MAX_UPLOAD_SIZE = 4 * 1024 * 1024 * 1024  # 4GB（支持大视频）

# ─── 获取局域网 IP ─────────────────────────────────────
def get_local_ip():
    """Get the local LAN IP address."""
    try:
        s = socket.socket(socket.AF_INET, socket.SOCK_DGRAM)
        s.connect(("8.8.8.8", 80))
        ip = s.getsockname()[0]
        s.close()
        return ip
    except Exception:
        return "127.0.0.1"


# ─── 二维码生成（纯 Python，零依赖）─────────────────────
# Minimal QR Code encoder - Version 1-4, Error Correction Level M
# Supports byte mode encoding for URLs

# QR Code Galois Field math
GF256_EXP = [0] * 512
GF256_LOG = [0] * 256

_gf_init = False
def _init_gf256():
    global _gf_init
    if _gf_init:
        return
    _gf_init = True
    x = 1
    for i in range(255):
        GF256_EXP[i] = x
        GF256_LOG[x] = i
        x <<= 1
        if x & 0x100:
            x ^= 0x11d
    for i in range(255, 512):
        GF256_EXP[i] = GF256_EXP[i - 255]

def _gf_mul(a, b):
    if a == 0 or b == 0:
        return 0
    return GF256_EXP[GF256_LOG[a] + GF256_LOG[b]]

def _gf_poly_mul(p, q):
    r = [0] * (len(p) + len(q) - 1)
    for i, a in enumerate(p):
        for j, b in enumerate(q):
            r[i + j] ^= _gf_mul(a, b)
    return r

def _gf_poly_scale(p, x):
    return [_gf_mul(c, x) for c in p]

def _gf_poly_add(p, q):
    r = [0] * max(len(p), len(q))
    for i in range(len(p)):
        r[i + len(r) - len(p)] ^= p[i]
    for i in range(len(q)):
        r[i + len(r) - len(q)] ^= q[i]
    return r

def _reed_solomon_encode(data, nsym):
    _init_gf256()
    gen = [1]
    for i in range(nsym):
        gen = _gf_poly_mul(gen, [1, GF256_EXP[i]])
    
    remainder = data + [0] * nsym
    for i in range(len(data)):
        coef = remainder[i]
        if coef != 0:
            for j in range(len(gen)):
                remainder[i + j] ^= _gf_mul(gen[j], coef)
    return remainder[len(data):]


# QR Code encoding tables
# Error correction codewords per block for versions 1-10, EC level M
_EC_CODEWORDS = {
    1: 10, 2: 16, 3: 26, 4: 18, 5: 24,
    6: 16, 7: 18, 8: 22, 9: 22, 10: 26,
}

_NUM_BLOCKS = {
    1: 1, 2: 1, 3: 1, 4: 2, 5: 2,
    6: 4, 7: 4, 8: 4, 9: 3, 10: 3,
}

_DATA_CODEWORDS = {
    1: 16, 2: 28, 3: 44, 4: 64, 5: 86,
    6: 108, 7: 124, 8: 154, 9: 182, 10: 216,
}

_CAPACITY_BYTES = {
    1: 14, 2: 26, 3: 42, 4: 62, 5: 84,
    6: 106, 7: 122, 8: 152, 9: 180, 10: 213,
}

# Alignment pattern positions
_ALIGN_POS = {
    2: [6, 18], 3: [6, 22], 4: [6, 26], 5: [6, 30],
    6: [6, 34], 7: [6, 22, 38], 8: [6, 24, 42], 9: [6, 26, 46],
    10: [6, 28, 50],
}

# Format info for EC level M (01) with each mask pattern 0-7
_FORMAT_INFO = [
    0x5412, 0x5125, 0x5E7C, 0x5B4B, 0x45F9, 0x40CE, 0x4F97, 0x4AA0,
]

_MASK_FNS = [
    lambda r, c: (r + c) % 2 == 0,
    lambda r, c: r % 2 == 0,
    lambda r, c: c % 3 == 0,
    lambda r, c: (r + c) % 3 == 0,
    lambda r, c: (r // 2 + c // 3) % 2 == 0,
    lambda r, c: (r * c) % 2 + (r * c) % 3 == 0,
    lambda r, c: ((r * c) % 2 + (r * c) % 3) % 2 == 0,
    lambda r, c: ((r + c) % 2 + (r * c) % 3) % 2 == 0,
]


def _select_version(data_len):
    """Select minimum QR version for given data length (byte mode, EC level M)."""
    for v in range(1, 11):
        if _CAPACITY_BYTES[v] >= data_len:
            return v
    return 10  # max we support


def _create_matrix(version):
    """Create an empty QR matrix with function patterns."""
    size = version * 4 + 17
    matrix = [[None] * size for _ in range(size)]
    reserved = [[False] * size for _ in range(size)]
    
    # Finder patterns (top-left, top-right, bottom-left)
    def _finder_pattern(r, c):
        for dr in range(-1, 8):
            for dc in range(-1, 8):
                rr, cc = r + dr, c + dc
                if 0 <= rr < size and 0 <= cc < size:
                    if 0 <= dr <= 6 and 0 <= dc <= 6:
                        if dr == 0 or dr == 6 or dc == 0 or dc == 6 or (2 <= dr <= 4 and 2 <= dc <= 4):
                            matrix[rr][cc] = True
                        else:
                            matrix[rr][cc] = False
                    else:
                        matrix[rr][cc] = False
                    reserved[rr][cc] = True
    
    _finder_pattern(0, 0)
    _finder_pattern(0, size - 7)
    _finder_pattern(size - 7, 0)
    
    # Timing patterns
    for i in range(8, size - 8):
        matrix[6][i] = (i % 2 == 0)
        reserved[6][i] = True
        matrix[i][6] = (i % 2 == 0)
        reserved[i][6] = True
    
    # Alignment patterns
    if version >= 2:
        positions = _ALIGN_POS.get(version, [])
        for r in positions:
            for c in positions:
                if reserved[r][c]:
                    continue
                for dr in range(-2, 3):
                    for dc in range(-2, 3):
                        rr, cc = r + dr, c + dc
                        if abs(dr) == 2 or abs(dc) == 2 or (dr == 0 and dc == 0):
                            matrix[rr][cc] = True
                        else:
                            matrix[rr][cc] = False
                        reserved[rr][cc] = True
    
    # Dark module
    matrix[size - 8][8] = True
    reserved[size - 8][8] = True
    
    # Reserve format info areas
    for i in range(9):
        if not reserved[8][i]:
            reserved[8][i] = True
        if not reserved[i][8]:
            reserved[i][8] = True
    for i in range(8):
        if not reserved[8][size - 1 - i]:
            reserved[8][size - 1 - i] = True
        if not reserved[size - 1 - i][8]:
            reserved[size - 1 - i][8] = True
    
    return matrix, reserved, size


def _encode_data(data, version):
    """Encode data into QR codewords (byte mode, EC level M)."""
    # Mode indicator: 0100 (byte mode)
    bits = '0100'
    # Character count
    bits += format(len(data), '08b')
    
    # Data
    for byte in data:
        bits += format(byte, '08b')
    
    # Terminator
    total_bits = _DATA_CODEWORDS[version] * 8
    bits += '0' * min(4, total_bits - len(bits))
    
    # Pad to byte boundary
    if len(bits) % 8 != 0:
        bits += '0' * (8 - len(bits) % 8)
    
    # Pad bytes
    pad_bytes = [0xEC, 0x11]
    idx = 0
    while len(bits) < total_bits:
        bits += format(pad_bytes[idx % 2], '08b')
        idx += 1
    
    # Convert to bytes
    codewords = []
    for i in range(0, len(bits), 8):
        codewords.append(int(bits[i:i+8], 2))
    
    return codewords[:_DATA_CODEWORDS[version]]


def _add_ec(data, version):
    """Add error correction codewords."""
    ec_per_block = _EC_CODEWORDS[version]
    num_blocks = _NUM_BLOCKS[version]
    total_data = _DATA_CODEWORDS[version]
    
    block_size = total_data // num_blocks
    ec_total = ec_per_block * num_blocks
    
    data_blocks = []
    ec_blocks = []
    
    for i in range(num_blocks):
        start = i * block_size
        # Last block might be larger
        if i >= num_blocks - (total_data % num_blocks):
            block = data[start:start + block_size + 1]
        else:
            block = data[start:start + block_size]
        data_blocks.append(block)
        ec_blocks.append(_reed_solomon_encode(block, ec_per_block))
    
    # Interleave data blocks
    result = []
    max_len = max(len(b) for b in data_blocks)
    for i in range(max_len):
        for block in data_blocks:
            if i < len(block):
                result.append(block[i])
    
    # Interleave EC blocks
    for i in range(ec_per_block):
        for block in ec_blocks:
            if i < len(block):
                result.append(block[i])
    
    return result


def _place_data(matrix, reserved, size, codewords):
    """Place codewords into the matrix."""
    bit_idx = 0
    total_bits = len(codewords) * 8
    
    # Traverse in two-column groups from bottom-right
    col = size - 1
    while col >= 0:
        if col == 6:
            col -= 1  # Skip timing column
        
        for row_pair in range(size):
            for c_offset in range(2):
                c = col - c_offset
                if c < 0:
                    continue
                
                # Determine row (upward or downward)
                upward = ((col + 1) & 2) == 0  # alternating direction
                if upward:
                    r = size - 1 - row_pair
                else:
                    r = row_pair
                
                if r < 0 or r >= size or c < 0 or c >= size:
                    continue
                if reserved[r][c]:
                    continue
                
                if bit_idx < total_bits:
                    byte_idx = bit_idx // 8
                    bit_pos = 7 - (bit_idx % 8)
                    matrix[r][c] = (codewords[byte_idx] >> bit_pos) & 1 == 1
                    bit_idx += 1
                else:
                    matrix[r][c] = False
        
        col -= 2


def _apply_mask(matrix, reserved, size, mask_idx):
    """Apply mask pattern and return masked matrix."""
    masked = [row[:] for row in matrix]
    fn = _MASK_FNS[mask_idx]
    for r in range(size):
        for c in range(size):
            if not reserved[r][c] and fn(r, c):
                masked[r][c] = not masked[r][c]
    return masked


def _place_format_info(matrix, size, mask_idx):
    """Place format information."""
    bits = _FORMAT_INFO[mask_idx]
    # Place around top-left finder
    format_bits = [(bits >> (14 - i)) & 1 for i in range(15)]
    
    # Horizontal (row 8)
    positions_h = [(8, 0), (8, 1), (8, 2), (8, 3), (8, 4), (8, 5), (8, 7), (8, 8),
                   (8, size - 8), (8, size - 7), (8, size - 6), (8, size - 5),
                   (8, size - 4), (8, size - 3), (8, size - 2), (8, size - 1)]
    
    # Vertical (col 8)
    positions_v = [(0, 8), (1, 8), (2, 8), (3, 8), (4, 8), (5, 8), (7, 8),
                   (size - 7, 8), (size - 6, 8), (size - 5, 8), (size - 4, 8),
                   (size - 3, 8), (size - 2, 8), (size - 1, 8)]
    
    # Map format bits to positions
    # First 7 bits go to horizontal right side and vertical bottom
    # Last 8 bits go to horizontal left side and vertical top
    for i, (r, c) in enumerate(positions_h):
        if i < 8:
            matrix[r][c] = bool(format_bits[i])
        else:
            matrix[r][c] = bool(format_bits[i - 1])  # skip bit 7 in horizontal
    
    for i, (r, c) in enumerate(positions_v):
        if i < 7:
            matrix[r][c] = bool(format_bits[14 - i])
        else:
            matrix[r][c] = bool(format_bits[14 - i - 1])


def _best_mask(matrix, reserved, size):
    """Select best mask pattern (simplified: use mask 0)."""
    # For simplicity, try all masks and pick the one with lowest penalty
    best_mask = 0
    best_penalty = float('inf')
    
    for mask_idx in range(8):
        masked = _apply_mask(matrix, reserved, size, mask_idx)
        
        # Calculate penalty (simplified)
        penalty = 0
        
        # Rule 1: runs of same color
        for r in range(size):
            run = 1
            for c in range(1, size):
                if masked[r][c] == masked[r][c-1]:
                    run += 1
                    if run == 5:
                        penalty += 3
                    elif run > 5:
                        penalty += 1
                else:
                    run = 1
        
        for c in range(size):
            run = 1
            for r in range(1, size):
                if masked[r][c] == masked[r-1][c]:
                    run += 1
                    if run == 5:
                        penalty += 3
                    elif run > 5:
                        penalty += 1
                else:
                    run = 1
        
        # Rule 2: 2x2 blocks
        for r in range(size - 1):
            for c in range(size - 1):
                val = masked[r][c]
                if val == masked[r][c+1] == masked[r+1][c] == masked[r+1][c+1]:
                    penalty += 3
        
        if penalty < best_penalty:
            best_penalty = penalty
            best_mask = mask_idx
    
    return best_mask


def generate_qr_matrix(text):
    """Generate QR code matrix for given text. Returns list of rows (list of bool)."""
    data = text.encode('utf-8')
    version = _select_version(len(data))
    
    # Encode data
    codewords = _encode_data(data, version)
    
    # Add error correction
    full_codewords = _add_ec(codewords, version)
    
    # Create matrix
    matrix, reserved, size = _create_matrix(version)
    
    # Place data
    _place_data(matrix, reserved, size, full_codewords)
    
    # Select and apply best mask
    mask_idx = _best_mask(matrix, reserved, size)
    masked = _apply_mask(matrix, reserved, size, mask_idx)
    
    # Place format info
    _place_format_info(masked, size, mask_idx)
    
    return masked


def qr_to_svg(text, size=220):
    """Generate QR code as SVG string."""
    matrix = generate_qr_matrix(text)
    rows = len(matrix)
    cols = len(matrix[0]) if rows > 0 else 0
    cell = size / (rows + 2)
    offset = cell
    
    parts = [f'<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 {size} {size}" width="{size}" height="{size}">']
    parts.append(f'<rect width="{size}" height="{size}" fill="white"/>')
    
    # Use a single path for efficiency
    path_data = []
    for r in range(rows):
        for c in range(cols):
            if matrix[r][c]:
                x = round(offset + c * cell, 2)
                y = round(offset + r * cell, 2)
                w = round(cell, 2)
                path_data.append(f'M{x},{y}h{w}v{w}h{-w}z')
    
    parts.append(f'<path d="{"".join(path_data)}" fill="black"/>')
    parts.append('</svg>')
    return ''.join(parts)


# ─── HTML 页面 ──────────────────────────────────────────
def get_mobile_page():
    """Generate the mobile upload page HTML."""
    return '''<!DOCTYPE html>
<html lang="zh-CN">
<head>
<meta charset="UTF-8">
<meta name="viewport" content="width=device-width, initial-scale=1.0, user-scalable=no">
<title>上传照片</title>
<style>
*{margin:0;padding:0;box-sizing:border-box}
body{font-family:-apple-system,BlinkMacSystemFont,"Segoe UI",Roboto,sans-serif;background:linear-gradient(135deg,#667eea 0%,#764ba2 100%);min-height:100vh;display:flex;flex-direction:column;align-items:center;padding:16px;color:#333}
.container{background:#fff;border-radius:20px;padding:28px 20px;width:100%;max-width:420px;box-shadow:0 20px 60px rgba(0,0,0,.3);margin-top:16px}
h1{text-align:center;font-size:1.4em;margin-bottom:6px}
.sub{text-align:center;color:#888;font-size:.88em;margin-bottom:20px}
.drop{border:3px dashed #ddd;border-radius:16px;padding:36px 16px;text-align:center;cursor:pointer;transition:all .3s;background:#fafafa;position:relative}
.drop:hover,.drop.over{border-color:#667eea;background:#f0f0ff}
.drop .ic{font-size:48px;margin-bottom:10px}
.drop p{color:#666;font-size:.92em}
.drop input{position:absolute;top:0;left:0;width:100%;height:100%;opacity:0;cursor:pointer}
.prev{margin-top:18px;display:none}
.prev.on{display:block}
.pg{display:grid;grid-template-columns:repeat(3,1fr);gap:6px;margin-bottom:14px}
.pi{position:relative;aspect-ratio:1;border-radius:8px;overflow:hidden}
.pi img{width:100%;height:100%;object-fit:cover}
.pi .bd{position:absolute;top:3px;right:3px;background:rgba(0,0,0,.6);color:#fff;font-size:10px;padding:2px 5px;border-radius:8px}
.btn{display:block;width:100%;padding:13px;border:none;border-radius:12px;font-size:1.05em;font-weight:600;cursor:pointer;transition:all .2s}
.bp{background:linear-gradient(135deg,#667eea,#764ba2);color:#fff}
.bp:hover{transform:scale(1.02)}
.bp:disabled{background:#ccc;cursor:not-allowed;transform:none}
.pro{display:none;margin-top:14px}
.pro.on{display:block}
.pb{height:7px;background:#eee;border-radius:4px;overflow:hidden}
.pf{height:100%;background:linear-gradient(90deg,#667eea,#764ba2);border-radius:4px;transition:width .3s;width:0}
.pt{text-align:center;margin-top:6px;color:#666;font-size:.82em}
.res{display:none;margin-top:14px;padding:14px;border-radius:12px;text-align:center;font-size:.95em}
.res.ok{background:#e8f5e9;color:#2e7d32;display:block}
.res.err{background:#ffebee;color:#c62828;display:block}
.fc{text-align:center;margin-top:10px;color:#667eea;font-weight:600;font-size:.88em}
</style>
</head>
<body>
<div class="container">
<h1>&#x1F4F8; 上传照片到电脑</h1>
<p class="sub">选择照片后点击上传</p>
<div class="drop" id="dz">
<div class="ic">&#x1F4C1;</div>
<p><strong>点击选择照片/视频</strong></p>
<p style="font-size:.78em;color:#aaa;margin-top:6px">JPG / PNG / HEIC / MP4 / MOV ...</p>
<input type="file" id="fi" multiple accept="image/*,video/*,.heic,.heif,.mov,.mp4">
</div>
<div class="fc" id="fc"></div>
<div class="prev" id="pv">
<div class="pg" id="pg"></div>
<button class="btn bp" id="ub" onclick="go()">&#x1F680; 上传到电脑</button>
</div>
<div class="pro" id="pr">
<div class="pb"><div class="pf" id="pf"></div></div>
<div class="pt" id="ptt">准备中...</div>
</div>
<div class="res" id="rs"></div>
</div>
<script>
var dz=document.getElementById("dz"),fi=document.getElementById("fi"),pv=document.getElementById("pv"),pg=document.getElementById("pg"),fc=document.getElementById("fc"),ub=document.getElementById("ub"),pr=document.getElementById("pr"),pf=document.getElementById("pf"),ptt=document.getElementById("ptt"),rs=document.getElementById("rs"),files=[];
dz.addEventListener("dragover",function(e){e.preventDefault();dz.classList.add("over")});
dz.addEventListener("dragleave",function(){dz.classList.remove("over")});
dz.addEventListener("drop",function(e){e.preventDefault();dz.classList.remove("over");hf(e.dataTransfer.files)});
fi.addEventListener("change",function(){hf(fi.files)});
function hf(f){files=Array.from(f);pg.innerHTML="";files.forEach(function(x,i){var d=document.createElement("div");d.className="pi";if(x.type.startsWith("image/")){var img=document.createElement("img");img.src=URL.createObjectURL(x);d.appendChild(img)}else{d.innerHTML='<div style="display:flex;align-items:center;justify-content:center;height:100%;background:#f0f0f0;font-size:24px">&#x1F4C4;</div>'}var b=document.createElement("div");b.className="bd";b.textContent=fs(x.size);d.appendChild(b);pg.appendChild(d)});pv.classList.add("on");fc.textContent="已选择 "+files.length+" 个文件";rs.className="res"}
function fs(b){if(b<1024)return b+"B";if(b<1048576)return(b/1024).toFixed(1)+"KB";return(b/1048576).toFixed(1)+"MB"}
async function go(){if(!files.length)return;ub.disabled=1;pr.classList.add("on");rs.className="res";var ok=0,fail=0;for(var i=0;i<files.length;i++){ptt.textContent="上传 "+(i+1)+"/"+files.length+": "+files[i].name;try{var fd=new FormData();fd.append("file",files[i]);await new Promise(function(res,rej){var x=new XMLHttpRequest();x.upload.onprogress=function(e){if(e.lengthComputable)pf.style.width=((ok+e.loaded/e.total)/files.length*100)+"%"};x.onload=function(){if(x.status==200)ok++;else fail++;res()};x.onerror=function(){fail++;res()};x.open("POST","/upload");x.send(fd)})}catch(e){fail++}}pf.style.width="100%";ptt.textContent="完成";if(fail==0){rs.className="res ok";rs.innerHTML="&#x2705; 成功上传 "+ok+" 个文件到电脑！<br><small>保存位置：桌面/LAN_Photos</small>"}else{rs.className="res err";rs.innerHTML="&#x26A0;&#xFE0F; 成功 "+ok+"，失败 "+fail}ub.disabled=0;files=[];fi.value="";setTimeout(function(){pr.classList.remove("on")},2500)}
</script>
</body>
</html>'''


def get_index_page(url, upload_dir):
    """Generate the desktop index page with QR code."""
    qr_svg = qr_to_svg(url, size=200)
    
    return f'''<!DOCTYPE html>
<html lang="zh-CN">
<head>
<meta charset="UTF-8">
<meta name="viewport" content="width=device-width, initial-scale=1.0">
<title>LAN Photo Transfer</title>
<style>
*{{margin:0;padding:0;box-sizing:border-box}}
body{{font-family:-apple-system,BlinkMacSystemFont,"Segoe UI",Roboto,sans-serif;background:#f5f5f5;min-height:100vh;display:flex;align-items:center;justify-content:center;padding:20px}}
.card{{background:#fff;border-radius:20px;padding:36px;box-shadow:0 4px 24px rgba(0,0,0,.08);max-width:460px;width:100%;text-align:center}}
h1{{font-size:1.7em;margin-bottom:6px}}
.sub{{color:#888;margin-bottom:28px}}
.qr{{margin:20px auto;display:inline-block;padding:14px;background:#fff;border-radius:12px;box-shadow:0 2px 12px rgba(0,0,0,.06)}}
.url{{background:#f8f8f8;border-radius:12px;padding:14px;margin:20px 0;word-break:break-all}}
.url a{{color:#667eea;font-size:1.15em;font-weight:600;text-decoration:none}}
.url a:hover{{text-decoration:underline}}
.info{{color:#999;font-size:.83em;margin-top:20px;line-height:1.7}}
.badge{{display:inline-block;background:#e8f5e9;color:#2e7d32;padding:4px 12px;border-radius:20px;font-size:.83em;margin-bottom:18px}}
</style>
</head>
<body>
<div class="card">
<h1>&#x1F4F8; 局域网照片传输</h1>
<p class="sub">手机扫码或打开链接上传照片</p>
<div class="badge">&#x1F7E2; 服务运行中</div>
<div class="qr">{qr_svg}</div>
<div class="url"><a href="{url}" target="_blank">{url}</a></div>
<div class="info">
&#x1F4C2; 照片保存到：{upload_dir}<br>
&#x1F4F1; 手机和电脑需在同一 WiFi 网络<br>
&#x1F512; 仅限局域网访问，安全可靠
</div>
</div>
</body>
</html>'''


# ─── HTTP 请求处理 ──────────────────────────────────────
class PhotoHandler(http.server.BaseHTTPRequestHandler):
    upload_dir = UPLOAD_DIR
    lan_url = ""
    qr_url = ""
    
    def log_message(self, fmt, *args):
        if "POST" in str(args):
            ts = datetime.now().strftime("%H:%M:%S")
            print(f"  [{ts}] 📤 {args[0]}")
    
    def do_GET(self):
        path = urllib.parse.urlparse(self.path).path
        ua = self.headers.get('User-Agent', '').lower()
        is_mobile = any(k in ua for k in ('mobile', 'iphone', 'android', 'ipad'))
        
        if path in ('/', '/index.html'):
            if is_mobile:
                # 手机访问根路径，直接跳转上传页
                self.send_response(302)
                self.send_header('Location', '/upload')
                self.end_headers()
                return
            html = get_index_page(self.qr_url, self.upload_dir)
            self._html(200, html)
        elif path in ('/upload', '/mobile'):
            html = get_mobile_page()
            self._html(200, html)
        elif path == '/favicon.ico':
            self.send_response(204)
            self.end_headers()
        else:
            self.send_response(404)
            self.end_headers()
    
    def do_POST(self):
        if self.path == '/upload':
            self._handle_upload()
        else:
            self.send_response(404)
            self.end_headers()
    
    def _html(self, code, html):
        self.send_response(code)
        self.send_header('Content-Type', 'text/html; charset=utf-8')
        self.end_headers()
        self.wfile.write(html.encode('utf-8'))
    
    def _json(self, code, data):
        self.send_response(code)
        self.send_header('Content-Type', 'application/json; charset=utf-8')
        self.send_header('Access-Control-Allow-Origin', '*')
        self.end_headers()
        self.wfile.write(json.dumps(data, ensure_ascii=False).encode('utf-8'))
    
    def _handle_upload(self):
        ct = self.headers.get('Content-Type', '')
        cl = int(self.headers.get('Content-Length', 0))
        
        if cl > MAX_UPLOAD_SIZE:
            self._json(413, {"error": "文件太大，最大支持 4GB"})
            return
        if 'multipart/form-data' not in ct:
            self._json(400, {"error": "无效请求"})
            return
        
        boundary = None
        for part in ct.split(';'):
            part = part.strip()
            if part.startswith('boundary='):
                boundary = part[9:].strip('"')
                break
        if not boundary:
            self._json(400, {"error": "缺少boundary"})
            return
        
        boundary_bytes = boundary.encode('utf-8')
        delimiter = b'--' + boundary_bytes
        eol = b'\r\n'
        
        # 流式读取全部数据
        body = b''
        remaining = cl
        while remaining > 0:
            chunk = self.rfile.read(min(1024 * 1024, remaining))
            if not chunk:
                break
            body += chunk
            remaining -= len(chunk)
        
        # 按 delimiter 切分
        segments = body.split(delimiter)
        saved = []
        
        for seg in segments:
            seg = seg.strip()
            if seg == b'--' or seg == b'':
                continue
            # 去掉开头的 \r\n
            if seg.startswith(eol):
                seg = seg[2:]
            # 去掉尾部的 --
            if seg.endswith(b'--'):
                seg = seg[:-2]
            seg = seg.strip()
            if not seg:
                continue
            if eol + eol not in seg:
                continue
            
            hdr, fdata = seg.split(eol + eol, 1)
            if fdata.endswith(eol):
                fdata = fdata[:-2]
            
            fname = None
            for line in hdr.decode('utf-8', errors='replace').split('\r\n'):
                if 'filename=' in line:
                    idx = line.index('filename=')
                    fname = line[idx+9:].strip('"').strip("'")
                    break
            
            if not fname or not fdata:
                continue
            
            fname = os.path.basename(fname).replace('\x00', '')
            if not fname:
                continue
            
            save_path = self.upload_dir / fname
            if save_path.exists():
                stem, suf = save_path.stem, save_path.suffix
                n = 1
                while save_path.exists():
                    save_path = self.upload_dir / f"{stem}_{n}{suf}"
                    n += 1
            
            with open(save_path, 'wb') as f:
                f.write(fdata)
            
            saved.append(save_path.name)
            ts = datetime.now().strftime("%H:%M:%S")
            size_mb = len(fdata) / (1024 * 1024)
            if size_mb >= 1:
                print(f"  [{ts}] 💾 {save_path.name} ({size_mb:.1f} MB)")
            else:
                print(f"  [{ts}] 💾 {save_path.name} ({len(fdata)} bytes)")
        
        if saved:
            self._json(200, {"success": True, "count": len(saved), "files": saved})
        else:
            self._json(400, {"error": "未找到文件"})


# ─── 主程序 ──────────────────────────────────────────────
def main():
    UPLOAD_DIR.mkdir(parents=True, exist_ok=True)
    
    local_ip = get_local_ip()
    lan_url = f"http://{local_ip}:{PORT}"
    qr_url = f"http://{local_ip}:{PORT}/upload"
    
    PhotoHandler.upload_dir = UPLOAD_DIR
    PhotoHandler.lan_url = lan_url
    PhotoHandler.qr_url = qr_url
    
    socketserver.TCPServer.allow_reuse_address = True
    try:
        server = socketserver.TCPServer(("0.0.0.0", PORT), PhotoHandler)
    except OSError as e:
        if e.errno in (48, 98, 10048):
            print(f"\n  ❌ 端口 {PORT} 已被占用")
            if sys.platform == 'win32':
                input("  按回车退出...")
            sys.exit(1)
        raise
    
    print()
    print("=" * 50)
    print("   📸  局域网照片传输工具")
    print("=" * 50)
    print()
    print(f"   🌐 地址: {lan_url}")
    print(f"   📱 手机扫码: {lan_url}/upload")
    print(f"   📂 保存: {UPLOAD_DIR}")
    print(f"   📱 手机扫码或打开上方地址")
    print()
    print("   ⏹  按 Ctrl+C 停止")
    print("=" * 50)
    
    try:
        webbrowser.open(lan_url)
    except Exception:
        pass
    
    try:
        server.serve_forever()
    except KeyboardInterrupt:
        print("\n  👋 已停止")
        server.shutdown()


if __name__ == '__main__':
    main()

// ==UserScript==
// @name         Telegram Web Media Downloader Plus
// @name:zh-CN   Telegram 网页版媒体下载器 -Plus
// @name:zh-TW   Telegram 網頁版媒體下載器 -Plus
// @namespace    coxjjw
// @license      MIT
// @version      2.3
// @description       Download photos and videos from Telegram Web, one by one or in batches — even in restricted "no-forwards" chats. Also re-enables copying text, and adds a "ZF" button that re-uploads the selected media into any chat you pick (download → upload, no forward API).
// @description:zh-CN 从 Telegram 网页版下载图片和视频，可单个或整批保存，即使在禁止转发的受限聊天中也能使用。同时恢复复制受保护消息中的文字，并新增「ZF」批量转发按钮：先把选中媒体下载到内存，再以全新文件上传到你指定的群组／频道／私聊（不走转发 API）。
// @author       Dharan Tej（原作者） | 二次修改完善：coxjjw
//
// 原始脚本（版权所有 © Dharan Tej，许可证 MIT）：
// https://update.greasyfork.org/scripts/585543/Telegram%20Web%20Media%20Downloader%20%E2%80%94%20Save%20Restricted%20Photos%20%20Videos%20%28Batch%29%20%2B%20Copy%20Text.user.js
// 本脚本基于上述原始脚本二次修改完善（修改者：coxjjw），保留原作者版权声明与 MIT 许可，未声明著作权转让。
// @match        https://web.telegram.org/*
// @match        https://webk.telegram.org/*
// @match        https://webz.telegram.org/*
// @icon         https://web.telegram.org/k/assets/img/favicon.ico
// @downloadURL  https://raw.githubusercontent.com/coxjjw/telegram-web-media-downloader-plus/master/telegram-web-media-downloader-plus.user.js
// @updateURL    https://raw.githubusercontent.com/coxjjw/telegram-web-media-downloader-plus/master/telegram-web-media-downloader-plus.user.js
// @grant        none
// @run-at       document-start
// ==/UserScript==

/*
 * 原理（仅 WebK 版可用）
 * ---------------------------------------------------------------------------
 * “禁止保存 / 禁止转发”只是界面层的开关：媒体本身已在页面内解密完成，
 * App 自己的下载例程依然可以直接调用。三个功能都建立在这一点上。
 *
 *   D/L  批量下载 —— 调 appDownloadManager.downloadToDisc()，与原生下载按钮同一入口。
 *
 *   ZF   批量转发 —— 受保护媒体无法走 messages.forwardMessages，所以这里不是真转发：
 *                    downloadMedia() 取回 Blob → 包成新 File → appMessagesManager.sendFile()，
 *                    本质是重新上传，目标会话里是一条全新消息，没有“转发自”标记也不带限制。
 *
 *   保存文件夹 —— tweb 全程没有调用过 showSaveFilePicker()，“另存为”弹窗来自浏览器的
 *                 “每次询问保存位置”设置，或 IDM / 迅雷 一类下载工具接管。固定一个文件夹后
 *                 改用 File System Access API 自己写盘，整条浏览器下载管线都不经过，
 *                 弹窗与插件劫持自然消失；超大文件仍回退到 Service Worker 流式下载。
 *
 * 注意：原作者的上游脚本曾刻意删除 @downloadURL / @updateURL，
 *       以免 Tampermonkey 自动更新把 ZF 等改动覆盖回官方版本。
 *       本仓库（coxjjw 二次修改版）重新启用这两个字段并指向本 GitHub 仓库，
 *       使 GreasyFork / Tampermonkey 用户能直接获取本 fork 的更新。
 */

(function () {
    'use strict';

    /* ===================== 0. 运行环境 ===================== */

    // 仅 WebK 暴露下面用到的内部管理器，其余入口一律重定向到 /k/。
    if (!(location.hostname === 'webk.telegram.org' || location.pathname.startsWith('/k/'))) {
        location.replace('https://web.telegram.org/k/' + location.hash);
        return;
    }

    // 防重复注入：标记打在 documentElement 上，不往 window 挂任何变量。
    const ROOT_FLAG = 'data-nk-tg-media';
    if (document.documentElement.hasAttribute(ROOT_FLAG)) return;
    document.documentElement.setAttribute(ROOT_FLAG, '1');

    // 全部实现都收在这个 IIFE 内，对外零全局变量；page 只是页面 window 的别名。
    const page = typeof unsafeWindow !== 'undefined' ? unsafeWindow : window;

    /* ===================== 1. 常量与通用工具 ===================== */

    const ICON = '📥';
    const ICON_FWD = '📤';
    const ICON_CFG = '⚙️';

    const BATCH_GAP_MS = 200;               // 批量下载各项之间的间隔
    const SEND_GAP_MS = 350;                // 批量上传各项之间的间隔
    const MEM_LIMIT = 1536 * 1024 * 1024;   // 超过此体积不进内存，改走流式下载

    const LS_PEER = 'nk-tg-zf-peer';        // 上次转发目标
    const LS_OPTS = 'nk-tg-zf-opts';        // 上次转发选项
    const LS_AUTO = 'nk-tg-dl-auto';        // '0' = 未固定文件夹时不自动询问
    const LS_SESS = 'nk-tg-dl-sess';        // '0' = 新会话不再确认保存位置
    const SS_OKED = 'nk-tg-dl-oked';        // sessionStorage：本次会话已确认过保存位置

    const delay = (ms) => new Promise((resolve) => setTimeout(resolve, ms));
    const esc = (s) => String(s).replace(/[&<>"]/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' }[c]));

    const mediaOf = (msg) => msg && msg.media && (msg.media.document || msg.media.photo);
    const sizeOf = (m) => Number(m?.size || 0);
    const lookup = (peerId, mid) => page.mtprotoMessagePort?.getMessageByPeer(peerId, +mid);

    // 通往 MTProto worker 的管理器代理。各版本 WebK 挂载位置不同，取活着的那个。
    const mgrs = () => page.appImManager?.managers || page.appDialogsManager?.managers || page.managers;

    // 图片没有 mime_type，只有 sizes 数组；多处需要据此分支。
    const isPhotoMedia = (m) => m._ === 'photo' || (!m.mime_type && Array.isArray(m.sizes));
    const bigSize = (m) => {
        const s = (m.sizes || []).filter((x) => x.w && x.h);
        return s[s.length - 1] || null;
    };

    // 字节数转人类可读字符串（B/KB/MB/GB）。
    const b2s = (n) => {
        n = Number(n) || 0;
        const u = ['B', 'KB', 'MB', 'GB', 'TB'];
        let i = 0;
        while (n >= 1024 && i < u.length - 1) { n /= 1024; i++; }
        return (i ? n.toFixed(n < 10 ? 2 : 1) : n) + ' ' + u[i];
    };

    // 估算当前标签页「可用内存」字节数。优先用 Chrome 的 performance.memory 实测，
    // 否则退回 navigator.deviceMemory（设备总内存的一半，偏保守）。real=false 表示只是估算。
    function availMem() {
        try {
            const pm = performance && performance.memory;
            if (pm && pm.jsHeapSizeLimit) {
                const free = pm.jsHeapSizeLimit - (pm.usedJSHeapSize || 0);
                return { bytes: Math.max(0, free), real: true };
            }
        } catch {}
        const dev = (navigator && navigator.deviceMemory ? navigator.deviceMemory : 4) * 1024 * 1024 * 1024;
        return { bytes: dev * 0.5, real: false };
    }

    // 按钮文案统一走 DOM 查询，避免持有可能被 Telegram 重建的元素引用。
    const setDlTxt = (t) => { const el = document.querySelector('#nk-tg-batch .nk-txt'); if (el) el.textContent = t; };
    const setZfTxt = (t) => { const el = document.querySelector('#nk-tg-fwd .nk-txt'); if (el) el.textContent = t; };
    const setBusy = (id, busy) => {
        const el = document.getElementById(id);
        if (el) { el.disabled = busy; el.style.opacity = busy ? 0.6 : 1; }
    };

    /* ===================== 2. 样式 ===================== */

    function ensureStyles() {
        if (document.getElementById('nk-zf-style')) return;
        const s = document.createElement('style');
        s.id = 'nk-zf-style';
        s.textContent = [
            // 受限消息解除文本选中限制，Ctrl+C 才有内容可复制
            '.bubble.no-forwards,.bubble.no-forwards *{-webkit-user-select:text!important;user-select:text!important}',
            '.nk-mask{position:fixed;inset:0;background:rgba(0,0,0,.5);z-index:2147483000;display:flex;align-items:center;justify-content:center}',
            '.nk-modal{width:390px;max-width:92vw;max-height:80vh;display:flex;flex-direction:column;background:var(--surface-color,#212121);color:var(--primary-text-color,#fff);border-radius:12px;box-shadow:0 10px 34px rgba(0,0,0,.5);overflow:hidden;font-size:14px}',
            '.nk-hd{padding:14px 16px 10px;font-weight:600;font-size:16px}',
            '.nk-search{margin:0 16px 10px;padding:8px 10px;border-radius:8px;border:1px solid var(--border-color,rgba(255,255,255,.15));background:transparent;color:inherit;outline:none;font-size:14px}',
            '.nk-search:focus{border-color:var(--primary-color,#3390ec)}',
            '.nk-chips{display:flex;gap:6px;padding:0 16px 8px}',
            '.nk-chip{padding:3px 11px;border-radius:12px;font-size:12px;cursor:pointer;background:rgba(128,128,128,.18);opacity:.8;user-select:none}',
            '.nk-chip.on{background:var(--primary-color,#3390ec);color:#fff;opacity:1}',
            '.nk-list{flex:1;overflow-y:auto;min-height:140px}',
            '.nk-item{display:flex;align-items:center;gap:10px;padding:7px 16px;cursor:pointer}',
            '.nk-item:hover{background:rgba(128,128,128,.15)}',
            '.nk-item.sel{background:var(--primary-color,#3390ec);color:#fff}',
            '.nk-item.dis{opacity:.35;cursor:not-allowed}',
            '.nk-av{width:32px;height:32px;border-radius:50%;flex:0 0 32px;display:flex;align-items:center;justify-content:center;font-size:13px;color:#fff}',
            '.nk-tt{flex:1;overflow:hidden;text-overflow:ellipsis;white-space:nowrap}',
            '.nk-tag{font-size:11px;opacity:.55;flex:0 0 auto}',
            '.nk-opts{padding:10px 16px;border-top:1px solid var(--border-color,rgba(255,255,255,.12));display:flex;flex-direction:column;gap:7px;font-size:13px}',
            '.nk-opts label{display:flex;align-items:center;gap:9px;cursor:pointer;padding:9px 11px;border:1px solid var(--border-color,rgba(255,255,255,.18));border-radius:9px;transition:background .15s,border-color .15s}',
            '.nk-opts label:hover{background:rgba(128,128,128,.12)}',
            // 隐藏原生 checkbox（避免被 Telegram 全局 CSS 吃成不可见），改用自带样式的勾选卡片。
            '.nk-opts input[type=checkbox]{position:absolute;opacity:0;width:0;height:0;margin:0}',
            '.nk-opts .nk-box{position:relative;width:18px;height:18px;flex:0 0 18px;border:2px solid var(--secondary-text-color,#9aa0a6);border-radius:5px;box-sizing:border-box;transition:background .15s,border-color .15s}',
            '.nk-opts .nk-box::after{content:"";position:absolute;left:5px;top:1px;width:5px;height:10px;border:solid #fff;border-width:0 2px 2px 0;transform:rotate(45deg);opacity:0;transition:opacity .15s}',
            '.nk-opts input:checked + .nk-box{background:var(--primary-color,#3390ec);border-color:var(--primary-color,#3390ec)}',
            '.nk-opts input:checked + .nk-box::after{opacity:1}',
            // 勾选时整行高亮，选中状态一目了然。
            '.nk-opts label:has(input:checked){background:rgba(51,144,236,.16);border-color:var(--primary-color,#3390ec)}',
            '.nk-opts .nk-o-tx{flex:1;user-select:none}',
            '.nk-ft{display:flex;justify-content:flex-end;gap:6px;padding:10px 12px 14px}',
            '.nk-btn{padding:7px 16px;border-radius:8px;border:0;cursor:pointer;font-size:14px;background:transparent;color:var(--primary-color,#3390ec);font-weight:600}',
            '.nk-btn.pri{background:var(--primary-color,#3390ec);color:#fff}',
            '.nk-btn[disabled]{opacity:.4;cursor:default}',
            '.nk-hud{position:fixed;right:18px;bottom:18px;z-index:2147482000;width:310px;background:var(--surface-color,#212121);color:var(--primary-text-color,#fff);border-radius:10px;box-shadow:0 6px 26px rgba(0,0,0,.45);padding:12px 14px;font-size:13px}',
            '.nk-hud b{font-size:14px}',
            '.nk-bar{height:4px;border-radius:2px;background:rgba(128,128,128,.3);overflow:hidden;margin:9px 0 4px}',
            '.nk-bar>i{display:block;height:100%;width:0;background:var(--primary-color,#3390ec);transition:width .2s}',
            '.nk-log{max-height:118px;overflow-y:auto;opacity:.75;font-size:12px;line-height:1.55;margin-top:6px;word-break:break-all}',
            '.nk-x{cursor:pointer;opacity:.6;padding:0 4px}',
            '.nk-x:hover{opacity:1}'
        ].join('');
        // document-start 时 head 可能尚未生成，挂到 documentElement 同样生效。
        (document.head || document.documentElement).appendChild(s);
    }

    /* ===================== 3. 固定保存文件夹 ===================== */

    const FSA = typeof page.showDirectoryPicker === 'function';
    const IDB = page.indexedDB || window.indexedDB;
    const DB_NAME = 'nk-tg-dl', DB_STORE = 'kv', DB_KEY = 'saveDir';
    const NEEDS_GESTURE = 'nk-need-gesture';

    let dirHandle = null;   // FileSystemDirectoryHandle | null
    let dirLoaded = false;

    function idbRun(mode, fn) {
        return new Promise((res, rej) => {
            const open = IDB.open(DB_NAME, 1);
            open.onupgradeneeded = () => { open.result.createObjectStore(DB_STORE); };
            open.onerror = () => rej(open.error);
            open.onsuccess = () => {
                const db = open.result;
                const rq = fn(db.transaction(DB_STORE, mode).objectStore(DB_STORE));
                rq.onsuccess = () => { res(rq.result); db.close(); };
                rq.onerror = () => { rej(rq.error); db.close(); };
            };
        });
    }

    // 目录句柄存在 IndexedDB，重启浏览器后依然有效（只读一次并缓存）。
    async function loadDir() {
        if (dirLoaded) return dirHandle;
        dirLoaded = true;
        if (!FSA) return null;
        try { dirHandle = (await idbRun('readonly', (s) => s.get(DB_KEY))) || null; }
        catch { dirHandle = null; }
        return dirHandle;
    }

    // 三态返回，调用方据此决定要不要再弹第二个窗：
    // granted 有权限 / denied 用户明确拒绝 / error 句柄失效或用户手势已过期
    async function dirPerm(h, ask) {
        if (!h) return 'denied';
        const opt = { mode: 'readwrite' };
        try {
            if ((await h.queryPermission(opt)) === 'granted') return 'granted';
            if (!ask) return 'denied';
            return (await h.requestPermission(opt)) === 'granted' ? 'granted' : 'denied';
        } catch { return 'error'; }
    }

    // 静默取用已授权目录，拿不到就返回 null 让调用方回退到浏览器下载。
    async function folderReady(ask) {
        const h = await loadDir();
        if (!h) return null;
        return (await dirPerm(h, ask !== false)) === 'granted' ? h : null;
    }

    const autoAsk = () => localStorage.getItem(LS_AUTO) !== '0';
    const setAutoAsk = (v) => { try { localStorage.setItem(LS_AUTO, v ? '1' : '0'); } catch {} };

    // 固定的目录会被永久记住，脚本可能因此彻底静默——用户既看不出文件存到哪，也没法改。
    // 因此每个浏览器会话的第一次下载弹一次确认单（不是系统选择器）。
    // sessionStorage 在浏览器关闭时清空，正好等价于“重开需再确认”。
    const sessAsk = () => localStorage.getItem(LS_SESS) !== '0';
    const setSessAsk = (v) => { try { localStorage.setItem(LS_SESS, v ? '1' : '0'); } catch {} };
    const sessOked = () => { try { return sessionStorage.getItem(SS_OKED) === '1'; } catch { return false; } };
    const markSess = () => { try { sessionStorage.setItem(SS_OKED, '1'); } catch {} };
    const unmarkSess = () => { try { sessionStorage.removeItem(SS_OKED); } catch {} };

    const dlLabel = () => dirHandle ? 'D/L·' : 'D/L';   // 尾点 = 已固定文件夹
    const syncDlLabel = () => setDlTxt(dlLabel());

    async function pickFolder() {
        if (!FSA) return null;
        let h;
        try { h = await page.showDirectoryPicker({ id: 'nk-tg-dl', mode: 'readwrite', startIn: 'downloads' }); }
        catch (e) {
            // Chrome 只允许在点击后的短暂激活窗口内打开选择器。异步准备工作吃掉这个窗口时
            // 会抛 SecurityError —— 这种情况可以补救（用真实按钮重触发），
            // 与用户主动关闭选择器的 AbortError 要区分开。
            if (e && (e.name === 'SecurityError' || /gesture|activation|user activation/i.test(e.message || ''))) {
                throw new Error(NEEDS_GESTURE);
            }
            return null;
        }
        if ((await dirPerm(h, true)) !== 'granted') return null;
        dirHandle = h; dirLoaded = true;
        markSess();   // 刚手动选过，本次会话不必再确认
        try { await idbRun('readwrite', (s) => s.put(h, DB_KEY)); } catch {}
        return h;
    }

    async function clearFolder() {
        dirHandle = null; dirLoaded = true;
        unmarkSess();
        try { await idbRun('readwrite', (s) => s.delete(DB_KEY)); } catch {}
    }

    // 一个弹层承担两件事：会话首次确认；以及用户手势过期后的补救入口
    // （真实按钮点击必定携带有效手势）。无论哪种，整批只弹这一次。
    function folderModal(count, existing, o) {
        o = o || {};
        return new Promise((resolve) => {
            ensureStyles();
            const name = existing ? esc(existing.name || '') : '';
            const mask = document.createElement('div');
            mask.className = 'nk-mask';
            mask.innerHTML = '<div class="nk-modal" style="width:430px">' +
                '<div class="nk-hd">' + (o.title || '选择保存文件夹') + '</div>' +
                '<div style="padding:0 16px 14px;font-size:13px;line-height:1.7;opacity:.85">' +
                (count ? '即将下载 <b>' + count + '</b> 个文件。' : '') +
                (o.note || '选一次文件夹，本次以及以后的下载全部直写进去，浏览器不会再逐个弹“另存为”。') +
                (existing ? '<br><span style="opacity:.7">当前文件夹：</span>' +
                    '<b style="color:var(--primary-color,#3390ec)">' + name + '</b>' : '') +
                '</div>' +
                '<div class="nk-ft">' +
                '<button class="nk-btn nk-skip">' + (o.skipText || '跳过（走浏览器下载）') + '</button>' +
                (existing ? '<button class="nk-btn nk-change">更换文件夹…</button>' : '') +
                '<button class="nk-btn pri nk-go">' +
                (existing ? '保存到「' + name + '」' : '选择文件夹') +
                '</button></div></div>';

            const done = (v) => { mask.remove(); resolve(v || null); };
            const fresh = async () => {
                let h = null;
                try { h = await pickFolder(); } catch { h = null; }
                done(h);
            };

            mask.querySelector('.nk-skip').addEventListener('click', () => done(null));
            mask.querySelector('.nk-change')?.addEventListener('click', fresh);
            mask.querySelector('.nk-go').addEventListener('click', async () => {
                if (!existing) return fresh();
                // 已固定的目录通常只是新会话里丢了授权，重新要一次即可，
                // 不必让用户再翻一遍目录树。
                const st = await dirPerm(existing, true);
                if (st === 'granted') return done(existing);
                if (st === 'denied') return done(null);
                return fresh();   // 句柄已失效，重新选
            });
            mask.addEventListener('click', (e) => { if (e.target === mask) done(null); });
            document.body.appendChild(mask);
        });
    }

    // 所有下载路径的唯一入口，保证单次点击最多只弹一个窗：
    //   已固定 + 本会话首次  → 一个确认单（保存到此 / 更换 / 跳过）
    //   已固定 + 已确认      → 完全无弹窗
    //   已固定 + 权限过期    → 一次“允许编辑文件？”
    //   未固定 + 自动询问开  → 一次目录选择器，之后永久记住
    // 返回 null 表示调用方维持原来的浏览器下载行为。
    async function ensureDir(count) {
        if (!FSA) return null;
        const h = await loadDir();

        if (h) {
            if (sessAsk() && !sessOked()) {
                const picked = await folderModal(count, h, {
                    title: '确认保存位置',
                    note: '本次启动后的第一次下载，确认一下存哪里。确认后本次会话不再询问。',
                    skipText: '本次走浏览器下载'
                });
                if (picked) markSess();
                return picked;
            }
            const st = await dirPerm(h, true);
            if (st === 'granted') { markSess(); return h; }
            if (st === 'denied') return null;   // 用户刚拒绝，不再叠第二个弹窗
        }

        if (!autoAsk()) return null;

        let picked = null;
        if (h) picked = await folderModal(count, h);   // 句柄失效，需要真实点击
        else {
            try { picked = await pickFolder(); }
            catch (e) {
                if (String(e && e.message) === NEEDS_GESTURE) picked = await folderModal(count, null);
            }
        }
        if (picked) markSess();
        return picked;
    }

    // 不覆盖同名文件：foo.jpg → foo (1).jpg
    async function freeName(h, name) {
        const dot = name.lastIndexOf('.');
        const base = dot > 0 ? name.slice(0, dot) : name;
        const ext = dot > 0 ? name.slice(dot) : '';
        for (let i = 0; i < 300; i++) {
            const candidate = i ? base + ' (' + i + ')' + ext : name;
            try { await h.getFileHandle(candidate); }   // 能取到 = 已占用
            catch { return candidate; }                 // NotFoundError = 可用
        }
        return base + ' (' + Date.now() + ')' + ext;
    }

    async function writeToFolder(h, blob, name) {
        const fh = await h.getFileHandle(await freeName(h, name), { create: true });
        const w = await fh.createWritable();
        try { await w.write(blob); } finally { await w.close(); }
    }

    function openDlSettings() {
        ensureStyles();
        const mask = document.createElement('div');
        mask.className = 'nk-mask';
        const closeSheet = () => mask.remove();

        const body = () => {
            const cur = dirHandle ? dirHandle.name : null;
            return '<div class="nk-hd">下载设置</div>' +
                '<div style="padding:0 16px 12px;font-size:13px;line-height:1.65;opacity:.8">' +
                '本脚本与 Telegram 都不会弹“另存为”——那是浏览器的“每次询问保存位置”设置或 IDM/迅雷 等下载工具接管导致的。<br>' +
                '固定文件夹后，脚本直写磁盘，彻底绕开浏览器下载通道（每次 D/L 最多只问一次）。' +
                '</div>' +
                '<div style="padding:0 16px 10px;font-size:13px">' +
                (FSA
                    ? ('当前：' + (cur
                        ? '<b style="color:var(--primary-color,#3390ec)">' + esc(cur) + '</b>'
                        : '<span style="opacity:.7">未固定（下次点 D/L 会问一次）</span>'))
                    : '<span style="opacity:.7">当前浏览器不支持 File System Access API（需 Chrome / Edge）。<br>' +
                      '请改浏览器设置：设置 → 下载内容 → 关掉“下载前询问每个文件的保存位置”。</span>') +
                '</div>' +
                (FSA ? '<label style="display:flex;gap:8px;align-items:flex-start;padding:0 16px 10px;font-size:13px;cursor:pointer">' +
                    '<input type="checkbox" class="nk-auto"' + (autoAsk() ? ' checked' : '') + ' style="margin-top:3px">' +
                    '<span>未固定时，点 D/L 自动弹一次文件夹选择' +
                    '<br><span style="opacity:.6">关掉则回到旧行为：全部交给浏览器下载</span></span></label>' +
                    '<label style="display:flex;gap:8px;align-items:flex-start;padding:0 16px 14px;font-size:13px;cursor:pointer">' +
                    '<input type="checkbox" class="nk-sess"' + (sessAsk() ? ' checked' : '') + ' style="margin-top:3px">' +
                    '<span>重开浏览器后，首次下载先确认一次保存位置' +
                    '<br><span style="opacity:.6">本次会话：' +
                    (sessOked()
                        ? '已确认（不再询问）　<a class="nk-reset" href="javascript:void 0" style="color:var(--primary-color,#3390ec)">下次重新确认</a>'
                        : '尚未确认') +
                    '</span></span></label>' : '') +
                '<div class="nk-ft">' +
                (cur ? '<button class="nk-btn nk-clear">取消固定</button>' : '') +
                '<button class="nk-btn nk-close">关闭</button>' +
                (FSA ? '<button class="nk-btn pri nk-pick">' + (cur ? '更换文件夹' : '选择文件夹') + '</button>' : '') +
                '</div>';
        };

        const paint = () => {
            mask.innerHTML = '<div class="nk-modal" style="width:420px">' + body() + '</div>';
            mask.querySelector('.nk-close').addEventListener('click', closeSheet);
            mask.querySelector('.nk-auto')?.addEventListener('change', (e) => setAutoAsk(e.target.checked));
            mask.querySelector('.nk-sess')?.addEventListener('change', (e) => { setSessAsk(e.target.checked); paint(); });
            mask.querySelector('.nk-reset')?.addEventListener('click', (e) => { e.preventDefault(); unmarkSess(); paint(); });
            mask.querySelector('.nk-pick')?.addEventListener('click', async () => {
                let h = null;
                try { h = await pickFolder(); } catch { h = null; }
                if (h) { paint(); syncDlLabel(); }
            });
            mask.querySelector('.nk-clear')?.addEventListener('click', async () => {
                await clearFolder(); paint(); syncDlLabel();
            });
        };

        loadDir().then(paint);
        mask.addEventListener('click', (e) => { if (e.target === mask) closeSheet(); });
        document.body.appendChild(mask);
    }

    /* ===================== 4. 媒体元数据与内存下载 ===================== */

    const EXT_FIX = { quicktime: 'mov', 'x-matroska': 'mkv', jpeg: 'jpg', mpeg: 'mp3', 'x-msvideo': 'avi', plain: 'txt' };

    // 从 media 对象还原出上传所需的文件名、MIME、宽高、时长与类型标志。
    function metaOf(media) {
        if (isPhotoMedia(media)) {
            const big = bigSize(media) || {};
            return {
                name: 'photo_' + (media.id || Date.now()) + '.jpg',
                mime: 'image/jpeg', isPhoto: true, isVideo: false,
                w: big.w, h: big.h
            };
        }

        const attrs = media.attributes || [];
        const vid = attrs.find((a) => a._ === 'documentAttributeVideo');
        const aud = attrs.find((a) => a._ === 'documentAttributeAudio');
        const fnA = attrs.find((a) => a._ === 'documentAttributeFilename');
        const mime = media.mime_type || 'application/octet-stream';
        const type = media.type || '';

        let name = media.fileName || fnA?.file_name;
        if (!name) {
            let ext = (mime.split('/')[1] || 'bin').split(';')[0];
            ext = EXT_FIX[ext] || ext;
            name = (type || 'file') + '_' + (media.id || Date.now()) + '.' + ext;
        }

        return {
            name, mime,
            isPhoto: mime.startsWith('image/') && type !== 'sticker' && type !== 'gif',
            isVideo: !!vid || type === 'video' || type === 'gif' || type === 'round' || mime.startsWith('video/'),
            isVoice: !!aud?.pFlags?.voice || type === 'voice',
            isRound: !!vid?.pFlags?.round_message || type === 'round',
            isSticker: type === 'sticker',
            w: media.w || vid?.w,
            h: media.h || vid?.h,
            duration: media.duration ?? vid?.duration ?? aud?.duration
        };
    }

    // downloadToDisc() 走 Service Worker 直接落盘，拿不到数据；
    // downloadMedia() 是它下面那层，返回内存中的 Blob —— 重新上传和直写磁盘都依赖它。
    function startDownload(media) {
        const dm = page.appDownloadManager;
        if (!dm) throw new Error('appDownloadManager 不存在');
        const fn = dm.downloadMedia ? 'downloadMedia' : (dm.download ? 'download' : null);
        if (!fn) throw new Error('未找到下载接口');

        // 图片没有 mime_type，其文件位置要从某个 photoSize 推导，所以 tweb 自己的
        // downloadToDisc() 会先补上 thumb 再调 downloadMedia()。这里必须对齐，
        // 否则 getDownloadMediaDetails() 无法为图片构造文件名和位置。
        const opts = { media };
        if (isPhotoMedia(media)) {
            const t = bigSize(media);
            if (t) opts.thumb = t;
        }

        try { return dm[fn](opts); }
        catch { return dm[fn]({ media }); }
    }

    async function toBlob(promise) {
        const res = await promise;
        if (res instanceof Blob) return res;
        if (res && res.blob instanceof Blob) return res.blob;
        if (typeof res === 'string') return await (await fetch(res)).blob();
        throw new Error('下载结果不是 Blob');
    }

    // 不带缩略图上传的视频在 Telegram 里封面是全黑的，所以离屏抽一帧。
    // 纯属锦上添花：任何一步失败都直接返回 null，不影响上传。
    function videoThumb(blob) {
        return new Promise((resolve) => {
            const src = URL.createObjectURL(blob);
            const v = document.createElement('video');
            let settled = false;
            const done = (val) => {
                if (settled) return;
                settled = true;
                clearTimeout(timer);
                try { v.removeAttribute('src'); v.load(); } catch {}
                URL.revokeObjectURL(src);
                resolve(val);
            };
            const timer = setTimeout(() => done(null), 10000);

            v.muted = true; v.playsInline = true; v.preload = 'metadata'; v.src = src;
            v.addEventListener('error', () => done(null));
            v.addEventListener('loadeddata', () => {
                try { v.currentTime = Math.min(0.8, (v.duration || 1) / 3); } catch { done(null); }
            });
            v.addEventListener('seeked', () => {
                try {
                    const vw = v.videoWidth || 320, vh = v.videoHeight || 240;
                    const scale = Math.min(1, 320 / Math.max(vw, vh));
                    const c = document.createElement('canvas');
                    c.width = Math.max(1, Math.round(vw * scale));
                    c.height = Math.max(1, Math.round(vh * scale));
                    c.getContext('2d').drawImage(v, 0, 0, c.width, c.height);
                    c.toBlob((b) => {
                        if (!b) return done(null);
                        done({ blob: b, url: URL.createObjectURL(b), size: { _: 'photoSize', type: 'm', w: c.width, h: c.height, size: b.size } });
                    }, 'image/jpeg', 0.85);
                } catch { done(null); }
            });
        });
    }

    /* ===================== 5. 下载（D/L 与右键菜单）===================== */

    async function download(msg, dir) {
        const media = mediaOf(msg);
        const dm = page.appDownloadManager;
        if (!dm) { console.warn('[tg-save] appDownloadManager 缺失，WebK 内部结构可能已变'); return; }
        if (!media) return;

        // 已固定文件夹：自己取字节直写磁盘。超大文件仍走 Service Worker 流式下载，
        // 免得把几个 GB 的 Blob 堆在内存里。
        if (dir && sizeOf(media) <= MEM_LIMIT) {
            const blob = await toBlob(startDownload(media));
            await writeToFolder(dir, blob, metaOf(media).name);
            return;
        }
        await dm.downloadToDisc({ media });
    }

    // ZF 的“同时存一份到本地”也复用固定文件夹，否则又会退回浏览器下载并弹框。
    async function saveLocally(blob, name) {
        const dir = await folderReady(false);
        if (dir) {
            try { await writeToFolder(dir, blob, name); return; }
            catch (e) { console.warn('[tg-save] 写入文件夹失败，回退浏览器下载', e); }
        }
        const a = document.createElement('a');
        a.href = URL.createObjectURL(blob);
        a.download = name;
        document.body.appendChild(a);
        a.click();
        a.remove();
        setTimeout(() => URL.revokeObjectURL(a.href), 60000);
    }

    // 右键菜单是 Telegram 动态创建的，先在 mouseup 阶段记下命中的气泡，
    // 等菜单节点出现时再往里插“Download”。
    let pending = null;

    document.addEventListener('mouseup', (e) => {
        pending = null;
        if (e.button !== 2) return;
        const bubble = e.target.closest('[data-mid]');
        if (!bubble || !bubble.closest('.no-forwards')) return;
        if (mediaOf(lookup(bubble.dataset.peerId, bubble.dataset.mid))) {
            pending = { peerId: bubble.dataset.peerId, mid: bubble.dataset.mid };
        }
    });

    function addDownloadItem(menu) {
        const first = menu.querySelector('.btn-menu-item');
        if (!pending || !first || menu.querySelector('#nk-tg-down')) return;
        const { peerId, mid } = pending;
        first.insertAdjacentHTML('beforebegin',
            '<div class="btn-menu-item rp-overflow" id="nk-tg-down">' +
            '<span class="btn-menu-item-icon" style="font-size:1rem">' + ICON + '</span>' +
            '<span class="btn-menu-item-text">Download</span></div>');
        menu.querySelector('#nk-tg-down').addEventListener('click', async () => {
            const dir = await ensureDir(1);
            syncDlLabel();
            download(lookup(peerId, mid), dir)
                .catch((err) => console.warn('[tg-save] 下载失败', err));
        });
    }

    async function downloadSelected() {
        const sel = page.appImManager?.chat?.selection;
        const msgs = ((await sel?.getSelectedMessages()) || []).filter(mediaOf);
        if (!msgs.length) { setDlTxt('N/A'); await delay(1500); syncDlLabel(); return; }

        // 整批只在这里定一次目标目录：选 1 个还是 500 个，弹窗都只可能出现在这一刻。
        const dir = await ensureDir(msgs.length);
        syncDlLabel();
        setBusy('nk-tg-batch', true);

        if (!dir) {
            // 未固定目录 → 保持原始的发射后不管行为，由 Service Worker 逐个流式推给浏览器。
            for (let i = 0; i < msgs.length; i++) {
                setDlTxt((i + 1) + '/' + msgs.length);
                download(msgs[i]).catch((err) => console.warn('[tg-save] 批量项失败', err));
                if (i < msgs.length - 1) await delay(BATCH_GAP_MS);
            }
        } else {
            // 文件夹模式必须串行：每个文件都要先缓冲再写盘，并行会同时堆 N 个 Blob。
            // 进度改由 HUD 承载，所以选择栏可以立刻收起。
            sel?.cancelSelection();
            const hud = createHud('保存到：' + (dir.name || '已选文件夹'));
            let ok = 0, fail = 0;

            for (let i = 0; i < msgs.length && !hud.cancelled; i++) {
                const m = mediaOf(msgs[i]);
                const meta = metaOf(m);
                const tag = '(' + (i + 1) + '/' + msgs.length + ') ';
                setDlTxt((i + 1) + '/' + msgs.length);

                try {
                    if (sizeOf(m) > MEM_LIMIT) {
                        hud.status(tag + meta.name);
                        await page.appDownloadManager.downloadToDisc({ media: m });
                        ok++; hud.log('→ ' + meta.name + '（过大，转浏览器下载）');
                    } else {
                        hud.status(tag + meta.name);
                        const p = startDownload(m);
                        hud.current = p;
                        try { p.addNotifyListener?.((d) => { if (d?.total) hud.progress((i + d.done / d.total) / msgs.length); }); }
                        catch {}
                        const blob = await toBlob(p);
                        hud.current = null;
                        if (hud.cancelled) break;
                        await writeToFolder(dir, blob, meta.name);
                        ok++; hud.log('✓ ' + meta.name);
                    }
                } catch (err) {
                    fail++; hud.log('✗ ' + meta.name + '：' + (err?.message || err));
                    console.warn('[tg-save] 写入文件夹失败', err);
                }

                hud.progress((i + 1) / msgs.length);
            }

            hud.done = true;
            hud.progress(1);
            hud.status((hud.cancelled ? '已停止' : '完成') + '：成功 ' + ok + '，失败 ' + fail);
            setTimeout(() => { if (hud.done) hud.close(); }, 12000);
        }

        setBusy('nk-tg-batch', false);
        syncDlLabel();
        sel?.cancelSelection();
    }

    /* ===================== 6. ZF 批量转发 ===================== */

    // 把内存里的 Blob 当作全新文件上传。sendFile 在不同 WebK 版本签名有出入，
    // 因此做三级回退：新签名 → 旧的 (peerId, file, opts) → 去掉可能不认的附加字段。
    async function sendTo(peerId, file, meta, opts, caption, thumb) {
        const am = mgrs()?.appMessagesManager;
        if (!am?.sendFile) throw new Error('appMessagesManager.sendFile 不存在');

        const asMedia = !opts.asFile && (meta.isPhoto || meta.isVideo);
        const o = { peerId: Number(peerId), file, fileName: meta.name, isMedia: asMedia };

        if (caption) o.caption = caption;
        if (asMedia) {
            if (meta.w) o.width = meta.w;
            if (meta.h) o.height = meta.h;
            if (meta.duration != null) o.duration = meta.duration;
            if (thumb) o.thumb = thumb;
            try { o.objectURL = URL.createObjectURL(file); } catch {}
            if (meta.isRound) o.isRoundMessage = true;
        }
        if (meta.isVoice && !opts.asFile) o.isVoiceMessage = true;

        try {
            return await am.sendFile(o);
        } catch {
            try { return await am.sendFile(Number(peerId), file, o); }
            catch {
                delete o.thumb; delete o.objectURL;
                return await am.sendFile(o);
            }
        }
    }

    // 调用 WebK 真身的 sendGrouped，把一组媒体合并成一条相册发出。
    // isMedia 控制按图片/视频发送（true）还是文档文件（false）；sendGrouped 内部给每项
    // 打相同 groupId 后走 messages.sendMultiMedia，目标会话显示为一条相册。
    // sendGrouped 不存在（老版本）时回退为逐条 sendFile（旧行为）。
    async function sendAlbum(peerId, items, opts, caption) {
        const am = mgrs()?.appMessagesManager;
        if (!am) throw new Error('appMessagesManager 不存在');

        const details = items.map((it) => {
            const d = { file: it.file };
            if (it.meta.w) d.width = it.meta.w;
            if (it.meta.h) d.height = it.meta.h;
            if (it.meta.duration != null) d.duration = it.meta.duration;
            if (it.thumb) d.thumb = it.thumb;
            try { d.objectURL = URL.createObjectURL(it.file); } catch {}
            return d;
        });

        const asMedia = !opts.asFile;
        const args = { peerId: Number(peerId), sendFileDetails: details, isMedia: asMedia };
        if (caption) args.caption = caption;

        if (typeof am.sendGrouped === 'function') {
            try { return await am.sendGrouped(args); }
            catch {
                try { return await am.sendGrouped(Number(peerId), details, { isMedia: asMedia, caption }); }
                catch {}
            }
        }
        // 回退：逐条发送
        for (let i = 0; i < items.length; i++) {
            await sendTo(peerId, items[i].file, items[i].meta, opts, i === 0 ? caption : '', items[i].thumb);
        }
    }

    // 把 peerId 归一成会话选择列表需要的展示信息；已退出/被踢的会话返回 null 过滤掉。
    async function peerInfo(peerId) {
        peerId = Number(peerId);
        if (!Number.isFinite(peerId) || peerId === 0) return null;
        const m = mgrs();
        let peer = null;
        try { peer = await m?.appPeersManager?.getPeer(peerId); } catch {}

        let title = '', type = 'user', username = '', canPost = true;
        if (peer) {
            username = peer.username || peer.usernames?.[0]?.username || '';
            if (peer.pFlags?.left || peer.pFlags?.kicked) return null;
            if (peer._ === 'chat' || peer._ === 'chatForbidden') {
                title = peer.title || ''; type = 'group';
            } else if (peer._ === 'channel' || peer._ === 'channelForbidden') {
                title = peer.title || '';
                type = peer.pFlags?.megagroup ? 'group' : 'channel';
                // 广播频道没有发言权就置灰，避免选中后整批失败。
                if (type === 'channel') canPost = !!(peer.pFlags?.creator || peer.admin_rights?.post_messages);
            } else {
                title = [peer.first_name, peer.last_name].filter(Boolean).join(' ') || username;
                type = 'user';
            }
        }
        if (!title) title = username || ('ID ' + peerId);
        if (peerId === Number(page.rootScope?.myId || page.appImManager?.myId || 0)) title = '收藏夹 (Saved Messages)';
        return { peerId, title, type, username, canPost };
    }

    async function loadChats() {
        const m = mgrs();
        const ids = [];
        const seen = new Set();
        const push = (id) => { const k = String(id); if (!seen.has(k)) { seen.add(k); ids.push(id); } };

        // 收藏夹排最前，它是最常用的转发目标。
        const my = Number(page.rootScope?.myId || page.appImManager?.myId || 0);
        if (my) push(my);

        // 各版本 dialogsStorage 的取会话方法名不一致，挨个试，成功即止。
        if (m?.dialogsStorage) {
            for (const fn of ['getFolderDialogs', 'getCachedDialogs', 'getDialogs']) {
                try {
                    const d = await m.dialogsStorage[fn]?.(0);
                    const arr = Array.isArray(d) ? d : (Array.isArray(d?.dialogs) ? d.dialogs : null);
                    if (arr && arr.length) { arr.forEach((x) => x?.peerId != null && push(x.peerId)); break; }
                } catch {}
            }
        }
        // 兜底：把左侧栏已渲染出来的会话补进去。
        document.querySelectorAll('.chatlist [data-peer-id]').forEach((el) => push(el.dataset.peerId));

        const out = [];
        for (const id of ids.slice(0, 500)) {
            const info = await peerInfo(id);
            if (info) out.push(info);
        }
        return out;
    }

    // 列表里搜不到时的兜底：支持直接输入 @用户名 或数字 ID。
    async function resolveQuery(q) {
        q = String(q || '').trim().replace(/^@/, '');
        if (!q) return null;
        if (/^-?\d+$/.test(q)) return await peerInfo(Number(q));
        try {
            const r = await mgrs()?.appUsersManager?.resolveUsername?.(q);
            if (r) return await peerInfo(r._ === 'user' ? r.id : -r.id);
        } catch {}
        return null;
    }

    const AV_COLORS = ['#e17076', '#7bc862', '#e5ca77', '#65aadd', '#a695e7', '#ee7aae', '#6ec9cb', '#faa774'];
    const avColor = (id) => AV_COLORS[Math.abs(Number(id)) % AV_COLORS.length];
    const typeLabel = (it) => it.type === 'group' ? '群组' : (it.type === 'channel' ? (it.canPost ? '频道' : '频道·无权发言') : '私聊');

    // 目标会话选择框。resolve({peerId, title, opts}) 或 resolve(null) 表示取消。
    function pickTarget(count) {
        return new Promise((resolve) => {
            ensureStyles();
            let saved = {};
            try { saved = JSON.parse(localStorage.getItem(LS_OPTS) || '{}'); } catch {}
            const lastPeer = localStorage.getItem(LS_PEER);

            const mask = document.createElement('div');
            mask.className = 'nk-mask';
            mask.innerHTML =
                '<div class="nk-modal">' +
                '<div class="nk-hd">把 ' + count + ' 个媒体转发到…</div>' +
                '<input class="nk-search" placeholder="搜索会话名称 / @用户名 / ID">' +
                '<div class="nk-chips">' +
                '<span class="nk-chip on" data-f="all">全部</span>' +
                '<span class="nk-chip" data-f="group">群组</span>' +
                '<span class="nk-chip" data-f="channel">频道</span>' +
                '<span class="nk-chip" data-f="user">私聊</span>' +
                '</div>' +
                '<div class="nk-list"><div style="padding:18px;opacity:.6">正在读取会话列表…</div></div>' +
                '<div class="nk-opts">' +
                '<label><input type="checkbox" class="nk-o-cap"><span class="nk-box"></span><span class="nk-o-tx">携带原消息的文字说明</span></label>' +
                '<label><input type="checkbox" class="nk-o-file"><span class="nk-box"></span><span class="nk-o-tx">以「文件」方式发送（不压缩）</span></label>' +
                '<label><input type="checkbox" class="nk-o-save"><span class="nk-box"></span><span class="nk-o-tx">同时保存一份到本地</span></label>' +
                '</div>' +
                '<div class="nk-ft"><button class="nk-btn nk-cancel">取消</button>' +
                '<button class="nk-btn pri nk-ok" disabled>开始转发</button></div>' +
                '</div>';
            document.body.appendChild(mask);

            const listEl = mask.querySelector('.nk-list');
            const okBtn = mask.querySelector('.nk-ok');
            const searchEl = mask.querySelector('.nk-search');
            const cCap = mask.querySelector('.nk-o-cap');
            const cFile = mask.querySelector('.nk-o-file');
            const cSave = mask.querySelector('.nk-o-save');
            cCap.checked = !!saved.keepCaption;
            cFile.checked = !!saved.asFile;
            cSave.checked = !!saved.saveLocal;

            let all = [], filter = 'all', query = '', selected = null, extra = null;

            const visible = () => {
                const q = query.toLowerCase();
                return all.filter((it) => {
                    if (filter !== 'all' && it.type !== filter) return false;
                    if (!q) return true;
                    return it.title.toLowerCase().includes(q) ||
                        (it.username || '').toLowerCase().includes(q) ||
                        String(it.peerId).includes(q);
                });
            };

            const row = (it) =>
                '<div class="nk-item' + (selected && selected.peerId === it.peerId ? ' sel' : '') +
                (it.canPost === false ? ' dis' : '') + '" data-p="' + it.peerId + '">' +
                '<div class="nk-av" style="background:' + avColor(it.peerId) + '">' + esc((it.title || '?').trim().charAt(0).toUpperCase()) + '</div>' +
                '<div class="nk-tt">' + esc(it.title) + '</div>' +
                '<div class="nk-tag">' + typeLabel(it) + '</div></div>';

            function render() {
                const items = visible();
                let html = items.slice(0, 400).map(row).join('');
                if (extra && !items.some((i) => i.peerId === extra.peerId)) html = row(extra) + html;
                if (!html) {
                    html = '<div style="padding:18px;opacity:.6">没有匹配的会话' +
                        (query ? '<br><span class="nk-resolve" style="color:var(--primary-color,#3390ec);cursor:pointer">尝试解析 “' + esc(query) + '”</span>' : '') +
                        '</div>';
                }
                listEl.innerHTML = html;
                okBtn.disabled = !selected;
            }

            listEl.addEventListener('click', async (e) => {
                const res = e.target.closest('.nk-resolve');
                if (res) {
                    res.textContent = '解析中…';
                    const info = await resolveQuery(query);
                    if (info) { extra = info; selected = info; render(); }
                    else res.textContent = '无法解析，请换个关键词';
                    return;
                }
                const item = e.target.closest('.nk-item');
                if (!item || item.classList.contains('dis')) return;
                const pid = Number(item.dataset.p);
                selected = all.find((x) => x.peerId === pid) || (extra && extra.peerId === pid ? extra : null);
                render();
            });

            mask.querySelectorAll('.nk-chip').forEach((chip) => chip.addEventListener('click', () => {
                mask.querySelectorAll('.nk-chip').forEach((c) => c.classList.remove('on'));
                chip.classList.add('on');
                filter = chip.dataset.f;
                render();
            }));

            searchEl.addEventListener('input', () => { query = searchEl.value.trim(); extra = null; render(); });

            function finish(val) { mask.remove(); resolve(val); }
            function submit() {
                const opts = { keepCaption: cCap.checked, asFile: cFile.checked, saveLocal: cSave.checked };
                try {
                    localStorage.setItem(LS_OPTS, JSON.stringify(opts));
                    localStorage.setItem(LS_PEER, String(selected.peerId));
                } catch {}
                finish({ peerId: selected.peerId, title: selected.title, opts });
            }

            // 拦在捕获阶段，防止 Telegram 的全局快捷键把输入吞掉。
            mask.addEventListener('keydown', (e) => {
                e.stopPropagation();
                if (e.key === 'Escape') finish(null);
                if (e.key === 'Enter' && selected) submit();
            }, true);

            mask.querySelector('.nk-cancel').addEventListener('click', () => finish(null));
            okBtn.addEventListener('click', submit);
            mask.addEventListener('mousedown', (e) => { if (e.target === mask) finish(null); });

            loadChats().then((chats) => {
                all = chats;
                if (lastPeer) selected = all.find((x) => String(x.peerId) === lastPeer && x.canPost !== false) || null;
                render();
                setTimeout(() => searchEl.focus(), 60);
            }).catch((err) => {
                listEl.innerHTML = '<div style="padding:18px;opacity:.7">读取会话失败：' + esc(err.message || err) +
                    '<br>可在上方直接输入 @用户名 或 ID</div>';
            });
        });
    }

    // 右下角进度浮窗，下载与转发共用。cancelled 由调用方在循环里检查。
    function createHud(title) {
        ensureStyles();
        const el = document.createElement('div');
        el.className = 'nk-hud';
        el.innerHTML =
            '<div style="display:flex;justify-content:space-between;align-items:center">' +
            '<b>→ ' + esc(title) + '</b><span class="nk-x">✕</span></div>' +
            '<div class="nk-st" style="margin-top:4px;opacity:.85">准备中…</div>' +
            '<div class="nk-bar"><i></i></div>' +
            '<div class="nk-file" style="margin-top:4px;font-size:12px;opacity:.7"></div>' +
            '<div class="nk-log"></div>';
        document.body.appendChild(el);

        const api = {
            el,
            done: false,
            cancelled: false,
            current: null,        // 当前下载句柄，用于中断
            status(t) { el.querySelector('.nk-st').textContent = t; },
            progress(p) { el.querySelector('.nk-bar > i').style.width = Math.max(0, Math.min(1, p)) * 100 + '%'; },
            // 单条媒体的实时下载进度（字节级），与上方整组进度条并存，便于用户看清每项进度。
            file(t) { const f = el.querySelector('.nk-file'); if (f) f.textContent = t; },
            log(t) {
                const log = el.querySelector('.nk-log');
                log.insertAdjacentHTML('beforeend', '<div>' + esc(t) + '</div>');
                log.scrollTop = log.scrollHeight;
            },
            close() { el.remove(); }
        };
        el.querySelector('.nk-x').addEventListener('click', () => {
            if (api.done) return api.close();
            api.cancelled = true;
            api.status('已请求停止，等当前项结束…');
            try { api.current?.cancel?.(); } catch {}
        });
        return api;
    }

    // 按 grouped_id 分组「下载到内存 → 重新上传」，同组用 sendGrouped 合并成一条相册。
    async function forwardSelected() {
        const sel = page.appImManager?.chat?.selection;
        const all = ((await sel?.getSelectedMessages()) || []).filter(mediaOf)
            .sort((a, b) => (a.mid || 0) - (b.mid || 0));

        if (!all.length) { setZfTxt('N/A'); await delay(1500); setZfTxt('ZF'); return; }

        const choice = await pickTarget(all.length);
        if (!choice) return;

        // 选中媒体的总体积，转发前用于「总大小 vs 可用内存」的安全比对。
        const totalBytes = all.reduce((s, m) => s + sizeOf(mediaOf(m)), 0);
        const mem = availMem();

        const hud = createHud(choice.title);
        hud.log('待转发 ' + all.length + ' 项，共 ' + b2s(totalBytes) +
            '；可用内存约 ' + b2s(mem.bytes) + (mem.real ? '' : '（估算）'));

        // 内存安全比对：仅当可实测可用内存、且总大小超过 85% 余量时直接中止，
        // 避免标签页因一次性把全部大文件堆进内存而崩溃。
        if (mem.real && totalBytes > mem.bytes * 0.85) {
            hud.status('⚠ 待转发总大小 ' + b2s(totalBytes) + ' 超过可用内存 ' + b2s(mem.bytes) + '，已停止');
            hud.log('✗ 内存可能不足，请减少本次转发数量、或分多批转发后再试');
            hud.done = true;
            hud.progress(1);
            setTimeout(() => { if (hud.done) hud.close(); }, 20000);
            setBusy('nk-tg-fwd', false);
            setZfTxt('ZF');
            return;
        }

        // 「同时存一份到本地」也不能变成逐个弹保存框，在目标选完后统一定一次目录。
        if (choice.opts.saveLocal) { await ensureDir(all.length); syncDlLabel(); }

        setBusy('nk-tg-fwd', true);
        sel?.cancelSelection();

        let ok = 0, fail = 0;

        // 按 grouped_id 分组：同一相册的多条媒体合并成一条相册发送；无 grouped_id 的各自成组。
        const groups = new Map();
        for (const m of all) {
            const key = m.grouped_id != null ? m.grouped_id : '__single_' + (m.mid || (ok + fail));
            if (!groups.has(key)) groups.set(key, []);
            groups.get(key).push(m);
        }
        const groupList = [...groups.values()];

        let done = 0;
        for (let gi = 0; gi < groupList.length; gi++) {
            if (hud.cancelled) break;
            const g = groupList[gi];
            const items = [];
            let groupCaption = '';

            try {
                for (let i = 0; i < g.length; i++) {
                    const media = mediaOf(g[i]);
                    const meta = metaOf(media);
                    const tag = '(' + (gi + 1) + '/' + groupList.length + ')[' + (i + 1) + '/' + g.length + '] ';
                    setZfTxt((gi + 1) + '/' + groupList.length);

                    hud.status(tag + '下载 ' + meta.name);
                    const p = startDownload(media);
                    hud.current = p;
                    // 整组进度条按「已完成条数 + 当前条下载比例」推进；
                    // 单条媒体的实时字节进度单独显示在下方 .nk-file 行，方便看清每项进度。
                    try {
                        p.addNotifyListener?.((d) => {
                            if (d?.total) {
                                hud.progress((done + d.done / d.total) / all.length);
                                const pct = Math.min(99, Math.round((d.done / d.total) * 100));
                                hud.file(tag + '下载 ' + meta.name + '：' + b2s(d.done) + ' / ' + b2s(d.total) + ' (' + pct + '%)');
                            }
                        });
                    } catch {}
                    const blob = await toBlob(p);
                    hud.current = null;
                    hud.file('');   // 本条下载完成，清空单条进度行

                    if (hud.cancelled) break;
                    if (choice.opts.saveLocal) saveLocally(blob, meta.name).catch(() => {});

                    const file = new File([blob], meta.name, { type: meta.mime });
                    let thumb = null;
                    if (!choice.opts.asFile && meta.isVideo) thumb = await videoThumb(blob);
                    // 相册只能带一条说明，放在首条；无分组的单条则各自带自己的说明。
                    if (choice.opts.keepCaption && i === 0) groupCaption = g[0].message || '';
                    items.push({ file, meta, thumb });
                }

                if (hud.cancelled) break;
                if (!items.length) continue;

                hud.file('');
                hud.status('(' + (gi + 1) + '/' + groupList.length + ') 上传 ' + items.length + ' 项');
                await sendAlbum(choice.peerId, items, choice.opts, groupCaption);
                ok += g.length;
                hud.log('✓ 组 ' + (gi + 1) + ' (' + items.length + ' 项)');
            } catch (err) {
                fail += g.length;
                hud.log('✗ 组 ' + (gi + 1) + ' 失败: ' + (err?.message || err));
                console.warn('[tg-zf] 发送失败', err);
            }

            done += g.length;
            hud.progress(done / all.length);
            if (gi < groupList.length - 1) await delay(SEND_GAP_MS);
        }

        hud.done = true;
        hud.progress(1);
        // sendGrouped/sendFile 返回时只代表入队成功，实际上传仍在 Telegram 后台进行。
        hud.status((hud.cancelled ? '已停止' : '完成') + '：成功 ' + ok + '，失败 ' + fail +
            (ok ? '（上传在 Telegram 后台继续）' : ''));
        hud.el.insertAdjacentHTML('beforeend',
            '<div style="margin-top:8px"><span class="nk-open" style="color:var(--primary-color,#3390ec);cursor:pointer">打开目标会话</span></div>');
        hud.el.querySelector('.nk-open').addEventListener('click', () => {
            const im = page.appImManager;
            try { im.setInnerPeer ? im.setInnerPeer({ peerId: Number(choice.peerId) }) : im.setPeer({ peerId: Number(choice.peerId) }); }
            catch (e) { console.warn('[tg-zf] 打开会话失败', e); }
            hud.close();
        });
        setTimeout(() => { if (hud.done) hud.close(); }, 20000);

        setBusy('nk-tg-fwd', false);
        setZfTxt('ZF');
    }

    /* ===================== 7. 装配 ===================== */

    // 多选工具栏出现时挂上 D/L、⚙、ZF 三个按钮（每个都先查重，避免重复插入）。
    function addBatchButton(wrapper) {
        const bar = wrapper.querySelector('.selection-container');
        if (!bar) return;

        if (!bar.querySelector('#nk-tg-batch')) {
            bar.insertAdjacentHTML('beforeend',
                '<button id="nk-tg-batch" class="btn-primary btn-transparent text-bold" ' +
                'title="左键：批量下载选中媒体（文件夹每次最多只问一次）　右键 / ⚙️：下载设置" ' +
                'style="cursor:pointer;width:auto;">' +
                '<span style="font-size:1rem;margin:0 .4rem .2rem 0;">' + ICON + '</span> <span class="nk-txt">D/L</span></button>');
            const dlBtn = bar.querySelector('#nk-tg-batch');
            dlBtn.addEventListener('click', downloadSelected);
            dlBtn.addEventListener('contextmenu', (e) => {
                e.preventDefault();
                e.stopPropagation();
                openDlSettings();
            });
            // 已固定文件夹时按钮显示为 D/L·，当前模式一眼可见。
            loadDir().then(syncDlLabel);
        }

        if (!bar.querySelector('#nk-tg-cfg')) {
            bar.insertAdjacentHTML('beforeend',
                '<button id="nk-tg-cfg" class="btn-primary btn-transparent text-bold" ' +
                'title="下载设置：设置 / 更换 / 取消保存文件夹" ' +
                'style="cursor:pointer;width:auto;">' +
                '<span style="font-size:1rem;margin:0 .2rem .2rem 0;">' + ICON_CFG + '</span></button>');
            bar.querySelector('#nk-tg-cfg').addEventListener('click', (e) => {
                e.preventDefault(); e.stopPropagation(); openDlSettings();
            });
        }

        if (!bar.querySelector('#nk-tg-fwd')) {
            bar.insertAdjacentHTML('beforeend',
                '<button id="nk-tg-fwd" class="btn-primary btn-transparent text-bold" ' +
                'title="先下载选中媒体，再以新文件上传到指定会话" style="cursor:pointer;width:auto;">' +
                '<span style="font-size:1rem;margin:0 .4rem .2rem 0;">' + ICON_FWD + '</span> <span class="nk-txt">ZF</span></button>');
            bar.querySelector('#nk-tg-fwd').addEventListener('click', forwardSelected);
        }
    }

    // 受限聊天里 Telegram 会在捕获阶段吞掉 copy 事件，这里抢先中断它的传播。
    document.addEventListener('copy', (e) => {
        const node = window.getSelection()?.anchorNode;
        const el = node && (node.nodeType === 1 ? node : node.parentElement);
        if (el?.closest('.no-forwards')) e.stopImmediatePropagation();
    }, true);

    ensureStyles();

    // 右键菜单和多选栏都是用完即弃的动态节点，只能靠 DOM 变化来接管。
    const observer = new MutationObserver((mutations) => {
        for (const m of mutations) {
            for (const node of m.addedNodes) {
                if (node.nodeType !== 1) continue;
                if (node.id === 'bubble-contextmenu') addDownloadItem(node);
                else if (node.classList.contains('selection-wrapper')) addBatchButton(node);
            }
        }
    });
    const start = () => observer.observe(document.body, { childList: true, subtree: true });
    if (document.body) start();
    else document.addEventListener('DOMContentLoaded', start, { once: true });
})();

(() => {
  if (window.__duckeyActive) { console.warn('[Duckey] already running.'); return; }
  window.__duckeyActive = true;

  const VERSION = '2.2';
  const MAGIC = 'DKY1:';
  const PBKDF2_ITERATIONS = 150000;
  const CHANNEL_PREFIXES = ['channels___', 'private-channels___'];
  const CIPHER_RE = /DKY1:[A-Za-z0-9+/=]+/g;
  const URL_ONLY_RE = /^https?:\/\/\S+$/i;
  const CHANNEL_MENU_HINTS = /Mark as Read|Copy Channel ID|Close DM|Invite to Server|Leave Group|Add Friend|Mute .+\(|Change Nickname|Edit Per Server Profile/i;

  const memStore = {};
  const store = {
    get(k) { try { const v = localStorage.getItem(k); if (v !== null) return v; } catch {} return memStore[k] ?? null; },
    set(k, v) { try { localStorage.setItem(k, v); } catch {} memStore[k] = v; },
  };

  const keys = new Map();
  let encryptedChannels = new Set();
  try { const raw = store.get('duckey:channels'); if (raw) encryptedChannels = new Set(JSON.parse(raw)); } catch {}
  const saveChannels = () => store.set('duckey:channels', JSON.stringify([...encryptedChannels]));
  const decryptCache = new Map();

  const TE = new TextEncoder();
  const TD = new TextDecoder();

  const toB64 = (b) => {
    let s = '';
    for (let i = 0; i < b.length; i += 0x8000) s += String.fromCharCode.apply(null, b.subarray(i, i + 0x8000));
    return btoa(s);
  };

  const fromB64 = (str) => {
    const bin = atob(str);
    const o = new Uint8Array(bin.length);
    for (let i = 0; i < bin.length; i++) o[i] = bin.charCodeAt(i);
    return o;
  };

  const channelSalt = async (id) => new Uint8Array(await crypto.subtle.digest('SHA-256', TE.encode('duckey/v1/' + id))).slice(0, 16);

  const deriveKey = async (pw, id) => {
    const salt = await channelSalt(id);
    const base = await crypto.subtle.importKey('raw', TE.encode(pw), 'PBKDF2', false, ['deriveKey']);
    return crypto.subtle.deriveKey(
      { name: 'PBKDF2', salt, iterations: PBKDF2_ITERATIONS, hash: 'SHA-256' },
      base,
      { name: 'AES-GCM', length: 256 },
      false,
      ['encrypt', 'decrypt']
    );
  };

  const encryptText = async (id, pt) => {
    const k = keys.get(id);
    if (!k) return pt;
    const iv = crypto.getRandomValues(new Uint8Array(12));
    const ct = new Uint8Array(await crypto.subtle.encrypt({ name: 'AES-GCM', iv }, k, TE.encode(pt)));
    const packed = new Uint8Array(iv.length + ct.length);
    packed.set(iv, 0);
    packed.set(ct, iv.length);
    return MAGIC + toB64(packed);
  };

  async function tryDecryptAny(ciphertext) {
    if (decryptCache.has(ciphertext)) return decryptCache.get(ciphertext);
    let result = null;
    for (const [, key] of keys) {
      try {
        const raw = fromB64(ciphertext.slice(MAGIC.length));
        const pt = await crypto.subtle.decrypt({ name: 'AES-GCM', iv: raw.subarray(0, 12) }, key, raw.subarray(12));
        result = TD.decode(pt);
        break;
      } catch {}
    }
    decryptCache.set(ciphertext, result);
    return result;
  }

  let scanScheduled = false;
  function scheduleScan() {
    if (scanScheduled) return;
    scanScheduled = true;
    requestAnimationFrame(() => { scanScheduled = false; scan(); });
  }

  async function scan() {
    if (keys.size === 0) return;
    const walker = document.createTreeWalker(document.body, NodeFilter.SHOW_TEXT, {
      acceptNode(node) {
        const p = node.parentElement;
        if (!p) return NodeFilter.FILTER_REJECT;
        if (p.closest('script, style, textarea, noscript, [data-duckey-ignore]')) return NodeFilter.FILTER_REJECT;
        if (!node.nodeValue || node.nodeValue.indexOf(MAGIC) < 0) return NodeFilter.FILTER_REJECT;
        return NodeFilter.FILTER_ACCEPT;
      }
    });
    const hits = [];
    let n;
    while ((n = walker.nextNode())) hits.push(n);
    for (const node of hits) {
      const v = node.nodeValue;
      CIPHER_RE.lastIndex = 0;
      const ciphers = [];
      let m;
      while ((m = CIPHER_RE.exec(v)) !== null) ciphers.push(m[0]);
      if (!ciphers.length) continue;
      let out = v;
      for (const c of ciphers) {
        const plain = await tryDecryptAny(c);
        if (plain !== null && plain !== undefined) out = out.split(c).join(plain);
      }
      if (out !== v) node.nodeValue = out;
    }
  }

  new MutationObserver(() => scheduleScan()).observe(document.body, { childList: true, subtree: true, characterData: true });
  if (document.body) scheduleScan();
  else document.addEventListener('DOMContentLoaded', scheduleScan, { once: true });

  const MESSAGES_RE = /\/channels\/(\d+)\/messages(?:[\/?]|$)/;
  const NativeXHROpen = XMLHttpRequest.prototype.open;
  const NativeXHRSend = XMLHttpRequest.prototype.send;

  XMLHttpRequest.prototype.open = function (method, url, ...rest) {
    this.__dkMethod = String(method).toUpperCase();
    this.__dkUrl = String(url);
    return NativeXHROpen.call(this, method, url, ...rest);
  };

  XMLHttpRequest.prototype.send = function (body) {
    const m = (this.__dkUrl || '').match(MESSAGES_RE);
    const cid = m && m[1];
    const xhr = this;
    if (cid && this.__dkMethod === 'POST' && keys.has(cid) && typeof body === 'string') {
      let parsed;
      try { parsed = JSON.parse(body); } catch {}
      if (parsed && typeof parsed.content === 'string' && parsed.content && !parsed.content.startsWith(MAGIC)) {
        if (URL_ONLY_RE.test(parsed.content.trim())) {
          return NativeXHRSend.call(this, body);
        }
        encryptText(cid, parsed.content)
          .then((cipher) => {
            parsed.content = cipher;
            NativeXHRSend.call(xhr, JSON.stringify(parsed));
          })
          .catch((e) => {
            console.error('[Duckey] encrypt failed', e);
            NativeXHRSend.call(xhr, body);
          });
        return;
      }
    }
    return NativeXHRSend.call(this, body);
  };

  const FONT = 'var(--font-primary, "gg sans", "Noto Sans", sans-serif)';

  function toast(text, ms = 4000) {
    if (!document.body) return;
    const el = document.createElement('div');
    el.setAttribute('data-duckey-ignore', '');
    el.textContent = text;
    el.style.cssText = `position:fixed;bottom:24px;left:50%;transform:translateX(-50%);background:#5865f2;color:#fff;padding:12px 20px;border-radius:8px;font:500 14px/1.4 ${FONT};max-width:80vw;text-align:center;box-shadow:0 8px 24px rgba(0,0,0,.45);z-index:2147483647;pointer-events:none;opacity:0;transition:opacity .25s ease;`;
    document.body.appendChild(el);
    requestAnimationFrame(() => { el.style.opacity = '1'; });
    setTimeout(() => {
      el.style.opacity = '0';
      setTimeout(() => el.remove(), 300);
    }, ms);
  }

  function welcome() {
    if (!document.body || document.getElementById('duckey-welcome')) return;
    const ov = document.createElement('div');
    ov.id = 'duckey-welcome';
    ov.setAttribute('data-duckey-ignore', '');
    ov.style.cssText = `position:fixed;inset:0;z-index:2147483647;background:rgba(0,0,0,.65);display:flex;align-items:center;justify-content:center;font-family:${FONT};`;

    const box = document.createElement('div');
    box.style.cssText = `width:420px;max-width:calc(100vw - 32px);background:#313338;border-radius:12px;padding:28px;box-shadow:0 16px 48px rgba(0,0,0,.6);color:#dbdee1;`;

    const head = document.createElement('div');
    head.style.cssText = 'display:flex;align-items:center;gap:14px;margin-bottom:18px;';
    head.innerHTML = `<div style="font-size:36px;line-height:1">🦆</div><div><div style="font-size:20px;font-weight:700;color:#f2f3f5">Welcome to Duckey</div><div style="font-size:12px;color:#949ba4;margin-top:2px">Version ${VERSION}</div></div>`;

    const body = document.createElement('div');
    body.style.cssText = 'font-size:14px;line-height:1.6;color:#b5bac1;';
    body.innerHTML = `
      <p style="margin:0 0 12px">Duckey encrypts your Discord conversations with AES-256-GCM. Messages you send in an encrypted channel leave your client as ciphertext, and any ciphertext you receive is decrypted on screen automatically.</p>
      <p style="margin:0 0 12px">Right-click a channel or DM and choose <span style="color:#f2f3f5">Encrypt with Duckey</span>, then set a shared password. The person on the other side has to set the exact same password for their channel. The password never leaves your machine.</p>
      <p style="margin:0 0 12px">You can also press <span style="color:#f2f3f5">Ctrl+Shift+E</span> to toggle encryption for the channel you are currently viewing.</p>
      <p style="margin:0">Made by <span style="color:#f2f3f5;font-weight:600">tordev</span>.</p>
    `;

    const row = document.createElement('div');
    row.style.cssText = 'display:flex;justify-content:flex-end;margin-top:22px;';

    const btn = document.createElement('button');
    btn.type = 'button';
    btn.textContent = 'Got it';
    btn.style.cssText = `background:#5865f2;border:none;color:#fff;padding:10px 20px;border-radius:4px;font:600 14px ${FONT};cursor:pointer;`;
    btn.addEventListener('click', () => ov.remove());

    row.appendChild(btn);
    box.appendChild(head);
    box.appendChild(body);
    box.appendChild(row);
    ov.appendChild(box);
    document.body.appendChild(ov);
  }

  function askPassword(title, desc) {
    return new Promise((resolve) => {
      const ov = document.createElement('div');
      ov.setAttribute('data-duckey-ignore', '');
      ov.style.cssText = `position:fixed;inset:0;z-index:2147483647;background:rgba(0,0,0,.7);display:flex;align-items:center;justify-content:center;`;
      const form = document.createElement('form');
      form.style.cssText = `width:380px;max-width:calc(100vw - 32px);background:#313338;border-radius:12px;padding:24px;font-family:${FONT};color:#dbdee1;box-shadow:0 12px 40px rgba(0,0,0,.6);`;
      form.innerHTML = `<div data-r="t" style="font-size:18px;font-weight:700;color:#f2f3f5;margin-bottom:8px"></div><div data-r="d" style="font-size:13px;color:#b5bac1;line-height:1.5;margin-bottom:16px"></div><input type="password" placeholder="Shared password" autocomplete="off" style="width:100%;box-sizing:border-box;background:#1e1f22;border:1px solid #111214;border-radius:4px;padding:10px 12px;color:#f2f3f5;font-size:14px;font-family:inherit;outline:none"><div style="display:flex;justify-content:flex-end;gap:8px;margin-top:20px"><button type="button" data-r="c" style="background:transparent;border:none;color:#dbdee1;padding:9px 16px;border-radius:4px;font:500 14px ${FONT};cursor:pointer">Cancel</button><button type="submit" style="background:#5865f2;border:none;color:#fff;padding:9px 16px;border-radius:4px;font:500 14px ${FONT};cursor:pointer">OK</button></div>`;
      form.querySelector('[data-r="t"]').textContent = title;
      form.querySelector('[data-r="d"]').textContent = desc;
      ov.appendChild(form);
      document.body.appendChild(ov);
      const input = form.querySelector('input');
      let done = false;
      const finish = (v) => {
        if (done) return;
        done = true;
        document.removeEventListener('keydown', onKey, true);
        ov.remove();
        resolve(v);
      };
      function onKey(e) { if (e.key === 'Escape') { e.stopPropagation(); finish(null); } }
      form.querySelector('[data-r="c"]').addEventListener('click', () => finish(null));
      ov.addEventListener('mousedown', (e) => { if (e.target === ov) finish(null); });
      form.addEventListener('submit', (e) => {
        e.preventDefault();
        if (!input.value) { input.focus(); return; }
        finish(input.value);
      });
      document.addEventListener('keydown', onKey, true);
      requestAnimationFrame(() => input.focus());
    });
  }

  async function toggleChannel(cid) {
    if (!cid) { toast('No channel selected.'); return; }
    if (keys.has(cid)) {
      keys.delete(cid);
      encryptedChannels.delete(cid);
      saveChannels();
      decryptCache.clear();
      toast('Encryption disabled for this channel.');
      scheduleScan();
      return;
    }
    const pw = await askPassword(
      'Encrypt this conversation',
      'Enter the shared password. The other person must enter the exact same password on their side.'
    );
    if (!pw) return;
    try {
      keys.set(cid, await deriveKey(pw, cid));
      encryptedChannels.add(cid);
      saveChannels();
      decryptCache.clear();
      toast('Encryption enabled for this channel.');
      scheduleScan();
    } catch (e) {
      console.error('[Duckey]', e);
      toast('Failed to set up encryption.');
    }
  }

  function idFromDataListItemId(v) {
    if (!v) return null;
    for (const p of CHANNEL_PREFIXES) if (v.startsWith(p)) return v.slice(p.length);
    if (v.includes('___')) return v.split('___')[1];
    return null;
  }

  function idFromElement(el) {
    if (!el || !(el instanceof Element)) return null;
    let node = el;
    while (node && node !== document.body) {
      const id = idFromDataListItemId(node.getAttribute && node.getAttribute('data-list-item-id'));
      if (id) return id;
      const a = node.closest && node.closest('a[href^="/channels/"]');
      if (a) {
        const m = a.getAttribute('href').match(/\/channels\/[^/]+\/(\d+)/);
        if (m) return m[1];
      }
      node = node.parentElement;
    }
    return null;
  }

  const idFromUrl = () => (location.pathname.match(/\/channels\/(?:@me|\d+)\/(\d+)/) || [])[1] || null;
  const currentChannelId = idFromUrl;

  function closeMenu() {
    document.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape', code: 'Escape', keyCode: 27, which: 27, bubbles: true }));
    document.dispatchEvent(new KeyboardEvent('keyup', { key: 'Escape', code: 'Escape', keyCode: 27, which: 27, bubbles: true }));
  }

  let pendingId = null;
  let pendingTimer = 0;

  document.addEventListener('contextmenu', (e) => {
    const path = typeof e.composedPath === 'function' ? e.composedPath() : [];
    let found = null;
    for (const n of path) {
      const id = idFromElement(n);
      if (id) { found = id; break; }
    }
    pendingId = found || idFromElement(e.target) || null;
    clearTimeout(pendingTimer);
    if (pendingId) pendingTimer = setTimeout(() => { pendingId = null; }, 1200);
  }, true);

  function fireToggle(cid, item) {
    if (item && item.__duckeyFired) return;
    if (item) item.__duckeyFired = true;
    pendingId = null;
    clearTimeout(pendingTimer);
    closeMenu();
    setTimeout(() => toggleChannel(cid), 0);
  }

  function injectMenuItem(menu, cid) {
    if (menu.querySelector('[data-duckey]')) return;
    if (!CHANNEL_MENU_HINTS.test(menu.textContent || '')) return;

    const template = menu.querySelector('[role="menuitem"]');
    if (!template) return;

    const item = template.cloneNode(true);
    item.setAttribute('data-duckey', 'true');
    item.setAttribute('data-duckey-channel', cid);
    item.removeAttribute('id');
    item.removeAttribute('aria-checked');
    item.style.pointerEvents = 'auto';
    item.style.cursor = 'pointer';

    const icon = item.querySelector('[class*="iconContainer"]');
    if (icon) icon.innerHTML = '';

    item.querySelectorAll('[class*="hintContainer"], [class*="subtext"], [class*="caret"], [class*="badge"]').forEach((n) => n.remove());

    const label = item.querySelector('[class*="label"]');
    const text = keys.has(cid) ? 'Turn off Duckey encryption' : 'Encrypt with Duckey';
    if (label) label.textContent = text;
    else item.textContent = text;

    item.querySelectorAll('*').forEach((el) => { el.style.pointerEvents = 'auto'; });

    item.addEventListener('pointerdown', (ev) => {
      ev.preventDefault();
      ev.stopPropagation();
      ev.stopImmediatePropagation();
      fireToggle(cid, item);
    }, true);

    item.addEventListener('mousedown', (ev) => {
      ev.preventDefault();
      ev.stopPropagation();
      ev.stopImmediatePropagation();
      fireToggle(cid, item);
    }, true);

    const parent = template.parentElement || menu;
    parent.appendChild(item);
  }

  function handleDuckeyClick(ev) {
    const t = ev.target;
    if (!t || !t.closest) return;
    const item = t.closest('[data-duckey]');
    if (!item) return;
    ev.preventDefault();
    ev.stopPropagation();
    ev.stopImmediatePropagation();
    fireToggle(item.getAttribute('data-duckey-channel'), item);
  }

  window.addEventListener('pointerdown', handleDuckeyClick, true);
  window.addEventListener('mousedown', handleDuckeyClick, true);
  window.addEventListener('click', handleDuckeyClick, true);

  new MutationObserver((muts) => {
    if (!pendingId) return;
    for (const m of muts) {
      for (const n of m.addedNodes) {
        if (!(n instanceof Element)) continue;
        const menu = n.matches?.('[role="menu"]') ? n : n.querySelector?.('[role="menu"]');
        if (menu) injectMenuItem(menu, pendingId);
      }
    }
  }).observe(document.body, { childList: true, subtree: true });

  const keyHandler = (e) => {
    if (e.ctrlKey && e.shiftKey && (e.key === 'E' || e.key === 'e')) {
      e.preventDefault();
      e.stopPropagation();
      toggleChannel(currentChannelId());
    }
  };
  document.addEventListener('keydown', keyHandler, true);

  const boot = () => {
    welcome();
    scheduleScan();
  };

  if (document.body) boot();
  else document.addEventListener('DOMContentLoaded', boot, { once: true });

  window.__duckeyOff = function () {
    XMLHttpRequest.prototype.open = NativeXHROpen;
    XMLHttpRequest.prototype.send = NativeXHRSend;
    document.removeEventListener('keydown', keyHandler, true);
    window.removeEventListener('pointerdown', handleDuckeyClick, true);
    window.removeEventListener('mousedown', handleDuckeyClick, true);
    window.removeEventListener('click', handleDuckeyClick, true);
    clearTimeout(pendingTimer);
    document.getElementById('duckey-welcome')?.remove();
    document.querySelectorAll('[data-duckey]').forEach((n) => n.remove());
    keys.clear();
    decryptCache.clear();
    window.__duckeyActive = false;
  };

  window.__duckeyStatus = () => ({
    active: window.__duckeyActive,
    unlocked: [...keys.keys()],
    currentChannel: currentChannelId()
  });

  window.__duckeyRescan = () => {
    decryptCache.clear();
    scheduleScan();
    return 'scan queued';
  };
})();
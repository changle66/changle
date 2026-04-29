// ==UserScript==
// @name         WhatsApp 翻译+发送
// @version      5.5.4
// @description  中文→外语翻译 · 自动发送 · 缓存 · 面板 · 热键 · 收到&发出消息自动翻译(免费API) · 小米MiMo
// @match        https://web.whatsapp.com/*
// @grant        GM_addStyle
// @grant        GM_getValue
// @grant        GM_setValue
// @grant        GM_xmlhttpRequest
// @grant        GM_setClipboard
// @grant        unsafeWindow
// @connect      api.chatanywhere.tech
// @connect      api.chatanywhere.org
// @connect      api.xiaomimimo.com
// @connect      translate.googleapis.com
// @connect      api-edge.cognitive.microsofttranslator.com
// @connect      edge.microsoft.com
// @run-at       document-end
// @noframes
// ==/UserScript==

(() => {
  'use strict';

  const pageWin = (typeof unsafeWindow !== 'undefined') ? unsafeWindow : window;
  const pageDoc = pageWin.document;

  /* ═══ 默认模型（唯一定义） ═══ */
  const DEFAULT_MODEL = 'gpt-4o-mini';

  /* ═══ API 端点 ═══ */
  const API_ENDPOINTS = [
    { label: '国内 (tech)', host: 'api.chatanywhere.tech', url: 'https://api.chatanywhere.tech/v1/chat/completions', desc: '国内使用，延时更低', model: DEFAULT_MODEL },
    { label: '国外 (org)',  host: 'api.chatanywhere.org',  url: 'https://api.chatanywhere.org/v1/chat/completions',  desc: '国外使用', model: DEFAULT_MODEL },
    { label: '小米 MiMo',   host: 'api.xiaomimimo.com',    url: 'https://api.xiaomimimo.com/v1/chat/completions',    desc: '小米 MiMo 接口', model: 'mimo-v2-flash' },
  ];

  const CFG = {
    MODEL: DEFAULT_MODEL,
    TEMP: 0.28,
    MAX_CACHE: 200,
    CACHE_TTL: 30 * 86400_000,
    TIMEOUT: 45_000,
    MAX_RETRIES: 2,
    FREE_TIMEOUT: 10_000,
  };

  /* ═══ UI 布局常量 ═══ */
  const UI = {
    BADGE_SIZE: 22,
    BADGE_OFFSET_X: 77,
    BADGE_OFFSET_Y: 11,
    EDGE_PAD: 6,
    PANEL_PAD: 12,
    PANEL_WIDTH: 400,
  };

  /* ═══ 时序控制 ═══ */
  const TIMING = {
    MOUNT_DEBOUNCE: 120,
    FLUSH_DEBOUNCE: 500,
    SAVE_DEBOUNCE: 400,
    WRITE_DELAY_SHORT: 10,
    WRITE_DELAY_MED: 20,
    WRITE_DELAY_NORM: 30,
    WRITE_DELAY_LONG: 50,
    WRITE_DELAY_VERIFY: 80,
    WRITE_DELAY_PASTE: 100,
    SEND_RETRY: 5,
    SEND_RETRY_DELAY: 120,
    RETRY_BASE_DELAY: 1000,
    INCOMING_SCAN_DEBOUNCE: 500,
    OBSERVER_CHECK_INTERVAL: 3000,
  };

  /* ═══ 语言映射 ═══ */
  const LANG_META = {
    en: { name: 'English', label: '英语', badge: 'EN' },
    de: { name: 'German',  label: '德语', badge: 'DE' },
  };

  /* ═══ Google Translate 语言代码映射 ═══ */
  const LANG_CODE_MAP = {
    'Chinese': 'zh-CN', 'English': 'en', 'German': 'de',
    'French': 'fr', 'Spanish': 'es', 'Japanese': 'ja',
    'Korean': 'ko', 'Russian': 'ru', 'Portuguese': 'pt',
    'Italian': 'it', 'Dutch': 'nl', 'Turkish': 'tr',
    'Thai': 'th', 'Vietnamese': 'vi', 'Indonesian': 'id',
    'Hindi': 'hi', 'Arabic': 'ar', 'Polish': 'pl',
  };

  /* ═══ Bing Translator 语言代码映射 ═══ */
  const BING_LANG_MAP = {
    'Chinese': 'zh-Hans', 'English': 'en', 'German': 'de',
    'French': 'fr', 'Spanish': 'es', 'Japanese': 'ja',
    'Korean': 'ko', 'Russian': 'ru', 'Portuguese': 'pt',
    'Italian': 'it', 'Dutch': 'nl', 'Turkish': 'tr',
    'Thai': 'th', 'Vietnamese': 'vi', 'Indonesian': 'id',
    'Hindi': 'hi', 'Arabic': 'ar', 'Polish': 'pl',
  };

  /* ═══ HTTP 错误映射 ═══ */
  const HTTP_ERROR_MAP = {
    400: '请求格式错误，请检查模型名称',
    401: 'API Key 无效或已过期',
    403: '访问被拒绝，请检查 API Key 权限',
    404: '接口不存在，请检查 API 地址或模型名称',
    429: '请求过于频繁，请稍后再试',
    500: 'API 服务器内部错误，请稍后重试',
    502: 'API 网关错误，服务可能暂时不可用',
    503: 'API 服务暂时不可用，请稍后重试',
  };

  function friendlyHttpError(status, body) {
    const f = HTTP_ERROR_MAP[status];
    if (f) return `${f} (HTTP ${status})`;
    return `HTTP ${status}: ${(body || '').slice(0, 120)}`;
  }

  /* ═══ 工具函数 ═══ */
  const $  = (s, p = document) => p.querySelector(s);
  const $$ = (s, p = document) => [...p.querySelectorAll(s)];
  const sleep = ms => new Promise(r => setTimeout(r, ms));
  const clamp = (v, lo, hi) => Math.max(lo, Math.min(hi, v));
  const norm  = s => String(s ?? '').replace(/[\u00A0\u200B-\u200D\uFEFF]/g, ' ').replace(/\s+/g, ' ').trim();
  const hasCN = s => {
    try { return /\p{Script=Han}/u.test(String(s || '')); }
    catch { return /[\u4E00-\u9FFF]/.test(String(s || '')); }
  };
  const gm = {
    get(k, d) { try { return GM_getValue(k, d) ?? d; } catch { return d; } },
    set(k, v) { try { GM_setValue(k, v); } catch {} },
  };

  function fnv1a(s) {
    let h = 0x811c9dc5;
    for (let i = 0; i < s.length; i++) { h ^= s.charCodeAt(i); h = Math.imul(h, 0x01000193); }
    return (h >>> 0).toString(36);
  }

  function selectAll(ed) {
    const sel = pageWin.getSelection();
    const range = pageDoc.createRange();
    range.selectNodeContents(ed);
    sel.removeAllRanges();
    sel.addRange(range);
    return { sel, range };
  }

  function sanitizeLang(lang) {
    return (lang || 'English').replace(/[^\w\u4e00-\u9fff\s-]/g, '').trim() || 'English';
  }

  function isLikelyError(text) {
    return /request was rejected|considered high risk|content.?policy|moderation|cannot assist|unable to process|error occurred|rate limit|quota exceeded/i.test(text);
  }

  /* ═══ 存储键 ═══ */
  const SK = {
    apiKey: 'wt5_key', model: 'wt5_mdl', autoSend: 'wt5_snd',
    enabled: 'wt5_on', lang: 'wt5_lng', customLang: 'wt5_cl', temp: 'wt5_tmp',
    apiIdx: 'wt5_api', testText: 'wt5_tt',
    autoTranslateIncoming: 'wt5_ati',
    freeEngine: 'wt5_fe',
  };

  /* ═══ 状态 ═══ */
  const state = {
    apiKey:    (gm.get(SK.apiKey, '') || '').toString().trim(),
    model:     (gm.get(SK.model, '') || CFG.MODEL).toString().trim(),
    autoSend:  !!gm.get(SK.autoSend, false),
    enabled:   !!gm.get(SK.enabled, true),
    lang:       gm.get(SK.lang, 'en'),
    customLang:(gm.get(SK.customLang, '') || 'French').toString().trim(),
    temp:       clamp(Number(gm.get(SK.temp, CFG.TEMP)) || CFG.TEMP, 0, 2),
    apiIdx:     clamp(Number(gm.get(SK.apiIdx, 0)) || 0, 0, API_ENDPOINTS.length - 1),
    autoTranslateIncoming: !!gm.get(SK.autoTranslateIncoming, true),
    freeEngine: (gm.get(SK.freeEngine, 'bing') || 'bing').toString(),
    busy: false, _ac: null, _saveTimers: {},

    get apiUrl()   { return API_ENDPOINTS[this.apiIdx].url; },
    get apiHost()  { return API_ENDPOINTS[this.apiIdx].host; },
    get apiLabel() { return API_ENDPOINTS[this.apiIdx].label; },
    get langName() {
      if (this.lang === 'custom') return this.customLang || 'English';
      return LANG_META[this.lang]?.name || 'English';
    },
    get langLabel() {
      if (this.lang === 'custom') return this.customLang || '自定义';
      return LANG_META[this.lang]?.label || '英语';
    },
    get badgeText() {
      if (this.lang === 'custom') return (this.customLang || 'CU').slice(0, 2).toUpperCase();
      return LANG_META[this.lang]?.badge || 'EN';
    },

    save(k) {
      if (!SK[k]) return;
      clearTimeout(this._saveTimers[k]);
      this._saveTimers[k] = setTimeout(() => gm.set(SK[k], this[k]), TIMING.SAVE_DEBOUNCE);
    },
    saveImmediate(k) {
      if (!SK[k]) return;
      clearTimeout(this._saveTimers[k]);
      gm.set(SK[k], this[k]);
    },
    newJob() {
      try { this._ac?.abort(); } catch {}
      this._ac = new AbortController(); this.busy = true;
      return this._ac.signal;
    },
    cancel() { try { this._ac?.abort(); } catch {} this.busy = false; },
    done()   { this.busy = false; this._ac = null; },
  };

  if (!['en', 'de', 'custom'].includes(state.lang)) { state.lang = 'en'; state.saveImmediate('lang'); }

  /* ═══ 缓存（LRU + debounce flush） ═══ */
  const cache = (() => {
    const SKEY = 'wt5_cache';
    let d = gm.get(SKEY, null);
    if (!d?.items || !Array.isArray(d.ord)) d = { items: {}, ord: [] };
    let flushTimer = 0;

    const mk = (src, lang) => fnv1a([src, lang, state.model, state.temp, state.apiHost].join('\0'));
    const flushNow = () => { flushTimer = 0; gm.set(SKEY, d); };
    const flush = () => { if (flushTimer) clearTimeout(flushTimer); flushTimer = setTimeout(flushNow, TIMING.FLUSH_DEBOUNCE); };

    function evict() {
      const t = Date.now();
      d.ord = d.ord.filter(k => {
        if (!d.items[k] || t - d.items[k].t > CFG.CACHE_TTL) { delete d.items[k]; return false; }
        return true;
      });
      while (d.ord.length > CFG.MAX_CACHE) delete d.items[d.ord.shift()];
    }

    return {
      get count() { return d.ord.length; },
      get(src, lang) {
        const e = d.items[mk(src, lang)];
        return e && Date.now() - e.t < CFG.CACHE_TTL ? e.v : null;
      },
      set(src, lang, val) {
        const k = mk(src, lang);
        d.items[k] = { v: val, t: Date.now() };
        d.ord = d.ord.filter(x => x !== k);
        d.ord.push(k);
        evict(); flush();
      },
      clear() {
        d = { items: {}, ord: [] };
        if (flushTimer) { clearTimeout(flushTimer); flushTimer = 0; }
        flushNow();
      },
    };
  })();

  /* ═══ 免费翻译 API（消息翻译专用，不消耗 token） ═══ */

  // ✅ 修复：模板字符串中 ${tl} 原来写成了 {tl}，导致 URL 里目标语言永远是字面量 "{tl}"
  function translateFreeGoogle(text, toLang) {
    const tl = LANG_CODE_MAP[toLang === 'Chinese' ? 'Chinese' : toLang] || 'zh-CN';
    const url = `https://translate.googleapis.com/translate_a/single?client=webapp&sl=auto&tl=${tl}&dt=t&q=${encodeURIComponent(text)}`;

    return new Promise((resolve, reject) => {
      GM_xmlhttpRequest({
        method: 'GET', url, timeout: CFG.FREE_TIMEOUT,
        onload(r) {
          if (r.status !== 200) return reject(new Error('Google HTTP ' + r.status));
          try {
            const data = JSON.parse(r.responseText);
            const translated = data[0].map(seg => seg[0]).join('').trim();
            if (!translated || translated === text) return reject(new Error('Google 返回空或未变化'));
            resolve(translated);
          } catch { reject(new Error('Google 解析失败')); }
        },
        onerror()   { reject(new Error('Google 网络错误')); },
        ontimeout() { reject(new Error('Google 超时')); },
      });
    });
  }

  // ✅ 修复：api-edge.cognitive.microsofttranslator.com 需要先从 edge.microsoft.com/translate/auth
  //         拿到一次性 JWT Bearer token，才能调用翻译接口，否则返回 401
  function translateFreeBing(text, toLang) {
    const to = BING_LANG_MAP[toLang === 'Chinese' ? 'Chinese' : toLang] || 'zh-Hans';
    const AUTH_URL  = 'https://edge.microsoft.com/translate/auth';
    const TRANS_URL = `https://api-edge.cognitive.microsofttranslator.com/translate?api-version=3.0&to=${to}`;

    return new Promise((resolve, reject) => {
      // Step 1: 获取 auth token
      GM_xmlhttpRequest({
        method: 'GET', url: AUTH_URL, timeout: CFG.FREE_TIMEOUT,
        onload(tokenRes) {
          if (tokenRes.status !== 200)
            return reject(new Error('Bing 获取 token 失败 HTTP ' + tokenRes.status));

          const token = tokenRes.responseText?.trim();
          if (!token) return reject(new Error('Bing token 为空'));

          // Step 2: 带 token 请求翻译
          GM_xmlhttpRequest({
            method: 'POST', url: TRANS_URL, timeout: CFG.FREE_TIMEOUT,
            headers: {
              'Content-Type': 'application/json',
              'Authorization': 'Bearer ' + token,
            },
            data: JSON.stringify([{ Text: text }]),
            onload(r) {
              if (r.status !== 200) return reject(new Error('Bing 翻译 HTTP ' + r.status));
              try {
                const data = JSON.parse(r.responseText);
                const translated = data[0]?.translations?.[0]?.text?.trim();
                if (!translated || translated === text)
                  return reject(new Error('Bing 返回空或未变化'));
                resolve(translated);
              } catch { reject(new Error('Bing 解析失败')); }
            },
            onerror()   { reject(new Error('Bing 翻译网络错误')); },
            ontimeout() { reject(new Error('Bing 翻译超时')); },
          });
        },
        onerror()   { reject(new Error('Bing 获取 token 网络错误')); },
        ontimeout() { reject(new Error('Bing 获取 token 超时')); },
      });
    });
  }

  function translateFree(text, toLang) {
    if (state.freeEngine === 'google') return translateFreeGoogle(text, toLang);
    return translateFreeBing(text, toLang);
  }

  /* ═══ API 请求（带内容过滤检测） ═══ */
  function callLLM(messages, signal) {
    return new Promise((resolve, reject) => {
      if (signal?.aborted) return reject(new Error('已取消'));
      let req;
      const onAbort = () => { try { req?.abort(); } catch {} reject(new Error('已取消')); };
      signal?.addEventListener('abort', onAbort, { once: true });
      const cleanup = () => { try { signal?.removeEventListener('abort', onAbort); } catch {} };

      req = GM_xmlhttpRequest({
        method: 'POST', url: state.apiUrl, timeout: CFG.TIMEOUT,
        headers: { 'Content-Type': 'application/json', Authorization: 'Bearer ' + state.apiKey },
        data: JSON.stringify({ model: state.model, temperature: state.temp, messages }),
        onload(r) {
          cleanup();
          const body = r.responseText || '';

          if (r.status < 200 || r.status >= 300) {
            if (/high.?risk|moderation|content.?policy|safety/i.test(body))
              return reject(Object.assign(new Error('内容被安全过滤拦截'), { code: 'CF' }));
            return reject(new Error(friendlyHttpError(r.status, body)));
          }

          if (/text\/html/i.test(r.responseHeaders || ''))
            return reject(new Error('API 返回了 HTML 页面，请检查地址是否正确或被 Cloudflare 拦截'));

          try {
            const json = JSON.parse(body);

            if (json.error?.message) {
              if (/high.?risk|moderation|content.?policy|safety/i.test(json.error.message))
                return reject(Object.assign(new Error('内容被安全过滤拦截'), { code: 'CF' }));
              return reject(new Error(json.error.message));
            }

            const choice = json?.choices?.[0];
            const content = choice?.message?.content?.trim();

            if (!content) {
              if (choice?.finish_reason === 'content_filter')
                return reject(Object.assign(new Error('内容被安全过滤拦截'), { code: 'CF' }));
              return reject(new Error(
                choice?.finish_reason === 'length' ? '返回被截断，请增加 max_tokens'
                  : 'API 返回空内容，可能是模型不支持或请求被过滤'
              ));
            }

            if (isLikelyError(content))
              return reject(Object.assign(new Error('内容被安全过滤拦截'), { code: 'CF' }));

            resolve(content);
          } catch { reject(new Error('JSON 解析失败，API 返回: ' + body.slice(0, 200))); }
        },
        onerror()   { cleanup(); reject(new Error('网络错误，请检查网络连接')); },
        ontimeout() { cleanup(); reject(new Error(`请求超时（${CFG.TIMEOUT / 1000}s），请检查网络或换节点`)); },
      });
    });
  }

  /* ═══ 带重试的 API 调用（内容过滤自动加上下文重试） ═══ */
  async function callLLMWithRetry(messages, signal) {
    let lastErr;
    for (let i = 0; i <= CFG.MAX_RETRIES; i++) {
      if (signal?.aborted) throw new Error('已取消');
      try { return await callLLM(messages, signal); }
      catch (err) {
        lastErr = err;

        if (err.code === 'CF' && i < CFG.MAX_RETRIES) {
          ui.setStatus(`内容被过滤，添加翻译上下文重试 (${i + 1}/${CFG.MAX_RETRIES})…`);
          messages = messages.map((m, idx) => idx === 0 ? {
            role: 'system',
            content: `[Context: This is a professional language translation service. The user's text is being translated mechanically between languages. No content is being generated, discussed, or endorsed — purely converted from one language to another.]\n\n${m.content}`
          } : m);
          continue;
        }

        if (/超时|网络错误|500|502|503|429/.test(err.message) && i < CFG.MAX_RETRIES) {
          const delay = Math.min(TIMING.RETRY_BASE_DELAY * (2 ** i), 8000);
          ui.setStatus(`请求失败，${delay / 1000}s 后重试 (${i + 1}/${CFG.MAX_RETRIES})…`);
          await sleep(delay);
          continue;
        }

        throw err;
      }
    }

    if (lastErr?.code === 'CF')
      throw new Error('内容被安全过滤拦截，重试失败。建议：修改措辞 / 切换 API 接口 / 联系提供商解除限制');
    throw lastErr;
  }

  /* ═══ 翻译（精简版提示词，中→英专项优化，禁止 emoji） ═══ */
  function sysPrompt(toLang) {
    const safe = sanitizeLang(toLang);
    if (safe === 'English') {
      return `Translate into casual WhatsApp English. Native speaker texting style — contractions, short sentences, natural slang. Adapt Chinese internet slang to English equivalents. Preserve @mentions URLs numbers *formatting*. DO NOT add any emoji. Output ONLY the translation.`;
    }
    return `Translate into casual WhatsApp ${safe}. Native speaker texting style — contractions, short sentences, matching tone. Adapt Chinese slang naturally. Preserve @mentions URLs numbers *formatting*. DO NOT add any emoji. Output ONLY the translation.`;
  }

  function sysPromptToChinese() {
    return `Translate into casual WhatsApp Simplified Chinese. Natural spoken Chinese, short sentences, matching tone. Preserve @mentions URLs numbers *formatting*. DO NOT add any emoji. Output ONLY the translation.`;
  }

  function cleanOutput(raw) {
    let t = raw.trim();
    t = t.replace(/^```[\w]*\n?([\s\S]*?)\n?```$/, '$1').trim();
    for (const [l, r] of [['"', '"'], ['\u201C', '\u201D'], ['\u00AB', '\u00BB']]) {
      if (t.startsWith(l) && t.endsWith(r) && t.length > 2) { t = t.slice(l.length, -r.length).trim(); break; }
    }
    t = t.replace(/^(Translation|翻译|译文)\s*[:：]\s*/i, '');
    t = t.replace(/^Here\s+(is|'s)\s+the\s+translation\s*[:：\-]?\s*/i, '');
    const m = t.match(/^([\s\S]+?)\n{2,}(解释|说明|Note|Explanation)\s*[:：]/i);
    if (m?.[1]) t = m[1].trim();
    t = t.replace(/^\n+/, '');
    if (t.length > 0) t = t.charAt(0).toUpperCase() + t.slice(1);
    return t.trim();
  }

  async function translate(src, toLang, signal) {
    const text = norm(src);
    if (!text) return { text: '', cached: false };
    const hit = cache.get(text, toLang);
    if (hit !== null) return { text: hit, cached: true };
    if (!navigator.onLine) throw new Error('当前无网络连接');
    if (signal?.aborted) throw new Error('已取消');

    const prompt = toLang === 'Chinese' ? sysPromptToChinese() : sysPrompt(toLang);
    const raw = await callLLMWithRetry([
      { role: 'system', content: prompt },
      { role: 'user', content: text },
    ], signal);
    if (!raw) throw new Error('返回空文本');
    if (signal?.aborted) throw new Error('已取消');

    const out = cleanOutput(raw);
    cache.set(text, toLang, out);
    return { text: out, cached: false };
  }

  /* ═══ 输入框操作 ═══ */
  const composer = {
    find() {
      return $('footer [contenteditable="true"][role="textbox"]') || $('footer [contenteditable="true"]');
    },
    _verify(text) {
      const ed = this.find();
      if (!ed) return false;
      const tc = norm(ed.textContent || ''), it = norm(ed.innerText || ''), exp = norm(text);
      if (!exp) return false;
      if (tc === exp || it === exp) return true;
      const s = exp.slice(0, 50);
      if (tc.includes(s) || it.includes(s)) return true;
      if (s.length > 20 && tc.slice(0, 50).includes(s.slice(0, 20))) return true;
      return false;
    },
    async write(text) {
      const ed = this.find();
      if (!ed) return false;
      ed.focus(); await sleep(TIMING.WRITE_DELAY_NORM);

      try {
        selectAll(ed); await sleep(TIMING.WRITE_DELAY_MED);
        pageDoc.execCommand('delete', false, null); await sleep(TIMING.WRITE_DELAY_SHORT);
        pageDoc.execCommand('insertText', false, text); await sleep(TIMING.WRITE_DELAY_VERIFY);
        if (this._verify(text)) { console.info('[WA-TR] write OK via execCommand'); return true; }
      } catch (e) { console.warn('[WA-TR] execCommand failed:', e); }

      try {
        ed.focus(); selectAll(ed); await sleep(TIMING.WRITE_DELAY_SHORT);
        const dt = new pageWin.DataTransfer(); dt.setData('text/plain', text);
        ed.dispatchEvent(new pageWin.ClipboardEvent('paste', { bubbles: true, cancelable: true, clipboardData: dt }));
        await sleep(TIMING.WRITE_DELAY_PASTE);
        if (this._verify(text)) { console.info('[WA-TR] write OK via page ClipboardEvent'); return true; }
      } catch (e) { console.warn('[WA-TR] page ClipboardEvent failed:', e); }

      try {
        while (ed.firstChild) ed.removeChild(ed.firstChild);
        const p = pageDoc.createElement('p'), span = pageDoc.createElement('span');
        span.textContent = text; p.appendChild(span); ed.appendChild(p);
        ed.dispatchEvent(new pageWin.Event('input', { bubbles: true }));
        await sleep(TIMING.WRITE_DELAY_LONG);
        ed.dispatchEvent(new pageWin.Event('change', { bubbles: true }));
        await sleep(TIMING.WRITE_DELAY_PASTE);
        if (this._verify(text)) { console.info('[WA-TR] write OK via DOM manipulation'); return true; }
      } catch (e) { console.warn('[WA-TR] DOM write failed:', e); }

      try {
        ed.focus(); selectAll(ed);
        const dt2 = new DataTransfer(); dt2.setData('text/plain', text);
        ed.dispatchEvent(new ClipboardEvent('paste', { bubbles: true, cancelable: true, clipboardData: dt2 }));
        ed.dispatchEvent(new InputEvent('input', { bubbles: true, inputType: 'insertFromPaste', data: text }));
        await sleep(TIMING.WRITE_DELAY_PASTE);
        if (this._verify(text)) { console.info('[WA-TR] write OK via sandbox ClipboardEvent'); return true; }
      } catch (e) { console.warn('[WA-TR] sandbox ClipboardEvent failed:', e); }

      console.warn('[WA-TR] all write methods failed, copying to clipboard');
      try {
        if (typeof GM_setClipboard === 'function') GM_setClipboard(text, 'text');
        else if (navigator.clipboard?.writeText) await navigator.clipboard.writeText(text);
      } catch (e) { console.warn('[WA-TR] clipboard copy also failed:', e); }
      return false;
    },
    async send() {
      for (let i = 0; i < TIMING.SEND_RETRY; i++) {
        const btn = this.find()?.closest('footer')?.querySelector('span[data-icon*="send"]')?.closest('button,[role="button"]');
        if (btn) { btn.click(); return true; }
        await sleep(TIMING.SEND_RETRY_DELAY);
      }
      return false;
    },
  };

  /* ═══ Enter 决策 ═══ */
  function decideAction(draft, ctrl, alt) {
    if (hasCN(draft)) {
      if (ctrl) return null;
      if (alt) return { toLang: state.langName, noSend: true };
      return { toLang: state.langName, noSend: false };
    }
    if (ctrl) return { toLang: 'Chinese', noSend: true };
    if (alt)  return { err: 'Alt+Enter 用于翻译中文，当前内容不含中文' };
    return null;
  }

  async function handleEnter(e) {
    if (e.key !== 'Enter' || !e.isTrusted || !state.enabled) return;
    if (e.shiftKey || e.isComposing || e.keyCode === 229) return;
    const ed = composer.find();
    if (!ed || !(e.target === ed || ed.contains(e.target))) return;

    if (state.busy) { e.preventDefault(); e.stopImmediatePropagation(); ui.setStatus('翻译中…按 ESC 取消'); return; }

    const draft = norm(ed.innerText);
    if (!draft) return;

    const action = decideAction(draft, !!(e.ctrlKey || e.metaKey), !!e.altKey);
    if (!action) return;

    e.preventDefault(); e.stopImmediatePropagation();
    if (action.err) { ui.setStatus(action.err); return; }
    if (!state.apiKey) { ui.setStatus('未设置 API Key，请按 Alt+W 打开面板设置'); return; }

    const signal = state.newJob();
    ui.updateBadge('busy');

    try {
      const r = await translate(draft, action.toLang, signal);
      const ok = await composer.write(r.text);
      ui.setStatus(`→ ${action.toLang} ${r.cached ? '(缓存)' : '(实时)'} [${state.apiHost}]${ok ? '' : '  写入失败，已复制到剪贴板，请手动粘贴'}`);

      if (state.autoSend && !action.noSend) {
        if (!ok) { ui.setStatus('写入失败，不自动发送，译文已复制到剪贴板'); return; }
        if (!r.text.trim()) { ui.setStatus('译文为空，不发送'); return; }
        if (isLikelyError(r.text)) { ui.setStatus('译文疑似 API 错误信息，不发送'); return; }
        const cnTarget = action.toLang === 'Chinese' || (state.lang === 'custom' && /^(zh|chinese|中文)/i.test(state.customLang));
        if (!cnTarget && hasCN(r.text)) { ui.setStatus('译文仍含中文，疑似翻译失败，不发送'); return; }
        if (r.text.length > draft.length * 5 + 80) { ui.setStatus('译文异常偏长，不发送'); return; }
        ui.setStatus(await composer.send() ? '已发送' : '未找到发送按钮，请手动点击发送');
      }
    } catch (err) { ui.setStatus(/已取消/.test(err.message) ? '已取消' : err.message); }
    finally { state.done(); ui.updateBadge(); }
  }

  /* ═══ 热键 ═══ */
  function handleHotkey(e) {
    if (e.key === 'Escape') {
      if (ui.panelOpen) { e.preventDefault(); ui.toggle(); return; }
      if (state.busy)   { e.preventDefault(); state.cancel(); ui.setStatus('已取消'); ui.updateBadge(); return; }
      return;
    }
    if (!e.altKey || e.ctrlKey || e.metaKey || e.shiftKey) return;
    const k = e.key.toLowerCase();
    if (k === 'w') { e.preventDefault(); ui.toggle(); }
    else if (k === 'c') {
      e.preventDefault(); state.autoSend = !state.autoSend; state.saveImmediate('autoSend');
      ui.updateBadge(); ui.setStatus('自动发送: ' + (state.autoSend ? '开' : '关'));
    } else if (k === 's') {
      e.preventDefault(); state.enabled = !state.enabled; state.saveImmediate('enabled');
      ui.updateBadge(); ui.setStatus(state.enabled ? '已启用' : '已关闭');
    } else if (k === 'x') {
      e.preventDefault();
      const ls = state.customLang ? ['en', 'de', 'custom'] : ['en', 'de'];
      state.lang = ls[(ls.indexOf(state.lang) + 1) % ls.length]; state.saveImmediate('lang');
      ui.updateBadge(); ui.setStatus('目标: ' + state.langLabel);
    } else if (k === 't') {
      e.preventDefault();
      state.autoTranslateIncoming = !state.autoTranslateIncoming;
      state.saveImmediate('autoTranslateIncoming');
      if (!state.autoTranslateIncoming) msgQueue.length = 0;
      const atBtn = pageDoc.querySelector('#wt-at');
      if (atBtn) atBtn.textContent = '消息自动翻译: ' + (state.autoTranslateIncoming ? '开' : '关');
      ui.updateBadge(); ui.setStatus('消息翻译: ' + (state.autoTranslateIncoming ? '开' : '关'));
    }
  }

  /* ═══ 消息自动翻译（收到+发出，仅免费 API） ═══ */
  const msgQueue = [];
  let msgProcessing = false;
  let msgObs = null;
  let msgObsTarget = null;

  function ensureMsgObserver() {
    if (!state.enabled || !state.autoTranslateIncoming) return;
    const target = pageDoc.querySelector('#main [role="application"]') || pageDoc.querySelector('#main');
    if (!target) return;
    if (msgObsTarget === target && target.isConnected) return;
    msgObs?.disconnect();
    msgObsTarget = target;
    msgObs = new MutationObserver(() => scanMessages());
    msgObs.observe(target, { childList: true, subtree: true });
    clearMsgMarks();
    scanMessages();
  }

  function clearMsgMarks() {
    try { pageDoc.querySelectorAll('[data-wt-tr]').forEach(el => delete el.dataset.wtTr); } catch (e) {}
  }

  /* 参数化选择器，同时扫描收到和发出的消息 */
  function findTextElements(container, msgClass) {
    const results = [];
    const seen = new Set();

    try {
      container.querySelectorAll(msgClass + ' .copyable-text').forEach(el => {
        const row = el.closest('[role="row"]') || el.closest(msgClass) || el.parentElement;
        if (row && !seen.has(row)) { seen.add(row); results.push({ row, textEl: el }); }
      });
    } catch (e) {}

    if (results.length === 0) {
      try {
        container.querySelectorAll('[role="row"]').forEach(row => {
          if (seen.has(row) || !row.querySelector(msgClass)) return;
          const textEl = row.querySelector('.copyable-text') || row.querySelector('[data-pre-plain-text]');
          if (textEl) { seen.add(row); results.push({ row, textEl }); }
        });
      } catch (e) {}
    }

    if (results.length === 0) {
      try {
        container.querySelectorAll(msgClass).forEach(el => {
          if (seen.has(el)) return;
          const textEl = el.querySelector('[data-pre-plain-text]') || el;
          if (norm(textEl.innerText).length >= 2) { seen.add(el); results.push({ row: el, textEl }); }
        });
      } catch (e) {}
    }

    return results;
  }

  function doScanMessages() {
    if (!state.enabled || !state.autoTranslateIncoming) return;
    const mainEl = pageDoc.querySelector('#main');
    if (!mainEl) return;

    /* 同时扫描收到(.message-in)和发出(.message-out)的消息 */
    const textEls = [
      ...findTextElements(mainEl, '.message-in'),
      ...findTextElements(mainEl, '.message-out'),
    ];

    for (const { row, textEl } of textEls) {
      if (row.dataset.wtTr) continue;
      const text = norm(textEl.innerText || '');
      if (!text || text.length < 2 || hasCN(text)) { row.dataset.wtTr = 'skip'; continue; }
      const bubble = textEl.closest('.message-in, .message-out') || textEl.parentElement;
      if (bubble?.parentElement?.querySelector('.wt-tr-result')) { row.dataset.wtTr = 'done'; continue; }
      row.dataset.wtTr = 'queued';
      msgQueue.push({ row, textEl, text });
    }
    processMsgQueue();
  }

  let msgScanTimer = 0;
  function scanMessages() {
    if (msgScanTimer) return;
    msgScanTimer = setTimeout(() => {
      msgScanTimer = 0;
      try { doScanMessages(); } catch (e) { console.warn('[WA-TR] scan error:', e); }
    }, TIMING.INCOMING_SCAN_DEBOUNCE);
  }

  async function processMsgQueue() {
    if (msgProcessing || msgQueue.length === 0) return;
    msgProcessing = true;

    while (msgQueue.length > 0) {
      const item = msgQueue.shift();
      if (!item.row.isConnected) { item.row.dataset.wtTr = 'skip'; continue; }

      const cached = cache.get(item.text, 'Chinese');
      const bubble = item.textEl.closest('.message-in, .message-out') || item.textEl.parentElement;
      if (!bubble?.isConnected) { item.row.dataset.wtTr = 'skip'; continue; }

      if (cached !== null) {
        const div = pageDoc.createElement('div');
        div.className = 'wt-tr-result';
        div.textContent = cached;
        bubble.after(div);
        item.row.dataset.wtTr = 'done';
        continue;
      }

      const loadingDiv = pageDoc.createElement('div');
      loadingDiv.className = 'wt-tr-result wt-tr-loading';
      loadingDiv.textContent = '翻译中…';
      bubble.after(loadingDiv);

      let translated = null;

      // 仅使用免费 API（不消耗 token）
      try {
        translated = await translateFree(item.text, 'Chinese');
      } catch (freeErr) {
        console.warn('[WA-TR] free API failed:', freeErr.message);
      }

      if (loadingDiv.isConnected) {
        if (translated) {
          loadingDiv.textContent = translated;
          loadingDiv.classList.remove('wt-tr-loading');
          cache.set(item.text, 'Chinese', translated);
        } else {
          loadingDiv.textContent = '翻译失败';
          loadingDiv.classList.add('wt-tr-error');
          loadingDiv.classList.remove('wt-tr-loading');
          setTimeout(() => { if (loadingDiv.isConnected) loadingDiv.remove(); }, 3000);
        }
      }
      item.row.dataset.wtTr = translated ? 'done' : 'error';
    }

    msgProcessing = false;
  }

  /* ═══ UI ═══ */
  const ui = (() => {
    GM_addStyle(`
:root{--wt-bg:#fff;--wt-fg:#1a1a1a;--wt-dim:#666;--wt-bd:rgba(0,0,0,.12);--wt-sf:rgba(0,0,0,.05);--wt-sh:0 12px 28px rgba(0,0,0,.15);--wt-ac:#2563eb;--wt-f:system-ui,-apple-system,sans-serif;--wt-m:ui-monospace,SFMono-Regular,Menlo,monospace}
@media(prefers-color-scheme:dark){:root{--wt-bg:#1e1e1e;--wt-fg:#e8e8e8;--wt-dim:#aaa;--wt-bd:rgba(255,255,255,.1);--wt-sf:rgba(255,255,255,.06);--wt-sh:0 14px 32px rgba(0,0,0,.5);--wt-ac:#3b82f6}}
#wt-b{position:fixed;width:${UI.BADGE_SIZE}px;height:${UI.BADGE_SIZE}px;display:none;align-items:center;justify-content:center;border-radius:50%;color:#fff;font:800 10px/1 var(--wt-f);cursor:default;user-select:none;pointer-events:none;z-index:999999;transition:filter .12s}
#wt-b.on{display:flex}
#wt-b[data-l=en]{background:#2563eb}
#wt-b[data-l=de]{background:linear-gradient(#000 33%,#d00 33% 66%,#fc0 66%)}
#wt-b[data-l=custom]{background:#7c3aed}
#wt-b[data-off]{filter:grayscale(1) brightness(.7);opacity:.5}
#wt-b::before{content:"";position:absolute;inset:-3px;border-radius:50%;border:2px solid transparent;transition:border-color .15s}
#wt-b[data-r=g]::before{border-color:#22c55e}
#wt-b[data-r=r]::before{border-color:#ef4444}
#wt-b[data-r=p]::before{border-color:#ec4899}
#wt-b[data-r=x]::before{border-color:#9ca3af}
#wt-k{position:fixed;inset:0;background:rgba(0,0,0,.08);z-index:999998;display:none}
#wt-k.on{display:block}
#wt-p{position:fixed;width:min(${UI.PANEL_WIDTH}px,calc(100vw - 24px));z-index:999999;display:none;background:var(--wt-bg);color:var(--wt-fg);border:1px solid var(--wt-bd);box-shadow:var(--wt-sh);border-radius:12px;font:13px/1.45 var(--wt-f);overflow:hidden}
#wt-p.on{display:block}
.wt-inner{padding:14px;max-height:min(640px,calc(100vh - 24px));overflow:auto}
.wt-hd{font-weight:650;font-size:14px;display:flex;justify-content:space-between;align-items:center;padding-bottom:10px;margin-bottom:10px;border-bottom:1px solid var(--wt-bd);cursor:move;user-select:none}
.wt-hd span{font-size:11px;color:var(--wt-dim);background:var(--wt-sf);padding:2px 8px;border-radius:99px}
#wt-p label{display:block;margin:10px 0 3px;font-weight:600;font-size:12px}
#wt-p label small{color:var(--wt-dim);font-weight:400}
#wt-p select,#wt-p input[type=text],#wt-p input[type=password],#wt-p input[type=number]{width:100%;box-sizing:border-box;padding:8px 10px;border:1px solid var(--wt-bd);border-radius:10px;outline:none;background:transparent;color:var(--wt-fg);font:13px var(--wt-f)}
#wt-p select:focus,#wt-p input:focus{border-color:var(--wt-ac);box-shadow:0 0 0 3px rgba(37,99,235,.2)}
.wt-row{display:flex;gap:8px;margin-top:14px}
#wt-p button{flex:1;padding:8px 14px;border:none;border-radius:10px;cursor:pointer;font:600 13px var(--wt-f);transition:filter .1s}
#wt-p button:hover{filter:brightness(1.05)}
.wt-bp{background:var(--wt-ac);color:#fff}
.wt-dg{background:#ef4444;color:#fff}
.wt-sf{background:var(--wt-sf);color:var(--wt-fg);border:1px solid var(--wt-bd)!important}
.wt-box{margin-top:10px;padding:8px 10px;font:12px/1.4 var(--wt-m);color:var(--wt-dim);background:var(--wt-sf);border:1px solid var(--wt-bd);border-radius:10px;white-space:pre-wrap;word-break:break-all}
.wt-api-sw{display:flex;gap:4px;margin-top:6px}
.wt-api-btn{flex:1;padding:6px 8px;border:1px solid var(--wt-bd);border-radius:8px;cursor:pointer;font:500 11px var(--wt-f);text-align:center;transition:all .15s;background:transparent;color:var(--wt-dim)}
.wt-api-btn:hover{background:var(--wt-sf)}
.wt-api-btn.wt-api-on{border-color:var(--wt-ac);color:var(--wt-ac);background:rgba(37,99,235,.1)}
.wt-hint{font-size:11px;color:var(--wt-dim);margin-top:3px;line-height:1.3}
.wt-cl-wrap{display:none;margin-top:6px}
.wt-cl-wrap.on{display:block}
.wt-tr-result{padding:6px 10px;margin:4px 0 0;background:rgba(37,99,235,.06);border-radius:8px;font:12px/1.4 var(--wt-f);color:var(--wt-ac);max-width:80%;word-break:break-word}
.wt-tr-loading{opacity:.5;font-style:italic}
.wt-tr-error{color:#ef4444!important;background:rgba(239,68,68,.06)!important}
`);

    const badge = document.createElement('div'); badge.id = 'wt-b';
    const mask  = document.createElement('div'); mask.id  = 'wt-k';
    const panel = document.createElement('div'); panel.id = 'wt-p';

    const apiBtnsHtml = API_ENDPOINTS.map((ep, i) =>
      `<button class="wt-api-btn${i === state.apiIdx ? ' wt-api-on' : ''}" data-idx="${i}" title="${ep.desc}">${ep.label}</button>`
    ).join('');

    panel.innerHTML = `<div class="wt-inner">
<div class="wt-hd" id="wt-hd"><b>WA 翻译助手</b><span>v5.5</span></div>
<label>API 接口</label>
<div class="wt-api-sw" id="wt-api-sw">${apiBtnsHtml}</div>
<label>目标语言 <small>(Alt+X 切换)</small></label>
<select id="wt-sl">
  <option value="en">英语 English</option>
  <option value="de">德语 German</option>
  <option value="custom">自定义…</option>
</select>
<div class="wt-cl-wrap" id="wt-cl-wrap">
  <input id="wt-cl" type="text" placeholder="如 French / Spanish / Japanese">
  <div class="wt-hint">输入目标语言的英文名称</div>
</div>
<label>温度 <small>(0~2, 越低越保守)</small></label>
<input id="wt-st" type="number" min="0" max="2" step="0.01">
<label>模型</label>
<input id="wt-sm" type="text" placeholder="${DEFAULT_MODEL}">
<label>API Key</label>
<input id="wt-sk" type="password" placeholder="sk-...">
<div class="wt-hint">Key 以明文存储在浏览器本地，请勿在公用电脑上使用</div>
<label>消息翻译 <small>(收到+发出，免费不消耗 token)</small></label>
<select id="wt-fe">
  <option value="bing">Bing Translator</option>
  <option value="google">Google Translate</option>
</select>
<div class="wt-row"><button class="wt-sf" id="wt-at">消息自动翻译: 开</button></div>
<label>测试文本</label>
<input id="wt-ti" type="text" placeholder="输入要测试翻译的文本…">
<div class="wt-row">
  <button class="wt-bp" id="wt-bt">测试翻译</button>
  <button class="wt-dg" id="wt-bc">清空缓存</button>
</div>
<div class="wt-row">
  <button class="wt-sf" id="wt-be">导出设置</button>
  <button class="wt-sf" id="wt-bi">导入设置</button>
</div>
<div class="wt-box" id="wt-si"></div>
<div class="wt-box" id="wt-ss" style="margin-top:6px"></div>
</div>`;
    document.documentElement.append(badge, mask, panel);

    const el = {
      lang: $('#wt-sl'), temp: $('#wt-st'), model: $('#wt-sm'),
      key: $('#wt-sk'), info: $('#wt-si'), status: $('#wt-ss'),
      testInput: $('#wt-ti'), clWrap: $('#wt-cl-wrap'), clInput: $('#wt-cl'),
      atBtn: $('#wt-at'), fe: $('#wt-fe'),
    };

    el.lang.value = state.lang; el.temp.value = state.temp;
    el.model.value = state.model; el.key.value = state.apiKey;
    el.testInput.value = gm.get(SK.testText, '你好，我在路上，等下聊');
    el.clWrap.classList.toggle('on', state.lang === 'custom');
    el.clInput.value = state.customLang;
    el.atBtn.textContent = '消息自动翻译: ' + (state.autoTranslateIncoming ? '开' : '关');
    el.fe.value = state.freeEngine;

    /* --- 事件绑定 --- */

    $('#wt-api-sw').addEventListener('click', (e) => {
      const btn = e.target.closest('.wt-api-btn'); if (!btn) return;
      const idx = Number(btn.dataset.idx);
      state.apiIdx = idx; state.saveImmediate('apiIdx');
      const epModel = API_ENDPOINTS[idx].model;
      if (epModel && epModel !== state.model) {
        state.model = epModel; state.saveImmediate('model');
        el.model.value = state.model;
      }
      $$('.wt-api-btn').forEach((b, i) => b.classList.toggle('wt-api-on', i === idx));
      refreshInfo(); setStatus('API: ' + state.apiLabel + ' (' + state.apiHost + ') | 模型: ' + state.model);
    });

    el.lang.addEventListener('change', () => {
      el.clWrap.classList.toggle('on', el.lang.value === 'custom');
      state.lang = el.lang.value; state.saveImmediate('lang');
      updateBadge(); setStatus('目标: ' + state.langLabel);
    });

    el.clInput.addEventListener('input', () => {
      state.customLang = el.clInput.value.trim(); state.save('customLang'); updateBadge();
    });

    el.temp.addEventListener('change', () => {
      const n = Number(el.temp.value);
      if (!Number.isFinite(n)) { el.temp.value = state.temp; return; }
      state.temp = clamp(n, 0, 2); state.save('temp');
      el.temp.value = state.temp; refreshInfo();
    });

    el.model.addEventListener('change', () => {
      state.model = el.model.value.trim() || CFG.MODEL; state.save('model');
      el.model.value = state.model; refreshInfo();
    });

    el.key.addEventListener('input', () => {
      state.apiKey = el.key.value.trim(); state.save('apiKey'); refreshInfo();
    });

    el.testInput.addEventListener('change', () => gm.set(SK.testText, el.testInput.value));

    el.fe.addEventListener('change', () => {
      state.freeEngine = el.fe.value; state.saveImmediate('freeEngine');
      setStatus('免费翻译引擎: ' + (state.freeEngine === 'google' ? 'Google Translate' : 'Bing Translator'));
    });

    el.atBtn.addEventListener('click', () => {
      state.autoTranslateIncoming = !state.autoTranslateIncoming;
      state.saveImmediate('autoTranslateIncoming');
      if (!state.autoTranslateIncoming) msgQueue.length = 0;
      el.atBtn.textContent = '消息自动翻译: ' + (state.autoTranslateIncoming ? '开' : '关');
      setStatus('消息翻译: ' + (state.autoTranslateIncoming ? '开' : '关'));
    });

    $('#wt-bt').addEventListener('click', async () => {
      const src = el.testInput.value.trim() || '你好，我在路上';
      setStatus(`测试中… [${state.apiHost}]`);
      const sig = state.newJob(); updateBadge('busy');
      try {
        const r = await translate(src, state.langName, sig);
        setStatus(`结果: ${r.text}${r.cached ? ' (缓存)' : ''} [${state.apiHost}]`);
      } catch (e) { setStatus(e.message); }
      finally { state.done(); updateBadge(); }
    });

    $('#wt-bc').addEventListener('click', () => { cache.clear(); refreshInfo(); setStatus('缓存已清空'); });

    $('#wt-be').addEventListener('click', () => {
      const data = {};
      for (const v of Object.values(SK)) data[v] = gm.get(v);
      const json = JSON.stringify(data, null, 2);
      try {
        if (typeof GM_setClipboard === 'function') { GM_setClipboard(json, 'text'); setStatus('设置已复制到剪贴板'); }
        else {
          const a = pageDoc.createElement('a');
          a.href = URL.createObjectURL(new Blob([json], { type: 'application/json' }));
          a.download = 'wa-translator-settings.json'; a.click(); URL.revokeObjectURL(a.href);
          setStatus('设置已导出为文件');
        }
      } catch (e) { setStatus('导出失败: ' + e.message); }
    });

    $('#wt-bi').addEventListener('click', async () => {
      try {
        let json;
        if (navigator.clipboard?.readText) json = await navigator.clipboard.readText();
        else json = prompt('粘贴设置 JSON:');
        if (!json?.trim()) return;
        const data = JSON.parse(json);
        for (const [k, v] of Object.entries(data)) gm.set(k, v);
        setStatus('设置已导入，刷新页面生效');
      } catch (e) { setStatus('导入失败: ' + e.message); }
    });

    /* --- 面板拖拽 --- */
    (() => {
      const handle = $('#wt-hd');
      let dx, dy, dragging = false;
      handle.addEventListener('mousedown', (e) => {
        if (e.target.closest('button, input, select')) return;
        dragging = true;
        const r = panel.getBoundingClientRect();
        dx = e.clientX - r.left; dy = e.clientY - r.top; e.preventDefault();
      });
      document.addEventListener('mousemove', (e) => {
        if (!dragging) return;
        panel.style.left = clamp(e.clientX - dx, UI.PANEL_PAD, innerWidth - UI.PANEL_WIDTH - UI.PANEL_PAD) + 'px';
        panel.style.top  = clamp(e.clientY - dy, UI.PANEL_PAD, innerHeight - 300) + 'px';
      });
      document.addEventListener('mouseup', () => { dragging = false; });
    })();

    /* --- 内部函数 --- */
    function setStatus(s) { el.status.textContent = s || ''; }

    function refreshInfo() {
      const keyDisp = state.apiKey ? state.apiKey.slice(0, 6) + '…' : '未设置';
      const freeName = state.freeEngine === 'google' ? 'Google' : 'Bing';
      el.info.textContent = [
        `状态: ${state.enabled ? '启用' : '关闭'}  |  自动发送: ${state.autoSend ? '开' : '关'}  |  消息翻译: ${state.autoTranslateIncoming ? freeName : '关'}  |  缓存: ${cache.count} 条`,
        `API: ${state.apiLabel}  (${state.apiHost})`,
        `模型: ${state.model}  |  温度: ${state.temp}  |  目标: ${state.langLabel}`,
        `Key: ${keyDisp}`,
      ].join('\n');
    }

    function updateBadge(mode = 'idle') {
      badge.dataset.l = state.lang;
      badge.textContent = state.badgeText;
      if (!state.enabled) { badge.dataset.off = ''; badge.dataset.r = 'x'; }
      else { delete badge.dataset.off; badge.dataset.r = mode === 'busy' ? 'p' : state.autoSend ? 'g' : 'r'; }
      badge.title = [
        `${state.langLabel} | ${state.enabled ? '启用' : '关闭'} | 发送:${state.autoSend ? '开' : '关'} | 消息翻译:${state.autoTranslateIncoming ? '开' : '关'} | API:${state.apiHost}`,
        'Alt+W 面板  Alt+S 启停  Alt+C 发送  Alt+T 消息翻译  Alt+X 语言',
        'Ctrl+Enter→中文  |  Alt+Enter 只翻译',
      ].join('\n');
      mount(); refreshInfo();
    }

    function mount() {
      const ed = composer.find();
      if (!ed) { badge.classList.remove('on'); return; }
      const r = ed.getBoundingClientRect();
      badge.style.left = clamp(Math.round(r.left - UI.BADGE_OFFSET_X), UI.EDGE_PAD, innerWidth - UI.BADGE_SIZE * 2 - UI.EDGE_PAD) + 'px';
      badge.style.top  = clamp(Math.round(r.top + r.height / 2 - UI.BADGE_OFFSET_Y), UI.EDGE_PAD, innerHeight - UI.BADGE_SIZE - UI.EDGE_PAD) + 'px';
      badge.classList.add('on');
    }

    function center() {
      panel.style.cssText = 'display:block;visibility:hidden';
      const r = panel.getBoundingClientRect();
      panel.style.left = clamp((innerWidth - r.width) / 2, UI.PANEL_PAD, innerWidth - r.width - UI.PANEL_PAD) + 'px';
      panel.style.top  = clamp((innerHeight - r.height) / 2, UI.PANEL_PAD, innerHeight - r.height - UI.PANEL_PAD) + 'px';
      panel.style.visibility = '';
    }

    function toggle() {
      const opening = !panel.classList.contains('on');
      panel.classList.toggle('on', opening);
      mask.classList.toggle('on', opening);
      if (opening) {
        center();
        el.lang.value = state.lang; el.temp.value = state.temp;
        el.model.value = state.model; el.key.value = state.apiKey;
        el.clWrap.classList.toggle('on', state.lang === 'custom');
        el.clInput.value = state.customLang;
        el.atBtn.textContent = '消息自动翻译: ' + (state.autoTranslateIncoming ? '开' : '关');
        el.fe.value = state.freeEngine;
        $$('.wt-api-btn').forEach((b, i) => b.classList.toggle('wt-api-on', i === state.apiIdx));
        refreshInfo();
      } else { panel.style.display = 'none'; }
    }

    mask.addEventListener('click', toggle);

    let tid = 0;
    function sched() {
      if (tid) return;
      tid = setTimeout(() => { tid = 0; if (document.visibilityState === 'visible') mount(); }, TIMING.MOUNT_DEBOUNCE);
    }

    return {
      setStatus, updateBadge, toggle, sched, mount, refreshInfo,
      get panelOpen() { return panel.classList.contains('on'); },
    };
  })();

  /* ═══ 初始化 & 事件注册 ═══ */
  window.addEventListener('keydown', handleHotkey, true);
  window.addEventListener('keydown', handleEnter, true);
  window.addEventListener('focusin', () => ui.sched(), true);
  window.addEventListener('resize', () => ui.sched());

  let footerObs = null;
  const watchFooter = () => {
    const f = $('footer');
    if (!f) return false;
    footerObs?.disconnect();
    footerObs = new MutationObserver(() => ui.sched());
    footerObs.observe(f, { childList: true, subtree: true, attributes: false, characterData: false });
    ui.sched();
    return true;
  };
  if (!watchFooter()) {
    const obs = new MutationObserver(() => { if (watchFooter()) obs.disconnect(); });
    obs.observe(document.body, { childList: true, subtree: true });
  }

  /* 消息翻译 — 三层保障确保切换聊天后立即恢复 */
  (function initMsgTranslation() {
    ensureMsgObserver();

    const mainEl = pageDoc.querySelector('#main');
    if (mainEl) {
      new MutationObserver(() => ensureMsgObserver()).observe(mainEl, { childList: true });
    }

    document.addEventListener('visibilitychange', () => {
      if (document.visibilityState === 'visible') ensureMsgObserver();
    });

    setInterval(() => {
      if (state.enabled && state.autoTranslateIncoming) ensureMsgObserver();
    }, TIMING.OBSERVER_CHECK_INTERVAL);
  })();

  ui.setStatus('就绪');
  ui.updateBadge();
  console.info('[WA-TR] v5.5.4 loaded');
})();
(function () {
  'use strict';
  const X = window.XHGCS;
  const state = X.state;
  const $ = (s) => document.querySelector(s);

  // 「+」里索引的是仓库里的 Skill：xhgcs 讲数据链路怎么调，xhgcs-view 讲视图插件怎么画。
  // 这里只插入一句「按哪个技能做」，不把整篇 SKILL.md 塞进上下文——那有几 KB，
  // 每轮都带上会把 token 吃光；细节交给系统提示与 MCP 工具去取。
  const SKILLS = [
    { id: 'xhgcs', name: 'GCS 数据链路', desc: '通道 / 脚本 / 引擎 / MCP 的调用规范', prompt: '按 xhgcs 技能分析当前数据链：' },
    { id: 'xhgcs-view', name: '可视化视图插件', desc: '按 GCS 画风生成左侧可视化视图', prompt: '按 xhgcs-view 技能生成一个可视化视图：' }
  ];
  // 原来平铺在输入框上方的那排按钮，收进「+」里；快捷指令和技能放在同一个菜单的不同分组
  const QUICK = [
    { dialog: 'visual', name: '画一个视图', desc: '用构图板加一句话生成可运行视图' },
    { dialog: 'script', name: '生成脚本', desc: '先选输入通道，再写清要算什么' },
    { cmd: '生成一个计算均值并显示频谱的节点画布', name: '生成画布', desc: '节点式分析流程' },
    { cmd: '生成一个 JSON 数据引擎', name: '生成引擎', desc: '通讯协议与帧格式配置' },
    { cmd: '当前数据状态', name: '数据状态', desc: '让 AI 读一遍当前链路' },
    { cmd: '运行分析', name: '运行分析', desc: '跑一遍已挂载的脚本' }
  ];
  let activeSkill = null;

  function isDirectViewRequest(prompt, skill) {
    if (skill === 'xhgcs-view') return true;
    const ai = window.XHGCS_AI;
    return Boolean(ai && ai.classifyViewPrompt && ai.classifyViewPrompt(prompt).direct);
  }

  let loading = false;
  let statusTimer = 0;
  let streamBox = null;
  let streamText = '';
  let lastPaintStreamAt = 0;

  function sourceLabel(msg) {
    const meta = msg && msg.meta || {};
    if (meta.streaming) return (meta.model || '本地模型') + ' 生成中…';
    if (meta.error) return '生成失败';
    if (meta.source === 'remote') return (meta.model || '本地模型') + ' · ' + new Date(msg.time || Date.now()).toLocaleTimeString('zh-CN', { hour12: false });
    if (msg && msg.role === 'user') return '用户 · ' + new Date(msg.time || Date.now()).toLocaleTimeString('zh-CN', { hour12: false });
    return '内置 AI · ' + new Date(msg.time || Date.now()).toLocaleTimeString('zh-CN', { hour12: false });
  }

  // ---- 回复的富文本渲染 ----
  // 原来一律 item.textContent = 正文，于是生成的脚本、公式、JSON 全糊成一整块纯文本：
  // 代码块、列表、标题都看不出来，而这个助手最常产出的恰恰就是代码和结构化说明。
  // 这里做一个极小的 markdown 子集：代码块 / 行内代码 / 加粗 / 标题 / 列表 / 空行分段。
  // 全部用 createElement + textContent 组装，不拼 HTML 字符串 —— 既没有注入面，
  // 也满足「不引入第三方前端依赖」的约定。
  function appendInline(host, raw) {
    String(raw == null ? '' : raw).split(/(`[^`\n]+`|\*\*[^*\n]+\*\*)/g).forEach((part) => {
      if (!part) return;
      const isCode = part.length > 2 && part.charAt(0) === '`' && part.charAt(part.length - 1) === '`';
      const isBold = part.length > 4 && part.slice(0, 2) === '**' && part.slice(-2) === '**';
      if (isCode) {
        const el = document.createElement('code');
        el.className = 'ai-inline-code';
        el.textContent = part.slice(1, -1);
        host.appendChild(el);
      } else if (isBold) {
        const el = document.createElement('strong');
        el.textContent = part.slice(2, -2);
        host.appendChild(el);
      } else {
        host.appendChild(document.createTextNode(part));
      }
    });
  }

  // 复制失败不能静默：按钮自己给出结果，用户不必猜有没有复制上
  function copyText(value, button) {
    const done = (ok) => {
      if (!button) return;
      const old = button.textContent;
      button.textContent = ok ? '已复制' : '复制失败';
      setTimeout(() => { button.textContent = old; }, 1200);
    };
    const fallback = () => {
      try {
        const ta = document.createElement('textarea');
        ta.value = value;
        ta.setAttribute('readonly', '');
        ta.style.position = 'fixed';
        ta.style.opacity = '0';
        document.body.appendChild(ta);
        ta.select();
        const ok = document.execCommand('copy');
        document.body.removeChild(ta);
        done(ok);
      } catch (err) { done(false); }
    };
    if (navigator.clipboard && navigator.clipboard.writeText) {
      navigator.clipboard.writeText(value).then(() => done(true), fallback);
    } else fallback();
  }

  function codeBlock(code, lang) {
    const wrap = document.createElement('div');
    wrap.className = 'ai-code';
    const head = document.createElement('div');
    head.className = 'ai-code-head';
    const label = document.createElement('span');
    label.className = 'ai-code-lang';
    label.textContent = lang || '代码';
    const copy = document.createElement('button');
    copy.type = 'button';
    copy.className = 'ai-code-copy';
    copy.textContent = '复制';
    copy.addEventListener('click', () => copyText(code, copy));
    head.appendChild(label);
    head.appendChild(copy);
    const pre = document.createElement('pre');
    const body = document.createElement('code');
    body.textContent = code;
    pre.appendChild(body);
    wrap.appendChild(head);
    wrap.appendChild(pre);
    return wrap;
  }

  function renderRich(host, text) {
    const lines = String(text == null ? '' : text).replace(/\r\n?/g, '\n').split('\n');
    let list = null;
    let para = null;
    for (let i = 0; i < lines.length; i += 1) {
      const line = lines[i];
      const fence = line.match(/^\s{0,3}```\s*([\w+#.-]*)\s*$/);
      if (fence) {
        list = null;
        para = null;
        const body = [];
        i += 1;
        while (i < lines.length && !/^\s{0,3}```\s*$/.test(lines[i])) { body.push(lines[i]); i += 1; }
        host.appendChild(codeBlock(body.join('\n'), fence[1]));
        continue;
      }
      const heading = line.match(/^(#{1,4})\s+(.+)$/);
      if (heading) {
        list = null;
        para = null;
        const el = document.createElement('div');
        el.className = 'ai-md-h';
        appendInline(el, heading[2]);
        host.appendChild(el);
        continue;
      }
      const bullet = line.match(/^\s*[-*+]\s+(.+)$/);
      const ordered = line.match(/^\s*\d+[.)]\s+(.+)$/);
      if (bullet || ordered) {
        para = null;
        const tag = ordered ? 'ol' : 'ul';
        if (!list || list.tagName.toLowerCase() !== tag) {
          list = document.createElement(tag);
          list.className = 'ai-md-list';
          host.appendChild(list);
        }
        const li = document.createElement('li');
        appendInline(li, (bullet || ordered)[1]);
        list.appendChild(li);
        continue;
      }
      if (!line.trim()) { list = null; para = null; continue; }
      list = null;
      if (!para) {
        para = document.createElement('div');
        para.className = 'ai-md-p';
        host.appendChild(para);
      }
      if (para.childNodes.length) para.appendChild(document.createElement('br'));
      appendInline(para, line);
    }
  }

  // 把正文和「最近 N 轮串口帧」拆开渲染：正文走富文本，原始帧默认折叠
  // （内置状态回复会把十帧 JSON 原样附在结尾，铺开有上千像素高）
  function fillMessage(item, msg) {
    const text = String(msg.content || (msg.meta && msg.meta.streaming ? 'AI 正在思考…' : ''));
    if (!text.trim()) { item.textContent = '（模型没有返回内容）'; return; }
    const idx = text.search(/最近\s*\d+\s*轮串口帧/);
    const head = idx < 0 ? text : text.slice(0, idx).replace(/\n+$/, '');
    const rest = idx < 0 ? '' : text.slice(idx);
    const cut = rest.indexOf('\n');
    const frames = cut < 0 ? '' : rest.slice(cut + 1).trim();
    const body = frames ? head : text;
    // 用户消息就是他自己敲的那句话，纯文本最忠实；助手回复里有代码和列表，按 markdown 渲染
    if (msg.role === 'user') item.textContent = body;
    else renderRich(item, body);
    if (!frames) return;
    const det = document.createElement('details');
    det.className = 'ai-frames';
    const sum = document.createElement('summary');
    sum.textContent = '串口上下文 ' + frames.split('\n').filter(Boolean).length + ' 帧';
    const pre = document.createElement('pre');
    pre.textContent = frames;
    det.appendChild(sum);
    det.appendChild(pre);
    item.appendChild(det);
  }

  // 失败/空返回不再往气泡里铺原始报错，压成一条安静的提示 + 重试
  function humanizeError(raw) {
    const text = String(raw || '').trim();
    if (!text) return '';
    if (/已停止/.test(text)) return '';
    if (/ECONNREFUSED|fetch failed|Failed to fetch|ERR_|无法连接|network/i.test(text)) {
      const host = text.match(/(\d{1,3}(?:\.\d{1,3}){3}(?::\d+)?)/);
      return '无法连接本地模型' + (host ? '（' + host[1] + '）' : '');
    }
    if (/HTTP 404|not found/i.test(text)) return '接口返回 404，请检查 Endpoint 与模型名';
    if (/HTTP 401|unauthorized|invalid api key/i.test(text)) return '鉴权失败，请检查 API Key';
    // 额度与限流原来没映射，用户看到的是截断的原始 JSON。这两类必须分开说：
    // 一个是「充值/换模型」，一个是「等几秒重试」，处理方式完全不同
    if (/HTTP 402|insufficient|quota|余额|额度不足|欠费/i.test(text)) return '模型额度不足或已欠费，请充值或换一个模型';
    if (/HTTP 429|rate limit|too many requests|限流|请求过于频繁/i.test(text)) return '请求过于频繁（被限流），等几秒再试';
    if (/HTTP 5\d\d|bad gateway|服务不可用/i.test(text)) return '模型服务暂时不可用，稍后重试';
    if (/abort|timeout|超时|ETIMEDOUT/i.test(text)) return '请求超时，已中断';
    return text.length > 160 ? text.slice(0, 160) + '…' : text;
  }

  function hasEarlierUser(list, index) {
    for (let i = index - 1; i >= 0; i -= 1) if (list[i] && list[i].role === 'user') return true;
    return false;
  }

  function renderNotice(item, msg, index) {
    const m = msg.meta || {};
    const stopped = /已停止/.test(String(m.error || ''));
    const failed = Boolean(m.error) && !stopped;
    item.className = 'ai-msg notice' + (failed ? ' error' : '');
    // 流式失败时前面已经生成的内容不能丢，放在提示行上方
    const body = String(msg.content || '').trim();
    if (body) {
      item.className += ' has-content';
      const content = document.createElement('div');
      content.className = 'ai-notice-content';
      content.textContent = body;
      item.appendChild(content);
    }
    const head = document.createElement('div');
    head.className = 'ai-notice-head';
    const dot = document.createElement('span');
    dot.className = 'ai-notice-dot';
    const title = document.createElement('span');
    title.className = 'ai-notice-title';
    title.textContent = stopped ? '已停止生成' : failed ? '生成失败' : '模型没有返回内容';
    head.appendChild(dot);
    head.appendChild(title);
    item.appendChild(head);
    const detail = failed ? humanizeError(m.error) : '';
    if (detail) {
      const el = document.createElement('div');
      el.className = 'ai-notice-detail';
      el.textContent = detail;
      item.appendChild(el);
    }
    const foot = document.createElement('span');
    foot.className = 'meta';
    foot.textContent = (m.model ? shortModel(m.model) + ' · ' : '') + new Date(msg.time || Date.now()).toLocaleTimeString('zh-CN', { hour12: false });
    if (index > 0 && hasEarlierUser(state.ai.messages, index)) {
      const retry = document.createElement('button');
      retry.type = 'button';
      retry.className = 'ai-notice-retry';
      retry.setAttribute('data-ai-retry', '1');
      retry.textContent = '重试';
      foot.appendChild(document.createTextNode(' · '));
      foot.appendChild(retry);
    }
    item.appendChild(foot);
  }

  function pendingButton(label, attr, messageId, variant) {
    const btn = document.createElement('button');
    btn.type = 'button';
    btn.className = 'ai-pending-btn' + (variant ? ' ' + variant : '');
    btn.textContent = label;
    btn.setAttribute(attr, messageId);
    return btn;
  }

  // 动作确认卡：模型想在回复里创建脚本 / 视图 / 引擎时，不再到达即落库。
  // 卡片把「它会做什么」和校验结果摊开，等用户点「应用」；校验没过的那条直接在这里说明原因。
  function renderPendingCard(item, msg) {
    const pending = (msg.meta && msg.meta.pending) || [];
    if (!pending.length) return;
    const box = document.createElement('div');
    box.className = 'ai-pending';
    pending.forEach((entry) => {
      const status = entry.status || 'pending';
      const row = document.createElement('div');
      // 校验没过的那行在还没点应用时就要标出来 —— 卡片的全部意义就是让用户一眼看出
      // 哪条能成、哪条不能，不能等到点了应用才变红。
      const classes = ['ai-pending-row'];
      if (status !== 'pending') classes.push(status);
      if (!(entry.preview && entry.preview.ok)) classes.push('failed');
      row.className = classes.filter((name, i) => classes.indexOf(name) === i).join(' ');
      const title = document.createElement('div');
      title.className = 'ai-pending-title';
      title.textContent = (entry.preview && entry.preview.title) || '动作';
      row.appendChild(title);
      const detail = document.createElement('div');
      detail.className = 'ai-pending-detail';
      detail.textContent = entry.preview && entry.preview.ok
        ? [entry.preview.detail, entry.preview.extra].filter(Boolean).join(' · ')
        : ((entry.preview && entry.preview.error) || '未通过校验');
      row.appendChild(detail);
      if (status !== 'pending') {
        const result = document.createElement('div');
        result.className = 'ai-pending-result';
        result.textContent = status === 'applied'
          ? '已应用：' + (entry.result || '')
          : status === 'failed' ? '未执行：' + (entry.result || '') : '已丢弃';
        row.appendChild(result);
      }
      box.appendChild(row);
    });
    if (pending.some((entry) => (entry.status || 'pending') === 'pending')) {
      const bar = document.createElement('div');
      bar.className = 'ai-pending-bar';
      bar.appendChild(pendingButton('应用', 'data-ai-apply', msg.id, 'primary'));
      bar.appendChild(pendingButton('丢弃', 'data-ai-discard', msg.id, ''));
      bar.appendChild(pendingButton('本次会话总是允许', 'data-ai-allow', msg.id, 'ghost'));
      box.appendChild(bar);
    }
    item.appendChild(box);
  }

  function renderViewResult(item, msg) {
    const result = msg && msg.meta && msg.meta.viewResult;
    if (!result || !result.id) return;
    const card = document.createElement('div');
    card.className = 'ai-view-result';
    const head = document.createElement('div');
    head.className = 'ai-view-result-head';
    const title = document.createElement('b');
    title.textContent = result.verified ? '可视化已就绪并通过自检' : '可视化已生成';
    head.appendChild(title);
    const open = document.createElement('button');
    open.type = 'button';
    open.className = 'btn small';
    open.setAttribute('data-open-view', result.id);
    open.textContent = '打开视图';
    head.appendChild(open);
    card.appendChild(head);
    const detail = document.createElement('div');
    detail.className = 'ai-view-result-detail';
    detail.textContent = (result.name || '自定义视图') + (result.source === 'local-blueprint' ? ' · 本地构图编译器' : ' · AI 构图');
    card.appendChild(detail);
    item.appendChild(card);
  }

  // 重试：把失败提示连同它前面的提问一起摘掉再发一次，避免气泡越堆越多
  function retryLast() {
    const list = state.ai.messages || [];
    let idx = -1;
    for (let i = list.length - 1; i >= 0; i -= 1) if (list[i] && list[i].role === 'user') { idx = i; break; }
    if (idx < 0) return;
    const prompt = String(list[idx].content || '').trim();
    if (!prompt) return;
    list.splice(idx, list.length - idx);
    if (X.persist) X.persist();
    send(prompt);
  }

  // 数据链计数：空状态里那行「5 通道 · 3 脚本通道 …」和状态条共用，别处都看不到这四个数
  function chainFacts() {
    // 计数为 0 的项整条略掉：摆一个「0 脚本通道」什么也没说（和子任务角标一个口径）
    const parts = [];
    const push = (count, label) => { if (count > 0) parts.push(count + ' ' + label); };
    push((state.channels || []).length, '通道');
    push((state.scriptChannels || []).length, '脚本通道');
    push((state.engines || []).length, '数据引擎');
    push((state.components || []).length, '组件');
    return parts.join(' · ');
  }

  function renderMessages() {
    const box = $('#aiMessages');
    box.innerHTML = '';
    streamBox = null;
    if (!state.ai.messages.length) {
      // 空状态原来把「可生成脚本、画布或数据引擎」说了一遍，而下面五个建议按钮正是这几个动作，重复；
      // 只留一句说明数据链可用，剩下的交给按钮
      // 但只留一句话时这块 400px+ 高的区域几乎全空：再补一行数据链计数（通道 / 脚本通道 / 引擎 / 组件），
      // 这四个数在别处都看不到，正好告诉用户 AI 现在能看到什么。
      const facts = chainFacts();
      box.innerHTML = '<div class="ai-empty">'
        + (facts ? '<span class="ai-empty-facts">' + X.esc(facts) + '</span>' : '')
        + "<div class=\"ai-quick-grid\" role=\"group\" aria-label=\"快捷动作\"><button type=\"button\" aria-label=\"总结当前数据\"><span class=\"aq-ico\">∑</span><span>总结数据</span></button><button type=\"button\" aria-label=\"解释波形\"><span class=\"aq-ico\">∿</span><span>解释波形</span></button><button type=\"button\" aria-label=\"排查串口\"><span class=\"aq-ico\">⌁</span><span>排查串口</span></button><button type=\"button\" aria-label=\"分析告警\"><span class=\"aq-ico\">△</span><span>分析告警</span></button><button type=\"button\" aria-label=\"生成视图\"><span class=\"aq-ico\">◫</span><span>生成视图</span></button><button type=\"button\" aria-label=\"写个脚本\"><span class=\"aq-ico\">⌘</span><span>写个脚本</span></button></div>"
        + '<button type="button" class="btn small" data-ai-paint>✎ 画一个视图</button></div>';
      return;
    }
    state.ai.messages.forEach((msg, index) => {
      const item = document.createElement('div');
      const info = msg.meta || {};
      const isNotice = msg.role !== 'user' && !info.streaming && (info.error || !String(msg.content || '').trim());
      if (isNotice) {
        renderNotice(item, msg, index);
        box.appendChild(item);
        return;
      }
      item.className = 'ai-msg ' + X.esc(msg.role || 'assistant') + (info.streaming ? ' ai-streaming' : '');
      fillMessage(item, msg);
      if (msg.role !== 'user') renderPendingCard(item, msg);
      if (msg.role !== 'user') renderViewResult(item, msg);
      const meta = document.createElement('span');
      meta.className = 'meta';
      meta.appendChild(document.createTextNode(sourceLabel(msg)));
      // 最后一条助手回复才给「重新生成」：不满意就重跑同一个提问，不用再打一遍。
      // 复用 data-ai-retry（走既有的 retryLast），不新增一套重发逻辑。
      if (!loading && !info.streaming && msg.role !== 'user' && index === state.ai.messages.length - 1) {
        const again = document.createElement('button');
        again.type = 'button';
        again.className = 'ai-again';
        again.textContent = '重新生成';
        again.title = '丢掉这条回复，用同一个提问重新问一次';
        again.setAttribute('data-ai-retry', '1');
        meta.appendChild(again);
      }
      item.appendChild(meta);
      box.appendChild(item);
    });
    box.scrollTop = box.scrollHeight;
  }

  function ensureStreamBox() {
    if (streamBox && streamBox.parentNode) return streamBox;
    streamBox = document.createElement('div');
    streamBox.className = 'ai-msg assistant ai-streaming';
    streamBox.textContent = 'AI 正在思考…';
    $('#aiMessages').appendChild(streamBox);
    return streamBox;
  }

  // 只有用户本来就贴着底部时才自动跟随：原来每来一个 delta 就无条件
  // scrollTop = scrollHeight，往回翻看长回答时会被反复拽走。
  function pinnedToBottom(box) {
    return box.scrollHeight - box.scrollTop - box.clientHeight < 48;
  }

  function paintStream() {
    const box = ensureStreamBox();
    box.textContent = '';
    renderRich(box, streamText || 'AI 正在思考…');
  }

  function appendStream(delta, kind) {
    const box = $('#aiMessages');
    if (!box) return;
    const pinned = pinnedToBottom(box);
    if (kind === 'reasoning') {
      // 推理片段不铺进正文：正文位置留给最终回答，思考状态由标题行表达
      ensureStreamBox();
      updateStatus();
      return;
    }
    if (!delta) return;
    streamText += delta;
    const now = performance.now();
    // 富文本要重建整段 DOM，按 delta 的频率来会卡，节流到 ~150ms 一次；
    // 首字仍然立刻可见（lastPaintStreamAt 在 send() 里归零）
    if (now - lastPaintStreamAt >= 150) {
      paintStream();
      lastPaintStreamAt = now;
    }
    if (pinned) box.scrollTop = box.scrollHeight;
  }

  function setLoading(value) {
    loading = Boolean(value);
    const btn = $('#btnAiSend');
    if (btn) {
      // 一个按钮两种角色：发送（↑）与停止（■）原地切换，不再并排两个键
      btn.classList.toggle('stopping', loading);
      btn.title = loading ? '停止生成' : '发送（Enter）';
      btn.setAttribute('aria-label', loading ? '停止生成' : '发送');
    }
    syncModelChip();
    if (loading) {
      ensureStreamBox();
      $('#aiMessages').scrollTop = $('#aiMessages').scrollHeight;
    } else if (streamBox && !loading) {
      renderMessages();
    }
  }

  function statusText() {
    // DSH 后端没有 endpoint/model，别让它显示成「未配置」（那是"没接 API"的意思，会误导）
    const dsh = state.ai.backend === 'dsh';
    if (state.ai.streaming) {
      const base = dsh ? 'DSH 生成中' : '生成中 · ' + shortModel(state.ai.lastModel || state.ai.model);
      // 模型正在查数据时把工具名亮出来：用户能看见「它在干活」，而不是停在「思考中」。
      return state.ai.lastTool ? base + ' · ' + state.ai.lastTool : base;
    }
    if (state.ai.lastError && (dsh || state.ai.endpoint)) return dsh ? 'DSH 失败' : 'API 失败';
    if (dsh) return 'DSH Agent · ' + shortModel(state.ai.dshProfile || 'headless');
    if (state.ai.endpoint && state.ai.model) return 'API · ' + shortModel(state.ai.model);
    if (state.ai.endpoint) return '未选择模型';
    return '未配置 API';
  }

  function shortModel(value) {
    const model = String(value || '');
    if (!model) return '未设置';
    if (model.length < 22) return model;
    return model.slice(0, 20) + '…';
  }

  function updateStatus() {
    const el = $('#aiStatus');
    if (!el) return;
    el.textContent = statusText();
    const online = state.ai.backend === 'dsh' ? !state.ai.lastError : Boolean(state.ai.endpoint);
    el.className = 'ai-status' + (state.ai.streaming ? ' streaming' : (online && state.ai.lastError) ? ' error' : online ? ' online' : '');
    syncModelChip();
    const taskCount = (state.ai.tasks || []).length;
    // 0 条子任务时那个「0」什么也没说，整枚数字收起来，按钮留着当入口
    const taskEl = $('#aiTaskCount');
    if (taskEl) {
      taskEl.textContent = String(taskCount);
      taskEl.classList.toggle('hidden', !taskCount);
    }
    // 上下文占用：字符 / 预算（例 5.6k/24k），按预算截断时带标记。唯一来源是 XHGCS_AI.contextUsage()
    const usageEl = $('#aiCtxUsage');
    if (usageEl) {
      const AI = window.XHGCS_AI;
      const usage = AI && typeof AI.contextUsage === 'function' ? AI.contextUsage() : null;
      if (usage && (usage.chars || usage.turns)) {
        const fmt = (n) => (n >= 1000 ? (Math.round(n / 100) / 10).toFixed(1).replace(/\.0$/, '') + 'k' : String(n));
        usageEl.textContent = fmt(usage.chars) + '/' + fmt(usage.budget) + (usage.trimmed ? ' 剪' : '');
        usageEl.classList.toggle('trimmed', Boolean(usage.trimmed));
        usageEl.classList.remove('hidden');
        usageEl.title = '上下文 ' + usage.chars + ' 字符 ≈ ' + usage.estTokens + ' tokens / 预算 ' + usage.budget + ' 字符'
          + (usage.trimmed ? '（已按预算截断）' : '');
      } else {
        usageEl.textContent = '';
        usageEl.classList.add('hidden');
      }
    }
    // 空状态的计数跟着状态条刷新：脚本 / 引擎 / 组件都可能在使用中增减
    const factsEl = $('#aiMessages .ai-empty-facts');
    if (factsEl) {
      const facts = chainFacts();
      factsEl.textContent = facts;
      factsEl.classList.toggle('hidden', !facts);
    }
    el.title = '上下文 ' + state.ai.contextFrames + ' 帧 · 脚本 ' + state.scriptChannels.length + ' 通道 · 引擎 ' + (state.engines.length || 0) + ' 个 · 子任务 ' + taskCount + ' 条 · ' + (state.ai.lastError || '状态正常');
    updateDataStrip();
  }

  // AI 列顶部数据条：只读 state，不新增定时器/事件/网络
  function updateDataStrip() {
    const framesEl = document.getElementById('aiStripFrames');
    if (!framesEl) return;
    const X = window.XHGCS;
    const st = X && X.state ? X.state : state;
    framesEl.textContent = String((st.serial && st.serial.frames) || 0);
    const chans = X && typeof X.activeChannels === 'function' ? X.activeChannels() : (st.channels || []);
    const channelsEl = document.getElementById('aiStripChannels');
    if (channelsEl) channelsEl.textContent = String(Array.isArray(chans) ? chans.length : 0);
    const rateEl = document.getElementById('aiStripRate');
    if (rateEl) {
      if (st.simulation && st.simulation.enabled) rateEl.textContent = Math.round(1000 / Math.max(1, Number(st.intervalMs) || 100)) + ' Hz';
      else rateEl.textContent = Number(st.serial && st.serial.rate) > 0 ? st.serial.rate + ' Hz' : '—';
    }
    const recEl = document.getElementById('aiStripRecord');
    if (recEl) recEl.textContent = window.XHGCS_RECORDER && window.XHGCS_RECORDER.recording ? '录' : '关';
  }

  function startAutoRefresh() {
    clearInterval(statusTimer);
    statusTimer = setInterval(() => {
      if ($('#aiAutoRefresh') && $('#aiAutoRefresh').checked) updateStatus();
      if ($('#aiAutoRefresh') && $('#aiAutoRefresh').checked && state.mcp.enabled && window.XHGCS_BRIDGE) window.XHGCS_BRIDGE.pushNow();
    }, 2500);
  }

  async function send(text) {
    const prompt = String(text || $('#aiInput').value || '').trim();
    if (!prompt || loading) return;
    const skill = activeSkill;
    $('#aiInput').value = '';
    autoGrow();
    setActiveSkill(null);
    streamText = '';
    lastPaintStreamAt = 0;
    state.ai.lastTool = '';
    renderMessages();
    setLoading(true);
    let directAssistant = null;
    try {
      if (isDirectViewRequest(prompt, skill) && window.XHGCS_AI.composeView) {
        X.addAiMessage('user', prompt);
        directAssistant = X.addAiMessage('assistant', '正在读取构图、生成视图并做真挂载自检…', {
          source: 'local',
          model: '构图编译器',
          streaming: true
        });
        const intent = window.XHGCS_AI.classifyViewPrompt(prompt);
        const result = await window.XHGCS_AI.composeView(prompt, { localFirst: intent.localFirst });
        if (!result || !result.def) throw new Error('视图生成完成，但没有得到可启用的视图');
        state.ai.lastError = '';
        state.ai.lastOk = Date.now();
        const verify = result.verify;
        const summary = verify && window.XHGCS_VIEW_VERIFY
          ? window.XHGCS_VIEW_VERIFY.summarize(verify)
          : '未执行真挂载自检';
        const content = result.message + '\n\n自检：' + summary;
        const meta = {
          source: result.source === 'local-blueprint' ? 'local' : 'remote',
          model: result.source === 'local-blueprint' ? '本地构图编译器' : (state.ai.lastModel || state.ai.model),
          streaming: false,
          viewResult: {
            id: result.def.id,
            name: result.def.name,
            source: result.source,
            verified: Boolean(verify && verify.ok)
          }
        };
        X.updateAiMessage(directAssistant.id, { content: content, meta: meta });
        if (window.XHGCS_LAYOUT && window.XHGCS_LAYOUT.focusChart) window.XHGCS_LAYOUT.focusChart();
        if (window.XHGCS_APP && window.XHGCS_APP.navigate) window.XHGCS_APP.navigate('visual');
        if (window.XHGCS_APP && window.XHGCS_APP.toast) window.XHGCS_APP.toast('已生成并启用「' + result.def.name + '」');
      } else {
        await window.XHGCS_AI.send(prompt, {
          onDelta: (delta) => appendStream(delta, 'content'),
          onReason: () => appendStream('', 'reasoning'),
          onTool: (output) => {
            state.ai.lastTool = output && output.name ? output.name : '';
            updateStatus();
          },
          onDone: () => {}
        });
      }
    } catch (err) {
      const message = err && err.message ? err.message : String(err);
      state.ai.lastError = message;
      if (directAssistant) {
        X.updateAiMessage(directAssistant.id, {
          content: '',
          meta: { source: 'error', error: message, model: '构图编译器', streaming: false }
        });
      } else {
        X.addAiMessage('assistant', '', { source: 'error', error: message, model: state.ai.lastModel || state.ai.model });
      }
    }
    setLoading(false);
    renderMessages();
    updateStatus();
    if (state.mcp.enabled && window.XHGCS_BRIDGE) window.XHGCS_BRIDGE.pushNow();
  }

  // ---- 输入框上的两个浮层：左下「+」= 技能与快捷指令，右下模型胶囊 = 后端与模型 ----
  function menuHead(box, text) {
    const el = document.createElement('div');
    el.className = 'ai-menu-head';
    el.textContent = text;
    box.appendChild(el);
  }
  function menuItem(box, opts) {
    const el = document.createElement('button');
    el.type = 'button';
    el.className = 'ai-menu-item';
    el.setAttribute('role', 'menuitem');
    if (opts.checked) el.setAttribute('aria-checked', 'true');
    Object.keys(opts.attrs || {}).forEach((key) => el.setAttribute(key, opts.attrs[key]));
    const ico = document.createElement('span');
    ico.className = 'ai-menu-ico';
    ico.textContent = opts.icon || '';
    const text = document.createElement('span');
    text.className = 'ai-menu-text';
    const title = document.createElement('b');
    title.textContent = opts.name;
    text.appendChild(title);
    if (opts.desc) {
      const small = document.createElement('small');
      small.textContent = opts.desc;
      text.appendChild(small);
    }
    el.appendChild(ico);
    el.appendChild(text);
    box.appendChild(el);
  }
  function menuEmpty(box, text) {
    const el = document.createElement('div');
    el.className = 'ai-menu-empty';
    el.textContent = text;
    box.appendChild(el);
  }

  function renderSkillMenu() {
    const box = $('#aiSuggest');
    if (!box) return;
    box.innerHTML = '';
    menuHead(box, '技能');
    SKILLS.forEach((skill) => menuItem(box, {
      icon: '◆',
      name: skill.name,
      desc: skill.desc,
      checked: activeSkill === skill.id,
      attrs: { 'data-ai-skill': skill.id }
    }));
    menuHead(box, '快捷指令');
    QUICK.forEach((item) => menuItem(box, {
      icon: '›',
      name: item.name,
      desc: item.desc,
      attrs: item.dialog ? { 'data-ai-dialog': item.dialog, 'data-ai-cmd': item.cmd || '' } : { 'data-ai-cmd': item.cmd }
    }));
  }

  function modelChipInfo() {
    const dsh = state.ai.backend === 'dsh';
    const cls = state.ai.streaming ? 'streaming' : state.ai.lastError ? 'error' : 'online';
    if (dsh) {
      const profile = state.ai.dshProfile || 'headless';
      return { name: 'DSH Agent · ' + profile, badge: '', state: cls, title: 'DSH Agent（' + profile + '）· 点这里切换后端或模型' };
    }
    if (!state.ai.endpoint && !state.ai.model) {
      return { name: '未配置 API', badge: '', state: '', title: '还没配置 API 端点；点这里切换后端或填写 Endpoint' };
    }
    if (!state.ai.model) {
      return { name: '未选择模型', badge: '', state: '', title: '端点已填但没选模型；点这里挑一个' };
    }
    return {
      name: shortModel(state.ai.model),
      badge: state.ai.disableThinking === false ? '思考' : '',
      state: cls,
      title: state.ai.model + ' · 点这里切换后端或模型'
    };
  }

  function syncModelChip() {
    const chip = $('#btnAiModel');
    if (!chip) return;
    const info = modelChipInfo();
    chip.className = 'ai-model-chip' + (info.state ? ' ' + info.state : '');
    chip.title = info.title;
    const name = $('#aiModelName');
    if (name) name.textContent = info.name;
    const badge = $('#aiModelEffort');
    if (badge) {
      badge.textContent = info.badge;
      badge.classList.toggle('hidden', !info.badge);
    }
  }

  function renderModelMenu() {
    const box = $('#aiModelMenu');
    if (!box) return;
    box.innerHTML = '';
    const dsh = state.ai.backend === 'dsh';
    menuHead(box, '后端');
    menuItem(box, {
      icon: '◇',
      name: 'API 端点',
      desc: state.ai.endpoint || 'OpenAI 兼容 API（DeepSeek / OpenAI / 自建网关…）',
      checked: !dsh,
      attrs: { 'data-ai-backend': 'local' }
    });
    menuItem(box, {
      icon: '◆',
      name: 'DSH Agent',
      desc: 'DeepSeek 官方 CLI · profile ' + (state.ai.dshProfile || 'headless'),
      checked: dsh,
      attrs: { 'data-ai-backend': 'dsh' }
    });
    if (dsh) {
      menuEmpty(box, 'DSH 模式下模型与密钥由 DSH 自己管，这里不用挑模型。');
    } else {
      menuHead(box, '模型');
      const models = state.ai.models || [];
      if (!models.length) {
        menuEmpty(box, '还没获取模型列表：先点「刷新模型列表」，或去设置里填 Endpoint。');
      } else {
        models.forEach((model) => menuItem(box, {
          icon: '·',
          name: model,
          checked: model === state.ai.model,
          attrs: { 'data-ai-model': model }
        }));
      }
      menuItem(box, { icon: '↻', name: '刷新模型列表', desc: '向当前 Endpoint 请求 /v1/models', attrs: { 'data-ai-action': 'refresh' } });
    }
    menuItem(box, { icon: '⚙', name: '打开 AI 设置', desc: '超时 / 系统提示 / 温度等', attrs: { 'data-ai-action': 'settings' } });
  }

  function closeMenus() {
    ['aiSuggest', 'aiModelMenu'].forEach((id) => {
      const el = $('#' + id);
      if (el) el.classList.add('hidden');
    });
    const plus = $('#btnAiPlus');
    if (plus) plus.setAttribute('aria-expanded', 'false');
    const chip = $('#btnAiModel');
    if (chip) chip.setAttribute('aria-expanded', 'false');
  }

  function toggleMenu(id) {
    const el = $('#' + id);
    if (!el) return;
    const willOpen = el.classList.contains('hidden');
    closeMenus();
    if (!willOpen) return;
    if (id === 'aiSuggest') renderSkillMenu();
    else renderModelMenu();
    el.classList.remove('hidden');
    const trigger = id === 'aiSuggest' ? $('#btnAiPlus') : $('#btnAiModel');
    if (trigger) trigger.setAttribute('aria-expanded', 'true');
  }

  function setActiveSkill(def) {
    activeSkill = def ? def.id : null;
    const tag = $('#aiSkillTag');
    if (!tag) return;
    tag.textContent = def ? def.name : '';
    tag.title = def ? def.desc : '';
    tag.classList.toggle('hidden', !def);
  }

  // 不给手动拖拽：高度按内容自动长，到上限后 textarea 自己滚，宽度恒占满整行
  function autoGrow() {
    const input = $('#aiInput');
    if (!input) return;
    const cap = Math.max(88, Math.min(window.innerHeight * 0.48, 460));
    input.style.height = 'auto';
    const next = Math.max(44, Math.min(cap, input.scrollHeight));
    input.style.height = Math.round(next) + 'px';
  }
  function applySkill(def) {
    const input = $('#aiInput');
    if (!input) return;
    const start = typeof input.selectionStart === 'number' ? input.selectionStart : input.value.length;
    const end = typeof input.selectionEnd === 'number' ? input.selectionEnd : input.value.length;
    const before = input.value.slice(0, start);
    const pad = before && !/\s$/.test(before) ? ' ' : '';
    input.value = before + pad + def.prompt + input.value.slice(end);
    const caret = (before + pad + def.prompt).length;
    setActiveSkill(def);
    input.focus();
    input.setSelectionRange(caret, caret);
    autoGrow();
  }

  function pickBackend(value) {
    const next = value === 'dsh' ? 'dsh' : 'local';
    // 即使 state 已经是这个后端也要把设置页下拉拨过去：设置页没打开过时，
    // #setAiBackend 还停在 HTML 默认值上，提前返回会让两处显示不一致。
    state.ai.backend = next;
    X.persist();
    const select = $('#setAiBackend');
    if (select && select.value !== next) { select.value = next; select.dispatchEvent(new Event('change')); }
    updateStatus();
  }

  function pickModel(name) {
    state.ai.model = String(name || '');
    X.persist();
    const field = $('#setAiModel');
    if (field) field.value = state.ai.model;
    updateStatus();
  }

  async function onModelMenuClick(e) {
    const model = e.target.closest('[data-ai-model]');
    if (model) { pickModel(model.dataset.aiModel); closeMenus(); return; }
    const backend = e.target.closest('[data-ai-backend]');
    if (backend) { pickBackend(backend.dataset.aiBackend); renderModelMenu(); return; }
    const action = e.target.closest('[data-ai-action]');
    if (!action) return;
    const kind = action.dataset.aiAction;
    closeMenus();
    if (kind === 'settings') {
      if (window.XHGCS_APP && window.XHGCS_APP.openSettings) window.XHGCS_APP.openSettings('ai');
      return;
    }
    if (kind === 'refresh') {
      if (window.XHGCS_AI && window.XHGCS_AI.refreshModels) {
        try { await window.XHGCS_AI.refreshModels(); } catch (err) { /* 状态条与设置页会显示原因 */ }
      }
      updateStatus();
    }
  }

  function bind() {
    $('#btnAiSend').addEventListener('click', () => {
      // 生成中这枚按钮就是停止键，位置不变、不用去找第二个按钮
      if (loading) {
        if (window.XHGCS_AI && window.XHGCS_AI.abort) window.XHGCS_AI.abort();
        updateStatus();
        return;
      }
      send();
    });
    $('#aiMessages').addEventListener('click', (e) => {
      if (e.target.closest('[data-ai-retry]')) retryLast();
      const openView = e.target.closest('[data-open-view]');
      if (openView) {
        const id = openView.getAttribute('data-open-view');
        if (id && window.XHGCS_VIEWS && window.XHGCS_VIEWS.activateView) {
          window.XHGCS_VIEWS.activateView(id);
          if (window.XHGCS_LAYOUT && window.XHGCS_LAYOUT.focusChart) window.XHGCS_LAYOUT.focusChart();
          if (window.XHGCS_APP && window.XHGCS_APP.navigate) window.XHGCS_APP.navigate('visual');
        }
        return;
      }
      if (e.target.closest('[data-ai-paint]')) {
        if (window.XHGCS_VIEWS && window.XHGCS_VIEWS.openViewDesigner) window.XHGCS_VIEWS.openViewDesigner();
        return;
      }
      const AI = window.XHGCS_AI;
      if (!AI) return;
      const apply = e.target.closest('[data-ai-apply]');
      if (apply) {
        apply.disabled = true;
        AI.applyPendingActions(apply.getAttribute('data-ai-apply'));
        return;
      }
      const discard = e.target.closest('[data-ai-discard]');
      if (discard) {
        AI.discardPendingActions(discard.getAttribute('data-ai-discard'));
        return;
      }
      const allow = e.target.closest('[data-ai-allow]');
      if (allow) {
        allow.disabled = true;
        AI.setAutoApply(true);
        AI.applyPendingActions(allow.getAttribute('data-ai-allow'));
      }
    });
    // 「+」与模型胶囊都是浮层：再点一次收起，点面板外或 Esc 也收起
    $('#btnAiPlus').addEventListener('click', (e) => { e.stopPropagation(); toggleMenu('aiSuggest'); });
    $('#btnAiModel').addEventListener('click', (e) => { e.stopPropagation(); toggleMenu('aiModelMenu'); });
    const paint = $('#btnAiPaint');
    if (paint) paint.addEventListener('click', (e) => {
      e.stopPropagation();
      closeMenus();
      if (window.XHGCS_VIEWS && window.XHGCS_VIEWS.openViewDesigner) window.XHGCS_VIEWS.openViewDesigner();
    });
    const composerWrap = $('#aiComposerWrap');
    // 判定「点在面板内」必须用 composedPath()：菜单项点击后会重渲染，
    // 那一刻 e.target 已经脱离 DOM，contains() 会返回 false 把菜单误关掉。
    document.addEventListener('click', (e) => {
      const path = typeof e.composedPath === 'function' ? e.composedPath() : [];
      const inside = Boolean(composerWrap) && (path.indexOf(composerWrap) >= 0 || composerWrap.contains(e.target));
      if (!inside) closeMenus();
    });
    document.addEventListener('keydown', (e) => { if (e.key === 'Escape') closeMenus(); });
    $('#aiModelMenu').addEventListener('click', onModelMenuClick);
    $('#aiInput').addEventListener('input', autoGrow);
    window.addEventListener('resize', autoGrow);
    autoGrow();
    $('#aiInput').addEventListener('keydown', (e) => {
      if (e.key !== 'Enter') return;
      // 输入法候选框选词时的回车不算发送
      if (e.isComposing || e.keyCode === 229) return;
      // 回车直接发送，Shift+Enter 换行
      if (e.shiftKey) return;
      e.preventDefault();
      send();
    });
    $('#btnAiClear').addEventListener('click', () => {
      // 一键清掉整段对话且没有撤销，紧挨着「任务」按钮，误点就没了
      if (!state.ai.messages.length) return;
      if (!window.confirm('清空全部 AI 对话记录？该操作不可撤销。')) return;
      X.clearAiMessages();
      renderMessages();
    });
    $('#btnAiTasks').addEventListener('click', () => {
      if (window.XHGCS_APP && window.XHGCS_APP.openSettings) window.XHGCS_APP.openSettings('tasks');
    });
    $('#aiContextFrames').addEventListener('change', (e) => {
      state.ai.contextFrames = Math.max(0, Math.min(100, Number(e.target.value) || 0));
      e.target.value = String(state.ai.contextFrames);
      X.persist();
      updateStatus();
    });
    $('#aiAutoRefresh').addEventListener('change', () => updateStatus());
    $('#aiBridgeToggle').addEventListener('change', (e) => {
      state.mcp.enabled = e.target.checked;
      X.persist();
      if (state.mcp.enabled && window.XHGCS_BRIDGE) window.XHGCS_BRIDGE.start();
      else if (window.XHGCS_BRIDGE) window.XHGCS_BRIDGE.stop();
      updateStatus();
    });
    $('#aiSuggest').addEventListener('click', (e) => {
      // 技能：只把「按哪个技能做」插进输入框，模板文字用户还能自己改
      const skill = e.target.closest('[data-ai-skill]');
      if (skill) {
        const def = SKILLS.filter((item) => item.id === skill.dataset.aiSkill)[0];
        if (def) applySkill(def);
        closeMenus();
        return;
      }
      // 「生成脚本」先弹输入对话框：要算什么、吃哪几个通道都能当面写清楚，
      // 不用先去画布上拖一版流程
      const dialog = e.target.closest('[data-ai-dialog]');
      if (dialog && dialog.dataset.aiDialog === 'visual') {
        closeMenus();
        if (window.XHGCS_VIEWS && window.XHGCS_VIEWS.openViewDesigner) window.XHGCS_VIEWS.openViewDesigner();
        return;
      }
      if (dialog && dialog.dataset.aiDialog === 'script') {
        closeMenus();
        const ui = window.XHGCS_ANALYSIS_UI;
        if (ui && ui.openScriptDialog) { ui.openScriptDialog({ inputs: window.XHGCS.state.analysis.inputs }); return; }
      }
      const btn = e.target.closest('[data-ai-cmd]');
      if (btn) { closeMenus(); send(btn.dataset.aiCmd); }
    });
  }

  // 顶栏的「上下文 / MCP 桥」和设置里的 #setAiContextFrames / #setMcpEnabled 是同一份状态，
  // 设置侧保存后由 saveSettings() 调这里把控件刷回来（否则状态已经是 30，面板还写着 10）。
  function syncControls() {
    const ctx = $('#aiContextFrames');
    if (ctx) ctx.value = String(state.ai.contextFrames || 10);
    const bridge = $('#aiBridgeToggle');
    if (bridge) bridge.checked = Boolean(state.mcp.enabled);
    syncModelChip();
  }

  // ---- AI 抽屉（§18）：面板已由 shell-decorate 从 Dock 搬进 #aiPanelHost，
  // 这里只负责开合 / 焦点 / 持久化；对话、流式、任务、确认卡片等内部逻辑一行不动。
  let drawerOpen = false;

  function drawerEl() { return document.getElementById('aiDrawer'); }

  function openDrawer() {
    const drawer = drawerEl();
    if (!drawer) return false;
    drawer.hidden = false;
    drawer.classList.add('ai-column');
    drawerOpen = true;
    if (window.XHGCS_LAYOUT && window.XHGCS_LAYOUT.setAiDrawerOpen) window.XHGCS_LAYOUT.setAiDrawerOpen(true);
    window.dispatchEvent(new CustomEvent('xhgcs:ai-drawer', { detail: { open: true } }));
    updateStatus();
    const input = document.getElementById('aiInput');
    if (input) setTimeout(() => { try { input.focus(); } catch (err) { /* 焦点失败不影响开抽屉 */ } }, 40);
    return true;
  }

  function closeDrawer() {
    const drawer = drawerEl();
    if (!drawer) return false;
    drawer.hidden = true;
    drawer.classList.remove('ai-column');
    drawerOpen = false;
    if (window.XHGCS_LAYOUT && window.XHGCS_LAYOUT.setAiDrawerOpen) window.XHGCS_LAYOUT.setAiDrawerOpen(false);
    window.dispatchEvent(new CustomEvent('xhgcs:ai-drawer', { detail: { open: false } }));
    return true;
  }

  function toggleDrawer() { return drawerOpen ? closeDrawer() : openDrawer(); }

  function bindDrawer() {
    const close = $('#btnAiDrawerClose');
    if (close) close.addEventListener('click', closeDrawer);
    const mask = document.querySelector('[data-ai-drawer-close]');
    if (mask) mask.addEventListener('click', closeDrawer);
    document.addEventListener('keydown', (event) => {
      if (event.key === 'i' && (event.ctrlKey || event.metaKey) && !event.shiftKey && !event.altKey) {
        event.preventDefault();
        toggleDrawer();
        return;
      }
      if (event.key !== 'Escape' || !drawerOpen) return;
      // 先让 AI 面板里的菜单/浮层自己响应 Esc，别一按就把整个抽屉关掉
      const menuOpen = ['aiSuggest', 'aiModelMenu'].some((id) => {
        const el = document.getElementById(id);
        return el && !el.classList.contains('hidden');
      });
      if (menuOpen) return;
      // 任何**可见**的更高层浮层（脚本对话框/设置/通道编辑/内核面板）开着时，Esc 归它们
      const overlayOpen = Array.prototype.some.call(
        document.querySelectorAll('.modal-overlay, .xhgcs-mask, .component-manager'),
        (el) => {
          const cs = getComputedStyle(el);
          if (cs.display === 'none' || cs.visibility === 'hidden') return false;
          const rect = el.getBoundingClientRect();
          return rect.width > 2 && rect.height > 2;
        }
      );
      if (overlayOpen) return;
      // 更高层浮层（设计器/命令面板/看板）优先；否则关抽屉并阻断冒泡，避免顺带关掉 Dock
      if (window.XHGCS_OVERLAY && window.XHGCS_OVERLAY.depth && window.XHGCS_OVERLAY.depth() > 0) return;
      event.preventDefault();
      event.stopPropagation();
      closeDrawer();
    }, true);
    // 抽屉不是模态墙：点导航/顶栏动作就切走并把抽屉收起（否则遮罩视觉上还压着新页面）
    document.addEventListener('click', (event) => {
      if (!drawerOpen) return;
      const target = event.target && event.target.closest
        ? event.target.closest('#sideNav [data-nav], #sideNav [data-action], .topbar-actions button')
        : null;
      if (!target) return;
      if (target.id === 'btnAiDrawer') return; // 同一个入口交给 toggle
      closeDrawer();
    }, true);
    window.addEventListener('xhgcs:ai-drawer-request', (event) => {
      const want = !event.detail || event.detail.open !== false;
      if (want) openDrawer(); else closeDrawer();
    });
    // 刷新后按 layout.v3 持久化状态恢复（首次为收起）
    if (window.XHGCS_LAYOUT && window.XHGCS_LAYOUT.isAiDrawerOpen && window.XHGCS_LAYOUT.isAiDrawerOpen()) {
      setTimeout(openDrawer, 0);
    }
  }

  function init() {
    syncControls();
    renderMessages();
    updateStatus();
    bind();
    bindDrawer();
    startAutoRefresh();
    window.addEventListener('xhgcs:ai-tasks-changed', () => updateStatus());
  }

  if (document.readyState === 'loading') document.addEventListener('DOMContentLoaded', init);
  else init();

  window.XHGCS_AI_UI = { renderMessages: renderMessages, updateStatus: updateStatus, send: send, syncControls: syncControls, humanizeError: humanizeError, openDrawer: openDrawer, closeDrawer: closeDrawer, toggleDrawer: toggleDrawer, isDrawerOpen: () => drawerOpen };
})();

(function(exports) {
  "use strict";
  class Emitter {
    constructor(onListenerError) {
      this.onListenerError = onListenerError;
      this.listeners = [];
      this.muted = false;
    }
    on(fn) {
      const entry = { fn, once: false };
      this.listeners.push(entry);
      return {
        dispose: () => {
          const index = this.listeners.indexOf(entry);
          if (index >= 0) this.listeners.splice(index, 1);
        }
      };
    }
    once(fn) {
      const entry = { fn, once: true };
      this.listeners.push(entry);
      return {
        dispose: () => {
          const index = this.listeners.indexOf(entry);
          if (index >= 0) this.listeners.splice(index, 1);
        }
      };
    }
    emit(event) {
      if (this.muted) return;
      const snapshot = this.listeners.slice();
      for (const entry of snapshot) {
        try {
          entry.fn(event);
        } catch (err) {
          if (this.onListenerError) {
            try {
              this.onListenerError(err);
            } catch {
            }
          }
        }
        if (entry.once) {
          const index = this.listeners.indexOf(entry);
          if (index >= 0) this.listeners.splice(index, 1);
        }
      }
    }
    /** 批量注销时用：停止派发并清空。 */
    clear() {
      this.listeners.length = 0;
    }
    get size() {
      return this.listeners.length;
    }
  }
  class DisposableStore {
    constructor() {
      this.items = [];
      this.disposed = false;
    }
    add(item) {
      if (this.disposed) {
        try {
          item.dispose();
        } catch {
        }
        return item;
      }
      this.items.push(item);
      return item;
    }
    get size() {
      return this.items.length;
    }
    dispose() {
      if (this.disposed) return;
      this.disposed = true;
      const items = this.items;
      this.items = [];
      for (let i = items.length - 1; i >= 0; i--) {
        try {
          items[i].dispose();
        } catch (err) {
          console.warn("[XHGCS_CORE] 释放资源失败", err);
        }
      }
    }
  }
  class ContributionRegistry {
    constructor() {
      this.points = /* @__PURE__ */ new Map();
      this.onChange = new Emitter();
    }
    onDidChange(listener) {
      return this.onChange.on(listener);
    }
    register(point, id, value, owner) {
      const key = String(id || "").trim();
      if (!key) throw new Error(`贡献点 ${point} 的 id 不能为空`);
      let bucket = this.points.get(point);
      if (!bucket) {
        bucket = /* @__PURE__ */ new Map();
        this.points.set(point, bucket);
      }
      const existing = bucket.get(key);
      if (existing && existing.owner !== owner) {
        throw new Error(`贡献点 ${point} 的 id "${key}" 已被扩展 ${existing.owner} 占用`);
      }
      const entry = { point, id: key, value, owner, registeredAt: Date.now() };
      bucket.set(key, entry);
      this.onChange.emit({ kind: "register", point, id: key, owner });
      let done = false;
      return {
        dispose: () => {
          if (done) return;
          done = true;
          const current = this.points.get(point);
          if (!current) return;
          const now = current.get(key);
          if (!now || now.owner !== owner) return;
          current.delete(key);
          this.onChange.emit({ kind: "unregister", point, id: key, owner });
        }
      };
    }
    get(point, id) {
      return this.points.get(point)?.get(String(id))?.value;
    }
    entry(point, id) {
      return this.points.get(point)?.get(String(id));
    }
    all(point) {
      const bucket = this.points.get(point);
      if (!bucket) return [];
      return Array.from(bucket.values());
    }
    values(point) {
      return this.all(point).map((entry) => entry.value);
    }
    has(point, id) {
      return Boolean(this.points.get(point)?.has(String(id)));
    }
    owners(point) {
      return Array.from(new Set(this.all(point).map((entry) => entry.owner)));
    }
    /** 卸载/热重载的唯一入口：一次清掉某个扩展的全部贡献。 */
    unregisterAll(owner) {
      let removed = 0;
      for (const [point, bucket] of this.points) {
        for (const [id, entry] of Array.from(bucket.entries())) {
          if (entry.owner !== owner) continue;
          bucket.delete(id);
          removed += 1;
          this.onChange.emit({ kind: "unregister", point, id, owner });
        }
      }
      return removed;
    }
    clear() {
      this.points.clear();
      this.onChange.emit({ kind: "clear", point: "*", id: "*", owner: "*" });
    }
    /** 扩展面板用：按贡献点统计条数。 */
    stats() {
      const out = {};
      for (const [point, bucket] of this.points) out[point] = bucket.size;
      return out;
    }
  }
  const registry = new ContributionRegistry();
  const OPERATORS = ["&&", "||", "==", "!=", ">=", "<=", ">", "<", "!", "(", ")", "[", "]", ",", "in"];
  function tokenize(source) {
    const tokens = [];
    let index = 0;
    const text = String(source || "");
    while (index < text.length) {
      const char = text[index];
      if (/\s/.test(char)) {
        index += 1;
        continue;
      }
      if (char === '"' || char === "'") {
        const quote = char;
        let value = "";
        index += 1;
        while (index < text.length && text[index] !== quote) {
          if (text[index] === "\\" && index + 1 < text.length) {
            value += text[index + 1];
            index += 2;
            continue;
          }
          value += text[index];
          index += 1;
        }
        index += 1;
        tokens.push({ kind: "string", value });
        continue;
      }
      if (/[0-9]/.test(char)) {
        let value = "";
        while (index < text.length && /[0-9.]/.test(text[index])) {
          value += text[index];
          index += 1;
        }
        tokens.push({ kind: "number", value: Number(value) });
        continue;
      }
      if (/[A-Za-z_$]/.test(char)) {
        let value = "";
        while (index < text.length && /[A-Za-z0-9_$.\-]/.test(text[index])) {
          value += text[index];
          index += 1;
        }
        if (value === "true" || value === "false") {
          tokens.push({ kind: "string", value });
        } else if (value === "in") {
          tokens.push({ kind: "op", value: "in" });
        } else {
          tokens.push({ kind: "ident", value });
        }
        continue;
      }
      const op = OPERATORS.find((candidate) => text.startsWith(candidate, index));
      if (op) {
        tokens.push({ kind: "op", value: op });
        index += op.length;
        continue;
      }
      if (char === "=") {
        tokens.push({ kind: "op", value: "==" });
        index += 1;
        continue;
      }
      throw new Error(`when 表达式含非法字符 "${char}"`);
    }
    tokens.push({ kind: "eof", value: "" });
    return tokens;
  }
  class Parser {
    constructor(tokens, context) {
      this.tokens = tokens;
      this.context = context;
      this.pos = 0;
    }
    peek() {
      return this.tokens[this.pos];
    }
    next() {
      return this.tokens[this.pos++];
    }
    eatOp(value) {
      const token = this.peek();
      if (token.kind === "op" && token.value === value) {
        this.pos += 1;
        return true;
      }
      return false;
    }
    expectOp(value) {
      if (!this.eatOp(value)) throw new Error(`when 表达式缺少 "${value}"`);
    }
    parse() {
      const value = this.parseOr();
      if (this.peek().kind !== "eof") throw new Error("when 表达式存在多余内容");
      return truthy(value);
    }
    parseOr() {
      let left = this.parseAnd();
      while (this.eatOp("||")) {
        const right = this.parseAnd();
        left = truthy(left) || truthy(right);
      }
      return left;
    }
    parseAnd() {
      let left = this.parseUnary();
      while (this.eatOp("&&")) {
        const right = this.parseUnary();
        left = truthy(left) && truthy(right);
      }
      return left;
    }
    parseUnary() {
      if (this.eatOp("!")) return !truthy(this.parseUnary());
      return this.parseComparison();
    }
    parseComparison() {
      const left = this.parseValue();
      const token = this.peek();
      if (token.kind === "op" && ["==", "!=", ">", "<", ">=", "<=", "in"].includes(token.value)) {
        this.next();
        const right = this.parseValue();
        return compare(token.value, left, right);
      }
      return left;
    }
    parseValue(literalIdent = false) {
      const token = this.peek();
      if (token.kind === "op" && token.value === "(") {
        this.next();
        const value = this.parseOr();
        this.expectOp(")");
        return value;
      }
      if (token.kind === "op" && token.value === "[") {
        this.next();
        const items = [];
        while (!(this.peek().kind === "op" && this.peek().value === "]")) {
          items.push(this.parseValue(true));
          if (!this.eatOp(",")) break;
        }
        this.expectOp("]");
        return items;
      }
      if (token.kind === "ident") {
        this.next();
        const resolved = resolve(token.value, this.context);
        return literalIdent && resolved === void 0 ? token.value : resolved;
      }
      if (token.kind === "string") {
        this.next();
        return token.value === "true" ? true : token.value === "false" ? false : token.value;
      }
      if (token.kind === "number") {
        this.next();
        return token.value;
      }
      throw new Error("when 表达式缺少数值或标识符");
    }
  }
  function resolve(path, context) {
    const trimmed = path.replace(/^context\./, "");
    if (!trimmed) return void 0;
    const segments = trimmed.split(".");
    let cursor = context;
    for (const segment of segments) {
      if (cursor == null || typeof cursor !== "object") return void 0;
      cursor = cursor[segment];
    }
    return cursor;
  }
  function truthy(value) {
    if (Array.isArray(value)) return value.length > 0;
    if (value == null) return false;
    if (typeof value === "string") return value.length > 0 && value !== "false" && value !== "0";
    return Boolean(value);
  }
  function compare(op, left, right) {
    switch (op) {
      case "==":
        return looseEqual(left, right);
      case "!=":
        return !looseEqual(left, right);
      case "in": {
        if (Array.isArray(right)) return right.some((item) => looseEqual(item, left));
        if (typeof right === "string") return right.split(",").map((s) => s.trim()).includes(String(left));
        return false;
      }
      case ">":
        return Number(left) > Number(right);
      case "<":
        return Number(left) < Number(right);
      case ">=":
        return Number(left) >= Number(right);
      case "<=":
        return Number(left) <= Number(right);
      default:
        return false;
    }
  }
  function looseEqual(left, right) {
    if (left === right) return true;
    if (left == null && right == null) return true;
    return String(left) === String(right);
  }
  function evaluateWhen(source, context) {
    const text = String(source == null ? "" : source).trim();
    if (!text) return true;
    try {
      const parser = new Parser(tokenize(text), context);
      return parser.parse();
    } catch {
      return false;
    }
  }
  function validateWhen(source) {
    const text = String(source == null ? "" : source).trim();
    if (!text) return { ok: true, error: "" };
    try {
      new Parser(tokenize(text), {}).parse();
      return { ok: true, error: "" };
    } catch (err) {
      return { ok: false, error: err instanceof Error ? err.message : String(err) };
    }
  }
  const handlers = /* @__PURE__ */ new Map();
  const onExecute = new Emitter();
  function registerCommandContribution(owner, contribution) {
    return registry.register("commands", contribution.id, contribution, owner);
  }
  function registerCommand(owner, id, handler) {
    if (handlers.has(id)) {
      const existing = handlers.get(id);
      if (existing.owner !== owner) throw new Error(`命令 ${id} 已被扩展 ${existing.owner} 注册`);
    }
    const contribution = registry.get("commands", id);
    handlers.set(id, {
      id,
      title: contribution?.title || id,
      category: contribution?.category || "",
      owner,
      handler
    });
    return {
      dispose: () => {
        const current = handlers.get(id);
        if (current && current.owner === owner) handlers.delete(id);
      }
    };
  }
  function listCommands() {
    return Array.from(handlers.values()).sort((a, b) => `${a.category}${a.title}`.localeCompare(`${b.category}${b.title}`));
  }
  let activationHook = null;
  function setCommandActivationHook(hook) {
    activationHook = hook;
  }
  async function executeCommand(id, ...args) {
    let info = handlers.get(id);
    if (!info && activationHook) {
      try {
        await activationHook(id);
      } catch {
      }
      info = handlers.get(id);
    }
    if (!info) {
      const contribution = registry.get("commands", id);
      const detail = contribution ? `命令 ${id} 已声明但尚未激活（缺少激活事件 onCommand:${id}？）` : `未注册的命令 ${id}`;
      onExecute.emit({ id, args, ok: false, error: detail });
      throw new Error(detail);
    }
    try {
      const result = await info.handler(...args);
      onExecute.emit({ id, args, ok: true, error: "" });
      return result;
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      onExecute.emit({ id, args, ok: false, error: message });
      console.warn(`[XHGCS_CORE] 命令 ${id} 执行失败`, err);
      throw err;
    }
  }
  const bindings = [];
  let keyListenerInstalled = false;
  function normalizeKey(input) {
    const parts = String(input || "").toLowerCase().split("+").map((part) => part.trim()).filter(Boolean);
    const mods = /* @__PURE__ */ new Set();
    let key = "";
    for (const part of parts) {
      if (part === "ctrl" || part === "control") mods.add("ctrl");
      else if (part === "shift") mods.add("shift");
      else if (part === "alt" || part === "option") mods.add("alt");
      else if (part === "meta" || part === "cmd" || part === "win") mods.add("meta");
      else key = part;
    }
    const ordered = [];
    if (mods.has("ctrl")) ordered.push("ctrl");
    if (mods.has("alt")) ordered.push("alt");
    if (mods.has("shift")) ordered.push("shift");
    if (mods.has("meta")) ordered.push("meta");
    ordered.push(key);
    return ordered.join("+");
  }
  function eventToKey(event) {
    const parts = [];
    if (event.ctrlKey) parts.push("ctrl");
    if (event.altKey) parts.push("alt");
    if (event.shiftKey) parts.push("shift");
    if (event.metaKey) parts.push("meta");
    const key = String(event.key || "").toLowerCase();
    const named = {
      " ": "space",
      arrowup: "up",
      arrowdown: "down",
      arrowleft: "left",
      arrowright: "right",
      escape: "escape",
      enter: "enter",
      tab: "tab",
      backspace: "backspace",
      delete: "delete"
    };
    parts.push(named[key] || key);
    return parts.join("+");
  }
  function registerKeybinding(owner, contribution) {
    const isMac = /mac|iphone|ipad/i.test(navigator.platform || navigator.userAgent || "");
    const key = normalizeKey(isMac && contribution.mac || contribution.key);
    const info = {
      key,
      command: contribution.command,
      when: contribution.when || "",
      owner
    };
    bindings.push(info);
    return {
      dispose: () => {
        const index = bindings.indexOf(info);
        if (index >= 0) bindings.splice(index, 1);
      }
    };
  }
  function installKeybindingListener(getContext) {
    if (keyListenerInstalled) return { dispose: () => void 0 };
    keyListenerInstalled = true;
    const listener = (event) => {
      if (event.defaultPrevented) return;
      const target = event.target;
      const tag = (target?.tagName || "").toLowerCase();
      const editing = tag === "input" || tag === "textarea" || tag === "select" || target?.isContentEditable === true;
      const key = eventToKey(event);
      const plain = !event.ctrlKey && !event.metaKey && !event.altKey;
      if (editing && plain) return;
      const context = getContext();
      const hit = bindings.filter((binding) => binding.key === key).filter((binding) => evaluateWhen(binding.when, context)).sort((a, b) => b.when.length - a.when.length)[0];
      if (!hit) return;
      event.preventDefault();
      event.stopPropagation();
      executeCommand(hit.command).catch((err) => console.warn("[XHGCS_CORE] 快捷键命令失败", hit.command, err));
    };
    window.addEventListener("keydown", listener);
    return {
      dispose: () => {
        window.removeEventListener("keydown", listener);
        keyListenerInstalled = false;
      }
    };
  }
  const STORAGE_KEY = "xhgcs.ext.config.v1";
  function readAll() {
    try {
      const raw = localStorage.getItem(STORAGE_KEY);
      if (!raw) return {};
      const parsed = JSON.parse(raw);
      return parsed && typeof parsed === "object" ? parsed : {};
    } catch {
      return {};
    }
  }
  class ConfigurationService {
    constructor() {
      this.schemas = /* @__PURE__ */ new Map();
      this.values = /* @__PURE__ */ new Map();
      this.onChange = new Emitter();
      this.writeTimer = null;
      this.dirty = false;
      const stored = readAll();
      for (const [key, value] of Object.entries(stored)) this.values.set(key, value);
    }
    schemaKey(owner, key) {
      return `${owner}/${key}`;
    }
    register(owner, contribution) {
      this.schemas.set(owner, {
        owner,
        title: contribution.title || owner,
        properties: contribution.properties || {}
      });
      return {
        dispose: () => {
          this.schemas.delete(owner);
        }
      };
    }
    schema(owner) {
      return this.schemas.get(owner);
    }
    schemas_() {
      return Array.from(this.schemas.values());
    }
    propertyOf(owner, key) {
      return this.schemas.get(owner)?.properties[key];
    }
    /** 带 schema 校验与默认值的读取。 */
    get(owner, key) {
      const storageKey = this.schemaKey(owner, key);
      const property = this.propertyOf(owner, key);
      if (this.values.has(storageKey)) {
        return this.coerce(this.values.get(storageKey), property);
      }
      return property ? property.default : void 0;
    }
    update(owner, key, value) {
      const property = this.propertyOf(owner, key);
      const next = this.coerce(value, property);
      const storageKey = this.schemaKey(owner, key);
      const previous = this.get(owner, key);
      if (Object.is(previous, next)) return;
      this.values.set(storageKey, next);
      this.dirty = true;
      this.scheduleWrite();
      this.onChange.emit({ owner, key, value: next, previous });
    }
    onDidChange(listener) {
      return this.onChange.on(listener);
    }
    /** 导出给快照/备份用：只包含显式设过的值。 */
    snapshot() {
      const out = {};
      for (const [key, value] of this.values) out[key] = value;
      return out;
    }
    dropOwner(owner) {
      const prefix = `${owner}/`;
      for (const key of Array.from(this.values.keys())) {
        if (key.startsWith(prefix)) this.values.delete(key);
      }
      this.schemas.delete(owner);
      this.dirty = true;
      this.scheduleWrite();
    }
    /** 只清掉用户设过的值，保留 schema —— 设置页上的「恢复默认」用它。 */
    reset(owner) {
      const prefix = `${owner}/`;
      for (const key of Array.from(this.values.keys())) {
        if (key.startsWith(prefix)) this.values.delete(key);
      }
      this.dirty = true;
      this.scheduleWrite();
    }
    flush() {
      if (!this.dirty) return;
      this.dirty = false;
      try {
        localStorage.setItem(STORAGE_KEY, JSON.stringify(this.snapshot()));
      } catch (err) {
        console.warn("[XHGCS_CORE] 配置写入失败", err);
      }
    }
    scheduleWrite() {
      if (this.writeTimer != null) return;
      this.writeTimer = window.setTimeout(() => {
        this.writeTimer = null;
        this.flush();
      }, 300);
    }
    coerce(value, property) {
      if (!property) return value;
      switch (property.type) {
        case "number":
        case "integer": {
          let num = Number(value);
          if (!Number.isFinite(num)) num = Number(property.default) || 0;
          if (property.type === "integer") num = Math.round(num);
          if (typeof property.minimum === "number") num = Math.max(property.minimum, num);
          if (typeof property.maximum === "number") num = Math.min(property.maximum, num);
          return num;
        }
        case "boolean":
          return value === true || value === "true" || value === 1 || value === "1";
        case "enum": {
          const allowed = property.enum || [];
          const hit = allowed.find((item) => String(item) === String(value));
          return hit === void 0 ? property.default : hit;
        }
        case "array":
          return Array.isArray(value) ? value : Array.isArray(property.default) ? property.default : [];
        case "object":
          return value && typeof value === "object" && !Array.isArray(value) ? value : property.default && typeof property.default === "object" ? property.default : {};
        case "string":
        default:
          return value == null ? property.default : String(value);
      }
    }
  }
  const configuration = new ConfigurationService();
  function scopedConfiguration(owner) {
    return {
      get(key) {
        return configuration.get(owner, key);
      },
      update(key, value) {
        configuration.update(owner, key, value);
      },
      has(key) {
        return Boolean(configuration.schema(owner)?.properties[key]);
      },
      all() {
        const schema = configuration.schema(owner);
        const out = {};
        if (!schema) return out;
        for (const key of Object.keys(schema.properties)) out[key] = configuration.get(owner, key);
        return out;
      },
      onDidChange(listener) {
        return configuration.onDidChange((change) => {
          if (change.owner !== owner) return;
          listener(change.key, change.value, change.previous);
        });
      }
    };
  }
  const VERSION_RE = /^v?(\d+)\.(\d+)\.(\d+)(?:-([0-9A-Za-z.-]+))?(?:\+[0-9A-Za-z.-]+)?$/;
  function parseVersion(input) {
    const match = VERSION_RE.exec(String(input || "").trim());
    if (!match) return null;
    return {
      major: Number(match[1]),
      minor: Number(match[2]),
      patch: Number(match[3]),
      prerelease: match[4] || "",
      raw: String(input)
    };
  }
  function compareVersions(a, b) {
    const left = parseVersion(a);
    const right = parseVersion(b);
    if (!left || !right) return 0;
    if (left.major !== right.major) return left.major - right.major;
    if (left.minor !== right.minor) return left.minor - right.minor;
    const patchDiff = left.patch - right.patch;
    if (patchDiff !== 0) return patchDiff;
    return comparePrerelease(left.prerelease, right.prerelease);
  }
  function comparePrerelease(a, b) {
    if (!a && !b) return 0;
    if (!a) return 1;
    if (!b) return -1;
    const left = a.split(".");
    const right = b.split(".");
    const size = Math.max(left.length, right.length);
    for (let i = 0; i < size; i++) {
      const l = left[i];
      const r = right[i];
      if (l == null) return -1;
      if (r == null) return 1;
      const ln = /^\d+$/.test(l) ? Number(l) : null;
      const rn = /^\d+$/.test(r) ? Number(r) : null;
      if (ln != null && rn != null) {
        if (ln !== rn) return ln - rn;
        continue;
      }
      if (ln != null) return -1;
      if (rn != null) return 1;
      if (l !== r) return l < r ? -1 : 1;
    }
    return 0;
  }
  function wildcard(input) {
    const cleaned = String(input || "*").trim().replace(/^v/, "").replace(/[xX*]/g, "x");
    const parts = cleaned.split(".");
    const out = [];
    for (let i = 0; i < 3; i++) {
      const part = parts[i];
      if (part == null || part === "x" || part === "") {
        out.push(null);
        continue;
      }
      const num = Number(part);
      out.push(Number.isFinite(num) ? num : null);
    }
    return { parts: out };
  }
  function matchComparator(version, comparator) {
    const token = comparator.trim();
    if (!token || token === "*" || token === "x" || token === "latest") return true;
    const operator = /^(>=|<=|>|<|=|\^|~)/.exec(token)?.[1] ?? "";
    const body = operator ? token.slice(operator.length).trim() : token;
    const parsed = parseVersion(version);
    if (!parsed) return false;
    if (operator === "^" || operator === "~" || operator === "") {
      const range2 = wildcard(body);
      const [major, minor, patch] = range2.parts;
      if (major != null && parsed.major !== major) return false;
      if (minor != null) {
        if (parsed.minor !== minor) return false;
        if (operator === "~" || operator === "") {
          if (patch != null && parsed.patch !== patch) return false;
          return true;
        }
        if (operator === "^") return parsed.major === major;
      }
      return true;
    }
    const target = `0.0.0`.split(".");
    const range = wildcard(body);
    for (let i = 0; i < 3; i++) {
      if (range.parts[i] != null) target[i] = String(range.parts[i]);
    }
    const targetVersion = target.join(".");
    const cmp = compareVersions(version, targetVersion);
    switch (operator) {
      case ">=":
        return cmp >= 0;
      case "<=":
        return cmp <= 0;
      case ">":
        return cmp > 0;
      case "<":
        return cmp < 0;
      case "=":
        return cmp === 0;
      default:
        return true;
    }
  }
  function satisfies(version, range) {
    if (!parseVersion(version)) return false;
    const text = String(range == null ? "*" : range).trim();
    if (!text || text === "*") return true;
    return text.split("||").some((segment) => {
      const comparators = segment.trim().split(/\s+/).filter(Boolean);
      if (!comparators.length) return true;
      return comparators.every((comparator) => matchComparator(version, comparator));
    });
  }
  const COMPARATOR_RE = /^(>=|<=|>|<|=|\^|~)?\s*v?\d+(\.\d+){0,3}(-[0-9A-Za-z.-]+)?$/;
  function isValidRange(range) {
    const text = String(range == null ? "*" : range).trim();
    if (!text || text === "*") return true;
    return text.split("||").every((segment) => {
      const comparators = segment.trim().split(/\s+/).filter(Boolean);
      return comparators.length > 0 && comparators.every((comparator) => COMPARATOR_RE.test(comparator));
    });
  }
  const CORE_API_VERSION = "1";
  const CORE_VERSION = "0.31.1";
  const ID_RE = /^[a-z0-9][a-z0-9._-]{2,63}$/i;
  const KNOWN_PERMISSIONS = [
    "data:read",
    "data:write",
    "ui:view",
    "ui:panel",
    "ui:statusBar",
    "ui:toast",
    "ui:menu",
    "config:read",
    "config:write",
    "storage:own",
    "commands:execute",
    "protocols:own",
    "operators:own",
    "datasources:own",
    "pipeline:own",
    "network",
    "fs:own"
  ];
  const SIMPLE_EVENTS = /* @__PURE__ */ new Set(["*", "onStartup", "onStartupFinished", "onCommand:*", "onView:*"]);
  function parseActivationEvent(raw) {
    const text = String(raw || "").trim();
    if (!text) return null;
    if (SIMPLE_EVENTS.has(text)) return { event: text, arg: "", raw: text };
    const index = text.indexOf(":");
    if (index <= 0) return null;
    const event = text.slice(0, index);
    const arg = text.slice(index + 1).trim();
    if (!arg) return null;
    const allowed = [
      "onView",
      "onPanel",
      "onCommand",
      "onProtocol",
      "onOperator",
      "onDataSource",
      "onConfig",
      "onDesignerWidget",
      "onTheme"
    ];
    if (!allowed.includes(event)) return null;
    return { event, arg, raw: text };
  }
  function isPlainObject$1(value) {
    return Boolean(value) && typeof value === "object" && !Array.isArray(value);
  }
  function asArray(value) {
    return Array.isArray(value) ? value : [];
  }
  function issue(issues, path, message, severity = "error") {
    issues.push({ path, message, severity });
  }
  function requireString(issues, holder, key, path, maxLength = 120) {
    const value = holder[key];
    if (typeof value !== "string" || !value.trim()) {
      issue(issues, `${path}.${key}`, "必须是非空字符串");
      return null;
    }
    if (value.length > maxLength) issue(issues, `${path}.${key}`, `长度不能超过 ${maxLength}`);
    return value.trim();
  }
  function validateCommands(issues, raw) {
    if (raw == null) return void 0;
    if (!Array.isArray(raw)) {
      issue(issues, "contributes.commands", "必须是数组");
      return void 0;
    }
    const out = [];
    raw.forEach((item, index) => {
      const path = `contributes.commands[${index}]`;
      if (!isPlainObject$1(item)) {
        issue(issues, path, "必须是对象");
        return;
      }
      const id = requireString(issues, item, "id", path, 80);
      const title = requireString(issues, item, "title", path, 80);
      if (item.when != null) {
        const check = validateWhen(String(item.when));
        if (!check.ok) issue(issues, `${path}.when`, check.error);
      }
      if (id && title) {
        out.push({
          id,
          title,
          category: typeof item.category === "string" ? item.category : void 0,
          icon: typeof item.icon === "string" ? item.icon : void 0,
          when: typeof item.when === "string" ? item.when : void 0
        });
      }
    });
    return out;
  }
  function validateViews(issues, raw) {
    if (raw == null) return void 0;
    if (!Array.isArray(raw)) {
      issue(issues, "contributes.views", "必须是数组");
      return void 0;
    }
    const out = [];
    raw.forEach((item, index) => {
      const path = `contributes.views[${index}]`;
      if (!isPlainObject$1(item)) {
        issue(issues, path, "必须是对象");
        return;
      }
      const id = requireString(issues, item, "id", path, 64);
      const name = requireString(issues, item, "name", path, 40);
      if (item.when != null) {
        const check = validateWhen(String(item.when));
        if (!check.ok) issue(issues, `${path}.when`, check.error);
      }
      if (id && name) {
        out.push({
          id,
          name,
          icon: typeof item.icon === "string" ? item.icon.slice(0, 2) : void 0,
          container: typeof item.container === "string" ? item.container : "instrumentRail",
          order: Number.isFinite(Number(item.order)) ? Number(item.order) : 100,
          when: typeof item.when === "string" ? item.when : void 0,
          exportName: typeof item.exportName === "string" ? item.exportName : void 0
        });
      }
    });
    return out;
  }
  function validateStatusBar(issues, raw) {
    if (raw == null) return void 0;
    if (!Array.isArray(raw)) {
      issue(issues, "contributes.statusBar", "必须是数组");
      return void 0;
    }
    const out = [];
    raw.forEach((item, index) => {
      const path = `contributes.statusBar[${index}]`;
      if (!isPlainObject$1(item)) {
        issue(issues, path, "必须是对象");
        return;
      }
      const id = requireString(issues, item, "id", path, 64);
      if (!id) return;
      if (typeof item.text !== "string" && typeof item.command !== "string") {
        issue(issues, path, "text 与 command 至少要有一个");
        return;
      }
      out.push({
        id,
        text: typeof item.text === "string" ? item.text : "",
        alignment: item.alignment === "left" ? "left" : "right",
        priority: Number.isFinite(Number(item.priority)) ? Number(item.priority) : 100,
        command: typeof item.command === "string" ? item.command : void 0,
        tooltip: typeof item.tooltip === "string" ? item.tooltip : void 0,
        tone: ["default", "info", "warn", "error", "ok"].includes(String(item.tone)) ? item.tone : "default"
      });
    });
    return out;
  }
  function validateConfiguration(issues, raw) {
    if (raw == null) return void 0;
    if (!isPlainObject$1(raw)) {
      issue(issues, "contributes.configuration", "必须是对象");
      return void 0;
    }
    const propertiesRaw = raw.properties;
    if (!isPlainObject$1(propertiesRaw)) {
      issue(issues, "contributes.configuration.properties", "必须是对象");
      return void 0;
    }
    const properties = {};
    for (const [key, value] of Object.entries(propertiesRaw)) {
      const path = `contributes.configuration.properties.${key}`;
      if (!isPlainObject$1(value)) {
        issue(issues, path, "必须是对象");
        continue;
      }
      const type = String(value.type || "");
      if (!["string", "number", "integer", "boolean", "enum", "array", "object"].includes(type)) {
        issue(issues, `${path}.type`, "type 必须是 string/number/integer/boolean/enum/array/object");
        continue;
      }
      if (type === "enum" && !Array.isArray(value.enum)) {
        issue(issues, `${path}.enum`, "enum 类型必须给出 enum 数组");
        continue;
      }
      if (!("default" in value)) {
        issue(issues, `${path}.default`, "必须给出 default，否则读配置的扩展会拿到 undefined");
        continue;
      }
      properties[key] = {
        type,
        default: value.default,
        description: typeof value.description === "string" ? value.description : void 0,
        minimum: Number.isFinite(Number(value.minimum)) ? Number(value.minimum) : void 0,
        maximum: Number.isFinite(Number(value.maximum)) ? Number(value.maximum) : void 0,
        step: Number.isFinite(Number(value.step)) ? Number(value.step) : void 0,
        enum: Array.isArray(value.enum) ? value.enum : void 0,
        enumLabels: Array.isArray(value.enumLabels) ? value.enumLabels.map(String) : void 0,
        group: typeof value.group === "string" ? value.group : void 0,
        order: Number.isFinite(Number(value.order)) ? Number(value.order) : void 0
      };
    }
    return { title: typeof raw.title === "string" ? raw.title : void 0, properties };
  }
  function validateKeybindings(issues, raw) {
    if (raw == null) return void 0;
    if (!Array.isArray(raw)) {
      issue(issues, "contributes.keybindings", "必须是数组");
      return void 0;
    }
    const out = [];
    raw.forEach((item, index) => {
      const path = `contributes.keybindings[${index}]`;
      if (!isPlainObject$1(item)) {
        issue(issues, path, "必须是对象");
        return;
      }
      const key = requireString(issues, item, "key", path, 40);
      const command = requireString(issues, item, "command", path, 80);
      if (item.when != null) {
        const check = validateWhen(String(item.when));
        if (!check.ok) issue(issues, `${path}.when`, check.error);
      }
      if (key && command) {
        out.push({
          key,
          command,
          when: typeof item.when === "string" ? item.when : void 0,
          mac: typeof item.mac === "string" ? item.mac : void 0
        });
      }
    });
    return out;
  }
  function validateMenus(issues, raw) {
    if (raw == null) return void 0;
    if (!Array.isArray(raw)) {
      issue(issues, "contributes.menus", "必须是数组");
      return void 0;
    }
    const allowed = ["rail", "view/title", "context", "statusbar"];
    const out = [];
    raw.forEach((item, index) => {
      const path = `contributes.menus[${index}]`;
      if (!isPlainObject$1(item)) {
        issue(issues, path, "必须是对象");
        return;
      }
      const command = requireString(issues, item, "command", path, 80);
      const location2 = String(item.location || "");
      if (!allowed.includes(location2)) {
        issue(issues, `${path}.location`, `location 必须是 ${allowed.join(" / ")}`);
      }
      if (item.when != null) {
        const check = validateWhen(String(item.when));
        if (!check.ok) issue(issues, `${path}.when`, check.error);
      }
      if (command && allowed.includes(location2)) {
        out.push({
          location: location2,
          command,
          when: typeof item.when === "string" ? item.when : void 0,
          group: typeof item.group === "string" ? item.group : void 0,
          order: Number.isFinite(Number(item.order)) ? Number(item.order) : 100,
          label: typeof item.label === "string" ? item.label : void 0,
          icon: typeof item.icon === "string" ? item.icon : void 0
        });
      }
    });
    return out;
  }
  function validateDesignerWidgets(issues, raw) {
    if (raw == null) return void 0;
    if (!Array.isArray(raw)) {
      issue(issues, "contributes.designerWidgets", "必须是数组");
      return void 0;
    }
    const out = [];
    raw.forEach((item, index) => {
      const path = `contributes.designerWidgets[${index}]`;
      if (!isPlainObject$1(item)) {
        issue(issues, path, "必须是对象");
        return;
      }
      const id = requireString(issues, item, "id", path, 64);
      const label = requireString(issues, item, "label", path, 40);
      if (!id || !label) return;
      const schema = isPlainObject$1(item.propSchema) ? item.propSchema : void 0;
      out.push({
        id,
        label,
        icon: typeof item.icon === "string" ? item.icon.slice(0, 2) : void 0,
        group: typeof item.group === "string" ? item.group : "通用",
        defaultSize: isPlainObject$1(item.defaultSize) ? { w: Number(item.defaultSize.w) || 4, h: Number(item.defaultSize.h) || 3 } : void 0,
        minSize: isPlainObject$1(item.minSize) ? { w: Number(item.minSize.w) || 2, h: Number(item.minSize.h) || 1 } : void 0,
        propSchema: schema,
        defaults: isPlainObject$1(item.defaults) ? item.defaults : void 0,
        exportName: typeof item.exportName === "string" ? item.exportName : void 0
      });
    });
    return out;
  }
  function validateGenericList(issues, raw, point, required) {
    if (raw == null) return void 0;
    if (!Array.isArray(raw)) {
      issue(issues, `contributes.${point}`, "必须是数组");
      return void 0;
    }
    const out = [];
    raw.forEach((item, index) => {
      const path = `contributes.${point}[${index}]`;
      if (!isPlainObject$1(item)) {
        issue(issues, path, "必须是对象");
        return;
      }
      let ok = true;
      for (const key of required) {
        if (typeof item[key] !== "string" || !String(item[key]).trim()) {
          issue(issues, `${path}.${key}`, "必须是非空字符串");
          ok = false;
        }
      }
      if (ok) out.push(item);
    });
    return out;
  }
  function isCrossOrigin(entry) {
    if (typeof location === "undefined") return false;
    try {
      const resolved = new URL(entry, location.href);
      return resolved.origin !== location.origin && location.origin !== "null";
    } catch {
      return true;
    }
  }
  function validateManifest(raw) {
    const issues = [];
    if (!isPlainObject$1(raw)) {
      return { ok: false, manifest: null, issues: [{ path: "$", message: "清单必须是 JSON 对象", severity: "error" }] };
    }
    const id = requireString(issues, raw, "id", "$", 64);
    if (id && !ID_RE.test(id)) issue(issues, "$.id", "id 只能包含字母、数字、点、下划线、短横线，长度 3-64");
    const name = requireString(issues, raw, "name", "$", 40);
    const version = requireString(issues, raw, "version", "$", 32);
    if (version && !parseVersion(version)) issue(issues, "$.version", "version 必须是 x.y.z 形式");
    const apiVersion = raw.apiVersion == null ? CORE_API_VERSION : String(raw.apiVersion);
    if (apiVersion !== CORE_API_VERSION) {
      issue(issues, "$.apiVersion", `当前内核只支持 apiVersion ${CORE_API_VERSION}，清单声明的是 ${apiVersion}`);
    }
    let engineRange = ">=0.10.0 <1.0.0";
    if (raw.engines != null) {
      if (!isPlainObject$1(raw.engines)) issue(issues, "$.engines", "必须是对象");
      else if (raw.engines.xhgcs != null) engineRange = String(raw.engines.xhgcs);
    }
    if (!isValidRange(engineRange)) {
      issue(issues, "$.engines.xhgcs", `不是合法的版本区间：${engineRange}`);
    } else if (!satisfies(CORE_VERSION, engineRange)) {
      issue(issues, "$.engines.xhgcs", `内核版本 ${CORE_VERSION} 不满足声明范围 ${engineRange}`, "warning");
    }
    let main = "inline";
    if (raw.main != null) {
      if (typeof raw.main !== "string" || !raw.main.trim()) issue(issues, "$.main", "必须是字符串");
      else {
        main = raw.main.trim();
        if (main !== "inline" && !/\.js$/i.test(main)) issue(issues, "$.main", "入口文件必须是 .js");
        if (main !== "inline" && /(^|[/\\])\.\.([/\\]|$)/.test(main)) issue(issues, "$.main", "入口不允许使用上级目录 ..");
        if (main !== "inline" && isCrossOrigin(main)) issue(issues, "$.main", "入口不允许使用跨源地址");
      }
    }
    const inlineScript = typeof raw.inlineScript === "string" ? raw.inlineScript : void 0;
    if (main === "inline" && !inlineScript) {
      issue(issues, "$.inlineScript", "main 为 inline 时必须给出 inlineScript");
    }
    const activationEvents = [];
    if (raw.activationEvents != null) {
      if (!Array.isArray(raw.activationEvents)) issue(issues, "$.activationEvents", "必须是数组");
      else {
        asArray(raw.activationEvents).forEach((event, index) => {
          const spec = parseActivationEvent(String(event));
          if (!spec) issue(issues, `$.activationEvents[${index}]`, `无法识别的激活事件 "${String(event)}"`);
          else activationEvents.push(spec.raw);
        });
      }
    }
    if (!activationEvents.length) activationEvents.push("onStartup");
    const dependencies = [];
    if (raw.dependencies != null) {
      if (!Array.isArray(raw.dependencies)) issue(issues, "$.dependencies", "必须是数组");
      else {
        asArray(raw.dependencies).forEach((dep, index) => {
          if (typeof dep !== "string" || !dep.trim()) issue(issues, `$.dependencies[${index}]`, "必须是字符串");
          else dependencies.push(dep.trim());
        });
      }
    }
    const permissions = [];
    if (raw.permissions != null) {
      if (!Array.isArray(raw.permissions)) issue(issues, "$.permissions", "必须是数组");
      else {
        asArray(raw.permissions).forEach((permission, index) => {
          const text = String(permission);
          if (!KNOWN_PERMISSIONS.includes(text)) {
            issue(issues, `$.permissions[${index}]`, `未知权限 "${text}"`);
            return;
          }
          permissions.push(text);
        });
      }
    }
    const contributesRaw = isPlainObject$1(raw.contributes) ? raw.contributes : {};
    if (raw.contributes != null && !isPlainObject$1(raw.contributes)) {
      issue(issues, "$.contributes", "必须是对象");
    }
    const contributes = {
      commands: validateCommands(issues, contributesRaw.commands),
      menus: validateMenus(issues, contributesRaw.menus),
      keybindings: validateKeybindings(issues, contributesRaw.keybindings),
      views: validateViews(issues, contributesRaw.views),
      statusBar: validateStatusBar(issues, contributesRaw.statusBar),
      configuration: validateConfiguration(issues, contributesRaw.configuration),
      designerWidgets: validateDesignerWidgets(issues, contributesRaw.designerWidgets),
      themes: validateGenericList(issues, contributesRaw.themes, "themes", ["id", "label"]) ?? void 0,
      protocols: validateGenericList(issues, contributesRaw.protocols, "protocols", ["id", "label"]) ?? void 0,
      operators: validateGenericList(issues, contributesRaw.operators, "operators", ["id", "label"]) ?? void 0,
      dataSources: validateGenericList(issues, contributesRaw.dataSources, "dataSources", ["id", "label"]) ?? void 0,
      aiTools: validateGenericList(issues, contributesRaw.aiTools, "aiTools", ["name", "description"]) ?? void 0
    };
    const errors = issues.filter((item) => item.severity === "error");
    if (errors.length) return { ok: false, manifest: null, issues };
    const manifest = {
      id,
      name,
      version,
      publisher: typeof raw.publisher === "string" ? raw.publisher : "local",
      description: typeof raw.description === "string" ? raw.description : "",
      apiVersion,
      engines: { xhgcs: engineRange },
      main,
      inlineScript,
      activationEvents,
      dependencies,
      permissions,
      contributes
    };
    return { ok: true, manifest, issues };
  }
  function parseDependency(text) {
    const raw = String(text || "").trim();
    const at = raw.indexOf("@", 1);
    if (at < 0) return { id: raw, range: "*" };
    return { id: raw.slice(0, at), range: raw.slice(at + 1) || "*" };
  }
  const TONES = {
    default: "var(--fg-2, #9aa4b2)",
    info: "var(--accent, #4c9aff)",
    warn: "var(--warn, #f5a623)",
    error: "var(--danger, #ff5c5c)",
    ok: "var(--ok, #34d399)"
  };
  const STYLE_ID$6 = "xhgcs-core-style";
  function ensureStyles$4() {
    if (document.getElementById(STYLE_ID$6)) return;
    const style = document.createElement("style");
    style.id = STYLE_ID$6;
    style.textContent = `
.xhgcs-sb{display:inline-flex;align-items:center;gap:6px;height:20px;padding:0 6px;border:0;border-radius:6px;
  background:transparent;color:var(--fg-2,var(--text-dim));font:inherit;font-size:11px;line-height:1;font-variant-numeric:tabular-nums;
  cursor:default;white-space:nowrap;opacity:1;transition:background .12s ease,color .12s ease}
.xhgcs-sb[data-clickable="1"]{cursor:pointer}
.xhgcs-sb[data-clickable="1"]:hover{background:var(--hover,rgba(255,255,255,.08));color:var(--fg,#e8eef7)}
.xhgcs-sb[data-tone="info"]{color:var(--accent,#4c9aff)}
.xhgcs-sb[data-tone="warn"]{color:var(--warn,#f5a623)}
.xhgcs-sb[data-tone="error"]{color:var(--danger,#ff5c5c)}
.xhgcs-sb[data-tone="ok"]{color:var(--ok,#34d399)}
.xhgcs-sb-dot{width:4px;height:4px;border-radius:50%;background:currentColor;opacity:.6}
.xhgcs-sb-wrap{display:flex;align-items:center;gap:2px;min-width:0}
.xhgcs-sb-spacer{flex:1 1 auto;min-width:8px}
`;
    document.head.appendChild(style);
  }
  class StatusBarService {
    constructor() {
      this.items = /* @__PURE__ */ new Map();
      this.onChange = new Emitter();
      this.container = null;
      this.left = null;
      this.right = null;
      this.getContext = () => ({});
    }
    setContextProvider(provider) {
      this.getContext = provider;
    }
    onDidChange(listener) {
      return this.onChange.on(listener);
    }
    add(owner, contribution) {
      const key = `${owner}:${contribution.id}`;
      this.items.set(key, { ...contribution, owner, visible: true });
      this.render();
      return {
        dispose: () => {
          this.items.delete(key);
          this.render();
        }
      };
    }
    update(owner, id, patch) {
      const key = `${owner}:${id}`;
      const current = this.items.get(key);
      if (!current) return;
      this.items.set(key, { ...current, ...patch });
      this.render();
    }
    remove(owner, id) {
      this.items.delete(`${owner}:${id}`);
      this.render();
    }
    /** 挂到一个宿主元素上（core 启动时调用一次）。 */
    attach(host2) {
      if (this.container) return;
      ensureStyles$4();
      const wrap = document.createElement("div");
      wrap.className = "xhgcs-sb-wrap";
      wrap.dataset.role = "xhgcs-statusbar";
      const left = document.createElement("div");
      left.className = "xhgcs-sb-wrap";
      left.dataset.align = "left";
      const spacer = document.createElement("div");
      spacer.className = "xhgcs-sb-spacer";
      const right = document.createElement("div");
      right.className = "xhgcs-sb-wrap";
      right.dataset.align = "right";
      wrap.append(left, spacer, right);
      host2.appendChild(wrap);
      this.container = wrap;
      this.left = left;
      this.right = right;
      this.render();
    }
    detach() {
      this.container?.remove();
      this.container = null;
      this.left = null;
      this.right = null;
    }
    render() {
      if (!this.container || !this.left || !this.right) return;
      const context = this.getContext();
      const visible = Array.from(this.items.values()).filter((item) => evaluateWhen(item.when, context)).sort((a, b) => (a.priority ?? 100) - (b.priority ?? 100));
      this.left.replaceChildren(...visible.filter((item) => item.alignment === "left").map((item) => this.build(item)));
      this.right.replaceChildren(...visible.filter((item) => item.alignment !== "left").map((item) => this.build(item)));
      this.container.hidden = visible.length === 0;
      this.onChange.emit();
    }
    build(item) {
      const el = document.createElement("button");
      el.type = "button";
      el.className = "xhgcs-sb";
      el.dataset.tone = item.tone || "default";
      el.dataset.clickable = item.command ? "1" : "0";
      el.title = item.tooltip || (item.command ? `执行 ${item.command}` : item.text);
      if (item.command) {
        el.addEventListener("click", () => {
          executeCommand(item.command).catch((err) => console.warn("[XHGCS_CORE] 状态栏命令失败", err));
        });
      }
      const dot = document.createElement("span");
      dot.className = "xhgcs-sb-dot";
      const text = document.createElement("span");
      text.textContent = item.text || "";
      el.append(dot, text);
      return el;
    }
    /** 暴露给测试：当前可见项 */
    snapshot() {
      return Array.from(this.items.values()).map((item) => ({ id: item.id, text: item.text, owner: item.owner }));
    }
    get tones() {
      return TONES;
    }
  }
  const statusBar = new StatusBarService();
  class ProtocolRegistry {
    constructor() {
      this.entries = /* @__PURE__ */ new Map();
    }
    register(owner, adapter) {
      if (!adapter || !adapter.id) throw new Error("协议适配器缺少 id");
      const existing = this.entries.get(adapter.id);
      if (existing && existing.owner !== owner) {
        throw new Error(`协议 ${adapter.id} 已被扩展 ${existing.owner} 注册`);
      }
      this.entries.set(adapter.id, { owner, adapter });
      return {
        dispose: () => {
          const current = this.entries.get(adapter.id);
          if (current && current.owner === owner) this.entries.delete(adapter.id);
        }
      };
    }
    removeOwner(owner) {
      for (const [id, entry] of Array.from(this.entries)) {
        if (entry.owner === owner) this.entries.delete(id);
      }
    }
    list() {
      return Array.from(this.entries.values()).map((entry) => entry.adapter);
    }
    get(id) {
      return this.entries.get(id)?.adapter;
    }
    claim(engine2) {
      const protocol = String(engine2 && engine2.protocol || "").toUpperCase();
      return this.list().filter((adapter) => {
        const owned = adapter.protocols;
        return Array.isArray(owned) && owned.length ? owned.map((value) => String(value).toUpperCase()).includes(protocol) : false;
      });
    }
    /** 单帧解码：命中插件协议返回结果，否则返回 null 交给老代码。 */
    decode(engine2, raw) {
      for (const adapter of this.claim(engine2)) {
        try {
          const result = adapter.decode(engine2, raw);
          if (result) return result;
        } catch (err) {
          console.warn(`[XHGCS_CORE] 协议 ${adapter.id} 解码失败`, err);
          return { ok: false, values: {}, error: String(err instanceof Error ? err.message : err) };
        }
      }
      return null;
    }
    /** 字节流分帧：只有声明了 protocols 的插件协议才会走到这里。 */
    ingest(engine2, bytes) {
      for (const adapter of this.claim(engine2)) {
        if (!adapter.ingest) continue;
        try {
          const result = adapter.ingest(engine2, bytes);
          if (result) return result;
        } catch (err) {
          console.warn(`[XHGCS_CORE] 协议 ${adapter.id} 分帧失败`, err);
          return { frames: [] };
        }
      }
      return null;
    }
    encode(engine2, values) {
      for (const adapter of this.claim(engine2)) {
        if (!adapter.encode) continue;
        try {
          const result = adapter.encode(engine2, values);
          if (result) return result;
        } catch (err) {
          console.warn(`[XHGCS_CORE] 协议 ${adapter.id} 编码失败`, err);
        }
      }
      return null;
    }
    definitions(engine2) {
      for (const adapter of this.claim(engine2)) {
        if (!adapter.definitions) continue;
        const result = adapter.definitions(engine2);
        if (result && result.length) return result;
      }
      return [];
    }
  }
  const protocols = new ProtocolRegistry();
  function wedAdapter() {
    const legacy = () => window.XHGCS_PROTOCOL;
    return {
      id: "builtin.wed",
      label: "WED 飞控帧",
      protocols: ["WED"],
      decode(engine2, raw) {
        const api = legacy();
        if (!api || typeof api.decodeFrame !== "function") return null;
        return api.decodeFrame(raw, engine2);
      },
      encode(engine2, values) {
        const api = legacy();
        if (!api || typeof api.encode !== "function") return null;
        return api.encode(values, engine2);
      },
      definitions(engine2) {
        const api = legacy();
        if (!api || typeof api.definitions !== "function") return [];
        return api.definitions(engine2);
      }
    };
  }
  class OperatorRegistry {
    constructor() {
      this.entries = /* @__PURE__ */ new Map();
    }
    register(owner, impl) {
      if (!impl || !impl.id) throw new Error("算子缺少 id");
      const existing = this.entries.get(impl.id);
      if (existing && existing.owner !== owner) throw new Error(`算子 ${impl.id} 已被扩展 ${existing.owner} 注册`);
      this.entries.set(impl.id, { owner, impl });
      return {
        dispose: () => {
          const current = this.entries.get(impl.id);
          if (current && current.owner === owner) this.entries.delete(impl.id);
        }
      };
    }
    removeOwner(owner) {
      for (const [id, entry] of Array.from(this.entries)) {
        if (entry.owner === owner) this.entries.delete(id);
      }
    }
    get(id) {
      return this.entries.get(id)?.impl;
    }
    list() {
      return Array.from(this.entries.values()).map((entry) => entry.impl);
    }
    /** 命中插件算子就执行并返回结果，否则 null 让老代码继续。 */
    async run(node, context) {
      const type = String(node.type || "");
      const impl = this.entries.get(type)?.impl;
      if (!impl) return null;
      try {
        return await impl.run({ ...context, node });
      } catch (err) {
        throw new Error(`算子 ${type} 执行失败：${err instanceof Error ? err.message : String(err)}`);
      }
    }
  }
  const operators = new OperatorRegistry();
  class FrameRecorder {
    constructor(capacity = 6e3) {
      this.capacity = capacity;
      this.frames = [];
    }
    push(frame) {
      this.frames.push(frame);
      if (this.frames.length > this.capacity) {
        this.frames.splice(0, this.frames.length - this.capacity);
      }
    }
    clear() {
      this.frames.length = 0;
    }
    get size() {
      return this.frames.length;
    }
    snapshot() {
      return this.frames.map((frame) => ({ ...frame, values: { ...frame.values } }));
    }
    sink(id = "builtin.record", label = "内存录制") {
      return { id, label, write: (frame) => this.push(frame) };
    }
  }
  const DEFAULT_CAPACITY = 4096;
  const DEFAULT_BUDGET_MS = 8;
  class PipelineRuntime {
    constructor() {
      this.queue = [];
      this.operators = /* @__PURE__ */ new Map();
      this.sinks = /* @__PURE__ */ new Map();
      this.sources = /* @__PURE__ */ new Map();
      this.runningSources = /* @__PURE__ */ new Set();
      this.enabledOperators = /* @__PURE__ */ new Set();
      this.enabledSinks = /* @__PURE__ */ new Set();
      this.frameHandle = null;
      this.running = false;
      this.capacity = DEFAULT_CAPACITY;
      this.budgetMs = DEFAULT_BUDGET_MS;
      this.processed = 0;
      this.dropped = 0;
      this.errors = 0;
      this.lastFrameAt = 0;
      this.lastT = 0;
      this.peakQueue = 0;
      this.latencyAccum = 0;
      this.latencyCount = 0;
      this.onMetrics = /* @__PURE__ */ new Set();
      this.recentErrors = [];
      this.operatorParams = /* @__PURE__ */ new Map();
      this.onParamsChange = /* @__PURE__ */ new Set();
    }
    // ===== 注册 =====
    registerOperator(owner, operator) {
      if (!operator || !operator.id) throw new Error("管线算子缺少 id");
      const existing = this.operators.get(operator.id);
      if (existing && existing.owner !== owner) throw new Error(`管线算子 ${operator.id} 已被 ${existing.owner} 占用`);
      this.operators.set(operator.id, { owner, value: operator });
      this.enabledOperators.add(operator.id);
      if (operator.params && operator.params.length && operator.configure) {
        try {
          operator.configure(this.operatorParamValues(operator.id));
        } catch (err) {
          this.recordError(operator.id, err);
        }
      }
      return {
        dispose: () => {
          const current = this.operators.get(operator.id);
          if (current && current.owner === owner) {
            this.operators.delete(operator.id);
            this.enabledOperators.delete(operator.id);
          }
        }
      };
    }
    registerSink(owner, sink) {
      if (!sink || !sink.id) throw new Error("管线端点缺少 id");
      const existing = this.sinks.get(sink.id);
      if (existing && existing.owner !== owner) throw new Error(`管线端点 ${sink.id} 已被 ${existing.owner} 占用`);
      this.sinks.set(sink.id, { owner, value: sink });
      this.enabledSinks.add(sink.id);
      return {
        dispose: () => {
          const current = this.sinks.get(sink.id);
          if (current && current.owner === owner) {
            this.sinks.delete(sink.id);
            this.enabledSinks.delete(sink.id);
          }
        }
      };
    }
    registerSource(owner, source) {
      if (!source || !source.id) throw new Error("数据源缺少 id");
      const existing = this.sources.get(source.id);
      if (existing && existing.owner !== owner) throw new Error(`数据源 ${source.id} 已被 ${existing.owner} 占用`);
      this.sources.set(source.id, { owner, value: source });
      return {
        dispose: () => {
          const current = this.sources.get(source.id);
          if (!current || current.owner !== owner) return;
          this.stopSource(source.id);
          this.sources.delete(source.id);
        }
      };
    }
    sourceList() {
      return Array.from(this.sources.values()).map((entry) => entry.value);
    }
    isSourceRunning(id) {
      return this.runningSources.has(id);
    }
    startSource(id) {
      const entry = this.sources.get(id);
      if (!entry) return false;
      if (this.runningSources.has(id)) return true;
      try {
        entry.value.start((frame) => this.ingest(frame));
        this.runningSources.add(id);
        this.start();
        return true;
      } catch (err) {
        this.recordError(id, err);
        return false;
      }
    }
    stopSource(id) {
      const entry = this.sources.get(id);
      if (!entry) return;
      try {
        entry.value.stop();
      } catch (err) {
        this.recordError(id, err);
      }
      this.runningSources.delete(id);
    }
    removeOwner(owner) {
      for (const [id, entry] of Array.from(this.sources)) {
        if (entry.owner === owner) {
          this.stopSource(id);
          this.sources.delete(id);
        }
      }
      for (const [id, entry] of Array.from(this.operators)) if (entry.owner === owner) this.operators.delete(id);
      for (const [id, entry] of Array.from(this.sinks)) if (entry.owner === owner) this.sinks.delete(id);
    }
    setOperatorEnabled(id, enabled) {
      if (!this.operators.has(id)) return;
      if (enabled) this.enabledOperators.add(id);
      else this.enabledOperators.delete(id);
    }
    isOperatorEnabled(id) {
      return this.enabledOperators.has(id);
    }
    setSinkEnabled(id, enabled) {
      if (!this.sinks.has(id)) return;
      if (enabled) this.enabledSinks.add(id);
      else this.enabledSinks.delete(id);
    }
    operatorList() {
      return Array.from(this.operators.values()).map((entry) => entry.value).sort((a, b) => (a.order ?? 100) - (b.order ?? 100));
    }
    sinkList() {
      return Array.from(this.sinks.values()).map((entry) => entry.value);
    }
    // ===== 运行 =====
    start() {
      if (this.running) return;
      this.running = true;
      this.schedule();
    }
    stop() {
      this.running = false;
      if (this.frameHandle != null) {
        window.cancelAnimationFrame(this.frameHandle);
        this.frameHandle = null;
      }
    }
    /** 入队。满了就丢最老的 —— 实时数据里“旧帧”永远比“新帧”廉价。 */
    ingest(frame) {
      if (!frame || !frame.values) return;
      if (this.queue.length >= this.capacity) {
        this.queue.shift();
        this.dropped += 1;
      }
      this.queue.push(frame);
      if (this.queue.length > this.peakQueue) this.peakQueue = this.queue.length;
      if (!this.running) this.start();
    }
    schedule() {
      if (!this.running || this.frameHandle != null) return;
      this.frameHandle = window.requestAnimationFrame(() => {
        this.frameHandle = null;
        this.drain();
        this.schedule();
      });
    }
    drain() {
      if (!this.queue.length) return;
      const started = performance.now();
      const operators2 = this.operatorList().filter((operator) => this.enabledOperators.has(operator.id));
      const sinks = this.sinkList().filter((sink) => this.enabledSinks.has(sink.id));
      let guard = 0;
      while (this.queue.length && performance.now() - started < this.budgetMs) {
        const frame = this.queue.shift();
        const frameStart = performance.now();
        let current = frame;
        for (const operator of operators2) {
          if (!current) break;
          const before = current;
          try {
            current = operator.process(current);
          } catch (err) {
            this.recordError(operator.id, err);
            current = before;
          }
        }
        if (current) {
          for (const sink of sinks) {
            try {
              sink.write(current);
            } catch (err) {
              this.recordError(sink.id, err);
            }
          }
          this.processed += 1;
          this.lastT = current.t;
          this.lastFrameAt = Date.now();
          this.latencyAccum += performance.now() - frameStart;
          this.latencyCount += 1;
        }
        guard += 1;
        if (guard > 2e4) break;
      }
      this.onMetrics.forEach((listener) => {
        try {
          listener(this.metrics());
        } catch {
        }
      });
    }
    recordError(id, err) {
      this.errors += 1;
      const message = err instanceof Error ? err.message : String(err);
      this.recentErrors.push({ id, message, at: Date.now() });
      if (this.recentErrors.length > 20) this.recentErrors.shift();
      console.warn(`[XHGCS_ENGINE] ${id} 处理失败`, err);
    }
    metrics() {
      return {
        queued: this.queue.length,
        capacity: this.capacity,
        processed: this.processed,
        dropped: this.dropped,
        errors: this.errors,
        lastFrameAt: this.lastFrameAt,
        lastT: this.lastT,
        avgLatencyMs: this.latencyCount ? this.latencyAvg() : 0,
        peakQueue: this.peakQueue,
        operators: this.operatorList().filter((operator) => this.enabledOperators.has(operator.id)).map((operator) => operator.id),
        sinks: this.sinkList().filter((sink) => this.enabledSinks.has(sink.id)).map((sink) => sink.id),
        sources: this.sourceList().map((source) => ({
          id: source.id,
          label: source.label,
          running: this.runningSources.has(source.id)
        })),
        running: this.running
      };
    }
    latencyAvg() {
      const avg = this.latencyAccum / Math.max(1, this.latencyCount);
      this.latencyAccum = this.latencyAccum * 0.9;
      this.latencyCount = Math.max(1, this.latencyCount * 0.9);
      return avg;
    }
    recentErrorList() {
      return this.recentErrors.slice(-5).reverse();
    }
    onMetricsChange(listener) {
      this.onMetrics.add(listener);
      return () => this.onMetrics.delete(listener);
    }
    resetCounters() {
      this.processed = 0;
      this.dropped = 0;
      this.errors = 0;
      this.peakQueue = this.queue.length;
      this.latencyAccum = 0;
      this.latencyCount = 0;
    }
    setCapacity(bytes) {
      this.capacity = Math.max(16, Math.min(1 << 20, Math.round(bytes) || DEFAULT_CAPACITY));
    }
    setBudget(ms) {
      this.budgetMs = Math.max(1, Math.min(64, Number(ms) || DEFAULT_BUDGET_MS));
    }
    /** 当前生效的参数值（默认值 + 用户改过的）。 */
    operatorParamValues(id) {
      const operator = this.operators.get(id)?.value;
      const out = {};
      for (const spec of operator?.params || []) out[spec.key] = spec.default;
      return { ...out, ...this.operatorParams.get(id) || {} };
    }
    /** 改参数：立即 configure 生效，并通知订阅者（持久化/面板刷新走这条）。 */
    setOperatorParams(id, patch) {
      const entry = this.operators.get(id);
      if (!entry) return {};
      const next = { ...this.operatorParamValues(id), ...patch };
      this.operatorParams.set(id, next);
      try {
        entry.value.configure?.(next);
      } catch (err) {
        this.recordError(id, err);
      }
      this.onParamsChange.forEach((listener) => {
        try {
          listener(id, next);
        } catch {
        }
      });
      return next;
    }
    onOperatorParamsChange(listener) {
      this.onParamsChange.add(listener);
      return () => this.onParamsChange.delete(listener);
    }
    get queueDepth() {
      return this.queue.length;
    }
  }
  const pipeline = new PipelineRuntime();
  function passthrough() {
    return { id: "builtin.pass", label: "直通", order: 0, process: (frame) => frame };
  }
  function scaleOperator() {
    let channel = "";
    let k = 1;
    let b = 0;
    return {
      id: "builtin.scale",
      label: "线性缩放",
      order: 10,
      params: [
        { key: "channel", label: "通道 id", type: "text", default: "", help: "留空则直接跳过" },
        { key: "k", label: "系数 k", type: "number", default: 1, step: 0.1 },
        { key: "b", label: "偏移 b", type: "number", default: 0, step: 0.1 }
      ],
      configure(values) {
        channel = String(values.channel || "").trim();
        const nextK = Number(values.k);
        const nextB = Number(values.b);
        k = Number.isFinite(nextK) ? nextK : 1;
        b = Number.isFinite(nextB) ? nextB : 0;
      },
      process(frame) {
        if (!channel) return frame;
        const value = frame.values[channel];
        if (typeof value !== "number") return frame;
        return { ...frame, values: { ...frame.values, [channel]: value * k + b } };
      }
    };
  }
  function lowpassOperator() {
    const state = /* @__PURE__ */ new Map();
    let alpha = 0.25;
    return {
      id: "builtin.lowpass",
      label: "一阶低通",
      order: 20,
      params: [{ key: "alpha", label: "α（越小越平滑）", type: "number", default: 0.25, min: 1e-3, max: 1, step: 0.01 }],
      configure(values) {
        const next = Number(values.alpha);
        if (Number.isFinite(next)) alpha = Math.max(1e-3, Math.min(1, next));
      },
      process(frame) {
        const values = { ...frame.values };
        for (const key of Object.keys(values)) {
          const raw = values[key];
          if (typeof raw !== "number") continue;
          const prev = state.get(key);
          const next = prev == null ? raw : prev + alpha * (raw - prev);
          state.set(key, next);
          values[key] = next;
        }
        return { ...frame, values };
      },
      reset: () => state.clear()
    };
  }
  function windowMeanOperator() {
    const buffers = /* @__PURE__ */ new Map();
    let channel = "";
    let size = 10;
    return {
      id: "builtin.mean",
      label: "滑动均值",
      order: 30,
      params: [
        { key: "channel", label: "通道 id", type: "text", default: "", help: "留空则直接跳过" },
        { key: "size", label: "窗口点数", type: "number", default: 10, min: 2, max: 2e3, step: 1 }
      ],
      configure(values) {
        channel = String(values.channel || "").trim();
        const next = Number(values.size);
        size = Number.isFinite(next) ? Math.max(2, Math.min(2e3, Math.round(next))) : 10;
      },
      process(frame) {
        if (!channel) return frame;
        const raw = frame.values[channel];
        if (typeof raw !== "number") return frame;
        let buffer = buffers.get(channel);
        if (!buffer) {
          buffer = [];
          buffers.set(channel, buffer);
        }
        buffer.push(raw);
        while (buffer.length > size) buffer.shift();
        const sum = buffer.reduce((acc, value) => acc + value, 0);
        return { ...frame, values: { ...frame.values, [channel]: sum / buffer.length } };
      },
      reset: () => buffers.clear()
    };
  }
  function thresholdOperator() {
    let channel = "";
    let min = 0;
    let max = 0;
    return {
      id: "builtin.threshold",
      label: "阈值标记",
      order: 40,
      params: [
        { key: "channel", label: "通道 id", type: "text", default: "" },
        { key: "min", label: "下限", type: "number", default: 0, step: 1 },
        { key: "max", label: "上限", type: "number", default: 100, step: 1 }
      ],
      configure(values) {
        channel = String(values.channel || "").trim();
        min = Number.isFinite(Number(values.min)) ? Number(values.min) : 0;
        max = Number.isFinite(Number(values.max)) ? Number(values.max) : 100;
      },
      process(frame) {
        if (!channel) return frame;
        const value = frame.values[channel];
        if (typeof value !== "number") return frame;
        if (value < min || value > max) {
          const frames = frame;
          frames.flags = (frames.flags || []).concat(`${channel}:${value}`);
        }
        return frame;
      }
    };
  }
  function metricsSink(onWrite) {
    return {
      id: "builtin.metrics",
      label: "指标",
      write(frame) {
        onWrite?.(frame);
      }
    };
  }
  function channelSink(mapping) {
    return {
      id: "builtin.channels",
      label: "写回通道",
      write(frame) {
        const legacy = window.XHGCS;
        if (!legacy || !legacy.state || typeof legacy.pushSample !== "function") return;
        for (const [key, value] of Object.entries(frame.values)) {
          const targetId = mapping?.[key] || key;
          const channel = (legacy.state.channels || []).find((item) => item.id === targetId);
          if (channel) legacy.pushSample(channel, value);
        }
      }
    };
  }
  function collect(values, list) {
    if (!Array.isArray(list)) return 0;
    let count = 0;
    for (let i = 0; i < list.length; i++) {
      const channel = list[i];
      const data = channel && channel.data;
      if (!data || !data.length) continue;
      const last = data[data.length - 1];
      if (typeof last === "number" && Number.isFinite(last)) {
        values[channel.id] = last;
        count += 1;
      }
    }
    return count;
  }
  function frameFromSample(event) {
    const detail = event.detail || {};
    const state = window.XHGCS?.state;
    if (!state) return null;
    const values = {};
    const raw = collect(values, state.channels);
    const scripts = collect(values, state.scriptChannels);
    if (!raw && !scripts) return null;
    const frame = {
      t: Number(detail.t) || 0,
      wall: Number(detail.wall) || Date.now(),
      source: String(detail.source || "sample"),
      values
    };
    if (Array.isArray(detail.filled) && detail.filled.length) frame.filled = detail.filled.slice();
    return frame;
  }
  function legacySampleSource() {
    let handler = null;
    return {
      id: "builtin.legacy-sample",
      label: "主数据链采样",
      start(emit) {
        if (handler) return;
        handler = (event) => {
          const frame = frameFromSample(event);
          if (frame) emit(frame);
        };
        window.addEventListener("xhgcs:sample", handler);
      },
      stop() {
        if (!handler) return;
        window.removeEventListener("xhgcs:sample", handler);
        handler = null;
      }
    };
  }
  function replaySource(recorder2, options = {}) {
    let timer = null;
    let stopped = false;
    const speed = Math.max(0.1, Math.min(32, Number(options.speed) || 4));
    const clear = () => {
      if (timer != null) {
        window.clearTimeout(timer);
        timer = null;
      }
    };
    return {
      id: "builtin.replay",
      label: `回放（内存 ×${speed}）`,
      start(emit) {
        const frames = recorder2.snapshot();
        if (!frames.length) throw new Error("没有可回放的帧：先打开「内存录制」端点");
        stopped = false;
        let index = 0;
        const tick = () => {
          if (stopped) return;
          if (index >= frames.length) {
            if (!options.loop) {
              stopped = true;
              return;
            }
            index = 0;
          }
          const frame = frames[index];
          index += 1;
          emit({ ...frame, wall: Date.now(), source: "replay" });
          const next = frames[index];
          const rawGap = next ? Math.max(8, next.wall - frame.wall) : 120;
          const gap = Math.max(options.minGapMs == null ? 16 : options.minGapMs, Math.round(rawGap / speed));
          timer = window.setTimeout(tick, Math.min(1e3, gap));
        };
        tick();
      },
      stop() {
        stopped = true;
        clear();
      }
    };
  }
  function attachLegacySampleSource(target) {
    const source = legacySampleSource();
    const handle = target.registerSource("xihe.core", source);
    target.startSource(source.id);
    return () => handle.dispose();
  }
  const recorder = new FrameRecorder(6e3);
  const PIPELINE_PARAMS_KEY = "xhgcs.pipeline.params.v1";
  function readPipelineParams() {
    try {
      const raw = localStorage.getItem(PIPELINE_PARAMS_KEY);
      const parsed = raw ? JSON.parse(raw) : null;
      return parsed && typeof parsed === "object" ? parsed : {};
    } catch {
      return {};
    }
  }
  function bindPipelineParamPersistence() {
    const stored = readPipelineParams();
    for (const [id, values] of Object.entries(stored)) {
      if (values && typeof values === "object") pipeline.setOperatorParams(id, values);
    }
    pipeline.onOperatorParamsChange((id, values) => {
      const all = readPipelineParams();
      all[id] = values;
      try {
        localStorage.setItem(PIPELINE_PARAMS_KEY, JSON.stringify(all));
      } catch (err) {
        console.warn("[XHGCS_ENGINE] 管线参数保存失败", err);
      }
    });
  }
  function replay(options) {
    return replaySource(recorder, options);
  }
  const engine = {
    protocols,
    operators,
    pipeline,
    recorder,
    /** 参考实现：把内置 WED 包装成适配器，插件可以据此写自己的二进制协议 */
    wedAdapter,
    /** 内置阶段工厂：插件也可以照着写自己的 */
    stages: {
      passthrough,
      scale: scaleOperator,
      lowpass: lowpassOperator,
      windowMean: windowMeanOperator,
      threshold: thresholdOperator,
      metricsSink,
      channelSink
    },
    sources: {
      legacySample: legacySampleSource,
      replay,
      attachLegacy: attachLegacySampleSource
    },
    attachLegacySampleSource
  };
  function legacyState() {
    const state = window.XHGCS;
    return state && state.state ? state.state : null;
  }
  function readChannels(includeScript) {
    const state = legacyState();
    if (!state) return [];
    const raw = Array.isArray(state.channels) ? state.channels.slice() : [];
    if (includeScript && Array.isArray(state.scriptChannels)) raw.push(...state.scriptChannels);
    return raw;
  }
  function buildWhenContext() {
    const state = legacyState();
    const channels = readChannels(true);
    return {
      view: state?.view || "",
      subview: state?.subview || "",
      channelTab: state?.channelTab || "",
      theme: state?.theme || "",
      protocol: state?.protocol?.protocol || state?.protocol?.id || "",
      channelCount: channels.length,
      mcp: state?.mcp || { enabled: false, connected: false },
      simulation: Boolean(state?.simulation?.enabled),
      playing: Boolean(state?.playing),
      raws: true,
      extensionCount: 0
    };
  }
  function createExtensionApi(deps, manifest, store, grantedPermissions2) {
    const granted = new Set(grantedPermissions2 || manifest.permissions || []);
    const has = (permission) => granted.has(permission);
    const owner = manifest.id;
    const api = {
      version: CORE_API_VERSION,
      extension: {
        id: owner,
        version: manifest.version,
        path: `plugins/${owner}/`
      },
      env: {
        platform: deps.env ? "desktop-or-web" : "web",
        core: CORE_API_VERSION
      },
      log: (message, detail) => deps.env.log("info", `[${owner}] ${message}`, detail),
      when: (expression, context) => evaluateWhen(expression, { ...deps.getContext(), ...context || {} })
    };
    api.commands = {
      register(id, handler) {
        const disposable = registerCommand(owner, id, handler);
        store.add(disposable);
        return disposable;
      },
      execute: has("commands:execute") ? (id, ...args) => deps.commands.execute(id, ...args) : void 0
    };
    if (has("ui:statusBar")) {
      api.statusBar = {
        add(item) {
          const disposable = statusBar.add(owner, { tone: "default", ...item });
          store.add(disposable);
          return disposable;
        },
        update(id, patch) {
          statusBar.update(owner, id, patch);
        },
        remove(id) {
          statusBar.remove(owner, id);
        }
      };
    }
    if (has("ui:view")) {
      api.views = {
        register(id, implementation) {
          deps.host.runtime.views.set(`${owner}:${id}`, { owner, implementation });
          return {
            dispose: () => {
              deps.host.runtime.views.delete(`${owner}:${id}`);
            }
          };
        },
        get(id) {
          const hit = deps.host.runtime.views.get(`${owner}:${id}`);
          return hit?.implementation;
        }
      };
    }
    if (has("ui:panel")) {
      api.widgets = {
        register(id, implementation) {
          deps.host.runtime.widgets.set(`${owner}:${id}`, { owner, implementation });
        }
      };
    }
    if (has("data:read")) {
      api.data = {
        channels: () => readChannels(false).map((channel) => ({ id: channel.id, name: channel.name, unit: channel.unit || "", color: channel.color || "" })),
        latest(id) {
          const channel = readChannels(true).find((item) => item.id === id);
          const data = channel?.data;
          return data && data.length ? data[data.length - 1] : void 0;
        },
        series(id, limit = 200) {
          const channel = readChannels(true).find((item) => item.id === id);
          const data = channel?.data;
          if (!data) return [];
          const count = Math.max(0, Math.min(limit, data.length));
          return data.slice(data.length - count);
        },
        scriptChannels: () => readChannels(true).filter((channel) => channel.isScript).map((channel) => channel.id)
      };
    }
    if (has("data:write")) {
      api.dataWrite = {
        push(channelId, value) {
          const legacy = window.XHGCS;
          const channel = readChannels(true).find((item) => item.id === channelId);
          if (!channel || typeof legacy?.pushSample !== "function") return false;
          legacy.pushSample(channel, value);
          return true;
        }
      };
    }
    const config = scopedConfiguration(owner);
    if (has("config:read")) {
      api.config = {
        get: config.get,
        all: config.all,
        has: config.has,
        onDidChange: (listener) => {
          const disposable = config.onDidChange(listener);
          store.add(disposable);
          return disposable;
        },
        update: has("config:write") ? config.update : void 0
      };
    }
    if (has("storage:own")) {
      api.storage = {
        get: deps.storage.get,
        set: deps.storage.set,
        remove: deps.storage.remove,
        keys: deps.storage.keys
      };
    }
    if (has("ui:toast")) {
      api.toast = (message) => deps.env.toast(String(message));
    }
    api.ai = {
      registerTool(tool) {
        const key = `${owner}:${tool.name}`;
        deps.host.runtime.aiTools.set(key, { owner, tool });
        return {
          dispose: () => {
            deps.host.runtime.aiTools.delete(key);
          }
        };
      }
    };
    if (has("protocols:own")) {
      api.protocols = {
        register(adapter) {
          const disposable = protocols.register(owner, adapter);
          store.add(disposable);
          return disposable;
        },
        list: () => protocols.list().map((adapter) => ({ id: adapter.id, label: adapter.label }))
      };
    }
    if (has("operators:own")) {
      api.operators = {
        register(impl) {
          const disposable = operators.register(owner, impl);
          store.add(disposable);
          return disposable;
        },
        list: () => operators.list().map((impl) => ({ id: impl.id, label: impl.label }))
      };
    }
    if (has("pipeline:own")) {
      api.pipeline = {
        registerOperator(operator) {
          const disposable = pipeline.registerOperator(owner, operator);
          store.add({ dispose: disposable.dispose });
          return { dispose: disposable.dispose };
        },
        registerSink(sink) {
          const disposable = pipeline.registerSink(owner, sink);
          store.add({ dispose: disposable.dispose });
          return { dispose: disposable.dispose };
        },
        metrics: () => pipeline.metrics()
      };
    }
    if (has("network")) {
      api.net = {
        fetch: (...args) => fetch(...args)
      };
    }
    api.activation = {
      fire: (event, arg) => deps.activateOnEvent(event, arg)
    };
    return api;
  }
  const PREFIX = "xhgcs.ext.";
  const pendingWrites = /* @__PURE__ */ new Map();
  let flushTimer = null;
  function scheduleFlush() {
    if (flushTimer != null) return;
    flushTimer = window.setTimeout(() => {
      flushTimer = null;
      flushPending();
    }, 200);
  }
  function flushPending() {
    for (const [key, value] of pendingWrites) {
      try {
        localStorage.setItem(key, value);
      } catch (err) {
        console.warn("[XHGCS_CORE] 扩展存储写入失败", key, err);
      }
    }
    pendingWrites.clear();
  }
  if (typeof window !== "undefined") {
    window.addEventListener("pagehide", flushPending);
    document.addEventListener("visibilitychange", () => {
      if (document.visibilityState === "hidden") flushPending();
    });
  }
  function createStorage(owner) {
    const scope = `${PREFIX}${owner}.`;
    const read = (key) => {
      const full = scope + key;
      const queued = pendingWrites.get(full);
      if (queued != null) return queued;
      try {
        return localStorage.getItem(full);
      } catch {
        return null;
      }
    };
    return {
      get(key, fallback) {
        const raw = read(key);
        if (raw == null) return fallback;
        try {
          return JSON.parse(raw);
        } catch {
          return fallback;
        }
      },
      set(key, value) {
        try {
          pendingWrites.set(scope + key, JSON.stringify(value));
        } catch (err) {
          console.warn("[XHGCS_CORE] 扩展存储序列化失败", key, err);
          return;
        }
        scheduleFlush();
      },
      remove(key) {
        const full = scope + key;
        pendingWrites.delete(full);
        try {
          localStorage.removeItem(full);
        } catch {
        }
      },
      keys() {
        const out = [];
        try {
          for (let i = 0; i < localStorage.length; i++) {
            const key = localStorage.key(i);
            if (key && key.startsWith(scope)) out.push(key.slice(scope.length));
          }
        } catch {
        }
        for (const key of pendingWrites.keys()) {
          if (key.startsWith(scope)) {
            const short = key.slice(scope.length);
            if (!out.includes(short)) out.push(short);
          }
        }
        return out;
      },
      clear() {
        for (const key of this.keys()) this.remove(key);
      },
      flush: flushPending
    };
  }
  const CONSENT_KEY = "xhgcs.ext.consent.v1";
  const STATE_KEY = "xhgcs.ext.state.v1";
  const RISKY_PERMISSIONS = /* @__PURE__ */ new Set(["network", "fs:own", "data:write"]);
  function readJSON$1(key) {
    try {
      const raw = localStorage.getItem(key);
      return raw ? JSON.parse(raw) : null;
    } catch {
      return null;
    }
  }
  function writeJSON$1(key, value) {
    try {
      localStorage.setItem(key, JSON.stringify(value));
    } catch (err) {
      console.warn("[XHGCS_CONSENT] 写入失败", key, err);
    }
  }
  function fingerprintOf(manifest) {
    const permissions = (manifest.permissions || []).slice().sort().join(",");
    const entry = manifest.main || "inline";
    const body = manifest.main === "inline" ? String(manifest.inlineScript || "").length : "";
    return `${manifest.version}|${permissions}|${entry}|${body}`;
  }
  function loadConsent() {
    return readJSON$1(CONSENT_KEY) || {};
  }
  function isGranted(manifest) {
    const record = loadConsent()[manifest.id];
    return Boolean(record) && record.fingerprint === fingerprintOf(manifest);
  }
  function grantedPermissions(manifest) {
    const declared = manifest.permissions || [];
    if (!declared.length) return [];
    const record = loadConsent()[manifest.id];
    if (!record || record.fingerprint !== fingerprintOf(manifest)) return [];
    return declared.filter((permission) => record.granted.includes(permission));
  }
  function grant(manifest, permissions) {
    const map = loadConsent();
    const declared = new Set(manifest.permissions || []);
    map[manifest.id] = {
      fingerprint: fingerprintOf(manifest),
      granted: permissions.filter((permission) => declared.has(permission)),
      at: Date.now()
    };
    writeJSON$1(CONSENT_KEY, map);
  }
  function revoke(id) {
    const map = loadConsent();
    delete map[id];
    writeJSON$1(CONSENT_KEY, map);
  }
  function defaultGrant(manifest) {
    return (manifest.permissions || []).filter((permission) => !RISKY_PERMISSIONS.has(permission));
  }
  function loadState() {
    return readJSON$1(STATE_KEY) || {};
  }
  function setDisabled(id, disabled) {
    const map = loadState();
    map[id] = disabled ? "disabled" : "enabled";
    writeJSON$1(STATE_KEY, map);
  }
  function isDisabled(id) {
    return loadState()[id] === "disabled";
  }
  function createRuntimeRegistries() {
    return {
      views: /* @__PURE__ */ new Map(),
      widgets: /* @__PURE__ */ new Map(),
      protocols: /* @__PURE__ */ new Map(),
      operators: /* @__PURE__ */ new Map(),
      dataSources: /* @__PURE__ */ new Map(),
      aiTools: /* @__PURE__ */ new Map()
    };
  }
  const LOAD_TIMEOUT_MS = 12e3;
  function loadClassicScript(url) {
    return new Promise((resolve2, reject) => {
      const existing = document.querySelector(`script[data-xhgcs-ext="${url}"]`);
      if (existing) {
        resolve2();
        return;
      }
      const script = document.createElement("script");
      script.src = url;
      script.async = true;
      script.dataset.xhgcsExt = url;
      const timer = window.setTimeout(() => {
        cleanup();
        reject(new Error(`加载超时：${url}`));
      }, LOAD_TIMEOUT_MS);
      const cleanup = () => {
        window.clearTimeout(timer);
        script.onload = null;
        script.onerror = null;
      };
      script.onload = () => {
        cleanup();
        resolve2();
      };
      script.onerror = () => {
        cleanup();
        reject(new Error(`加载失败：${url}`));
      };
      document.head.appendChild(script);
    });
  }
  class ExtensionHost {
    constructor(env2, options = {}) {
      this.env = env2;
      this.runtime = createRuntimeRegistries();
      this.records = /* @__PURE__ */ new Map();
      this.onChange = new Emitter();
      this.keybindingDisposer = null;
      this.contextProvider = () => ({});
      this.started = false;
      this.registry = options.registry || registry;
    }
    onDidChange(listener) {
      return this.onChange.on(listener);
    }
    setContextProvider(provider) {
      this.contextProvider = provider;
    }
    getContext() {
      try {
        return this.contextProvider() || {};
      } catch {
        return {};
      }
    }
    list() {
      return Array.from(this.records.values());
    }
    get(extId) {
      return this.records.get(extId);
    }
    /** 发现：把清单读进来、校验、注册纯数据贡献。不执行任何插件代码。 */
    add(manifest, opts = {}) {
      const existing = this.records.get(manifest.id);
      if (existing) return existing;
      const issues = this.validateAgainstCore(manifest);
      const record = {
        manifest,
        status: "resolved",
        message: issues.join("；"),
        source: opts.source === "user" ? "user" : "bundled",
        activatedAt: 0,
        activatedBy: "",
        lastError: "",
        disposables: [],
        module: null,
        exports: null
      };
      record.disposables.push(createStorageDisposer(manifest.id));
      this.records.set(manifest.id, record);
      this.registerContributions(record);
      if (issues.length) {
        record.status = "degraded";
        this.emit(record);
      }
      return record;
    }
    /** 从 plugins/index.json 读取清单列表。index 里既可以直接内联清单，也可以给清单路径。 */
    async discover(indexUrl = "plugins/index.json") {
      let entries = [];
      try {
        const response = await fetch(indexUrl, { cache: "no-cache" });
        if (!response.ok) throw new Error(`HTTP ${response.status}`);
        const payload = await response.json();
        entries = Array.isArray(payload) ? payload : Array.isArray(payload?.extensions) ? payload.extensions : [];
      } catch (err) {
        if (!(err instanceof TypeError)) {
          console.info("[XHGCS_CORE] 未发现外部插件目录", indexUrl);
        }
        return [];
      }
      const out = [];
      for (const entry of entries) {
        try {
          const raw = await this.resolveEntry(entry, indexUrl);
          if (!raw) continue;
          const validation = validateManifest(raw);
          if (!validation.ok || !validation.manifest) {
            console.warn("[XHGCS_CORE] 清单校验失败", entry, validation.issues);
            continue;
          }
          out.push(this.add(validation.manifest, { source: indexUrl }));
        } catch (err) {
          console.warn("[XHGCS_CORE] 读取插件清单失败", entry, err);
        }
      }
      return out;
    }
    /**
     * 用户扩展目录（装机版）：由 Electron 主进程扫描并返回已改写好的清单，
     * 入口文件通过 /ext 路由提供。Web 模式下没有这个 API，直接跳过。
     */
    async discoverUserExtensions() {
      const desktop = window.XHGCS_DESKTOP;
      const list = desktop && desktop.extensions && desktop.extensions.list;
      if (typeof list !== "function") return [];
      let payload = null;
      try {
        payload = await list();
      } catch (err) {
        this.env.log("warn", "读取用户插件目录失败", err);
        return [];
      }
      const items = payload && Array.isArray(payload.items) ? payload.items : [];
      const out = [];
      for (const item of items) {
        if (!item) continue;
        if (item.error) {
          this.env.log("warn", `用户插件被拒绝：${item.error}`);
          continue;
        }
        const validation = validateManifest(item.manifest);
        if (!validation.ok || !validation.manifest) {
          this.env.log("warn", "用户插件清单校验失败", validation.issues);
          continue;
        }
        const manifest = validation.manifest;
        if (this.records.has(manifest.id)) {
          this.env.log("warn", `用户插件 id 与已加载扩展冲突，保留内置：${manifest.id}`);
          continue;
        }
        out.push(this.add(manifest, { source: "user" }));
      }
      return out;
    }
    async resolveEntry(entry, indexUrl) {
      if (!entry || typeof entry !== "object") return entry;
      const record = entry;
      if (typeof record.manifest === "string") {
        const base = new URL(indexUrl, location.href);
        const url = new URL(record.manifest, base).toString();
        const response = await fetch(url, { cache: "no-cache" });
        if (!response.ok) throw new Error(`HTTP ${response.status} ${url}`);
        const manifest = await response.json();
        if (manifest && typeof manifest === "object" && typeof manifest.main === "string") {
          const mainPath = String(manifest.main);
          if (mainPath !== "inline") manifest.main = new URL(mainPath, url).toString();
        }
        return manifest;
      }
      return entry;
    }
    validateAgainstCore(manifest) {
      const issues = [];
      if (!satisfies(CORE_VERSION, manifest.engines?.xhgcs || "*")) {
        issues.push(`需要内核 ${manifest.engines?.xhgcs}，当前 ${CORE_VERSION}`);
      }
      if ((manifest.apiVersion || CORE_API_VERSION) !== CORE_API_VERSION) {
        issues.push(`清单 apiVersion ${manifest.apiVersion} 与内核 ${CORE_API_VERSION} 不符`);
      }
      for (const dep of manifest.dependencies || []) {
        const parsed = parseDependency(dep);
        if (!parsed.id) issues.push(`依赖写法不合法：${dep}`);
      }
      return issues;
    }
    /** 纯数据贡献：清单里声明的命令、视图、状态栏、配置、快捷键…… 一拍注册完。 */
    registerContributions(record) {
      const { manifest } = record;
      const owner = manifest.id;
      const contributes = manifest.contributes || {};
      for (const command of contributes.commands || []) {
        record.disposables.push(registerCommandContribution(owner, command));
      }
      for (const binding of contributes.keybindings || []) {
        record.disposables.push(registerKeybinding(owner, binding));
      }
      for (const view of contributes.views || []) {
        record.disposables.push(this.registry.register("views", view.id, view, owner));
      }
      for (const item of contributes.statusBar || []) {
        record.disposables.push(this.registry.register("statusBar", item.id, item, owner));
      }
      for (const item of contributes.menus || []) {
        record.disposables.push(this.registry.register("menus", `${item.location}:${item.command}:${item.order ?? 100}`, item, owner));
      }
      for (const item of contributes.themes || []) {
        record.disposables.push(this.registry.register("themes", String(item.id), item, owner));
      }
      for (const item of contributes.protocols || []) {
        record.disposables.push(this.registry.register("protocols", String(item.id), item, owner));
      }
      for (const item of contributes.operators || []) {
        record.disposables.push(this.registry.register("operators", String(item.id), item, owner));
      }
      for (const item of contributes.dataSources || []) {
        record.disposables.push(this.registry.register("dataSources", String(item.id), item, owner));
      }
      for (const item of contributes.aiTools || []) {
        record.disposables.push(this.registry.register("aiTools", String(item.name), item, owner));
      }
      for (const item of contributes.designerWidgets || []) {
        record.disposables.push(this.registry.register("designerWidgets", String(item.id), item, owner));
      }
      if (contributes.configuration) {
        record.disposables.push(configuration.register(owner, contributes.configuration));
      }
    }
    /** 启动：安装快捷键监听，激活所有 onStartup / * 扩展。 */
    async start() {
      if (this.started) return;
      this.started = true;
      this.applyPersistedState();
      this.keybindingDisposer = installKeybindingListener(() => this.getContext());
      const pending = this.list().filter((record) => record.status !== "disabled" && this.shouldActivateOnStartup(record.manifest));
      await this.activateAll(pending, "onStartup");
    }
    shouldActivateOnStartup(manifest) {
      const events = manifest.activationEvents || ["onStartup"];
      return events.includes("*") || events.includes("onStartup") || events.includes("onStartupFinished");
    }
    /** 触发某个激活事件（onView / onCommand / onPanel …）。 */
    async fireEvent(event, arg = "") {
      const targets = [];
      for (const record of this.records.values()) {
        if (record.status === "active" || record.status === "activating" || record.status === "disabled") continue;
        if (!record.manifest.activationEvents) continue;
        if (record.manifest.activationEvents.some((raw) => matchesEvent(raw, event, arg))) targets.push(record);
      }
      if (targets.length) console.info(`[XHGCS_CORE] ${event}${arg ? ":" + arg : ""} → ${targets.map((r) => r.manifest.id).join(", ")}`);
      await this.activateAll(targets, `${event}${arg ? ":" + arg : ""}`);
    }
    async activateAll(targets, reason) {
      const ordered = this.sortByDependencies(targets);
      for (const record of ordered) {
        await this.activate(record.manifest.id, reason);
      }
    }
    sortByDependencies(list) {
      const byId = new Map(list.map((record) => [record.manifest.id, record]));
      const visited = /* @__PURE__ */ new Set();
      const out = [];
      const visit = (record, stack2) => {
        const id = record.manifest.id;
        if (visited.has(id)) return;
        if (stack2.has(id)) {
          console.warn("[XHGCS_CORE] 扩展依赖成环", Array.from(stack2).concat(id).join(" → "));
          return;
        }
        stack2.add(id);
        for (const dep of record.manifest.dependencies || []) {
          const parsed = parseDependency(dep);
          const target = byId.get(parsed.id) || this.records.get(parsed.id);
          if (target) visit(target, stack2);
        }
        stack2.delete(id);
        visited.add(id);
        out.push(record);
      };
      list.forEach((record) => visit(record, /* @__PURE__ */ new Set()));
      return out;
    }
    async activate(extId, reason = "manual") {
      const record = this.records.get(extId);
      if (!record) throw new Error(`未发现的扩展：${extId}`);
      if (record.status === "active") return true;
      if (record.status === "disabled") return false;
      if (record.source === "user" && (record.manifest.permissions || []).length && !isGranted(record.manifest)) {
        record.status = "pending";
        record.message = "需要授权：" + (record.manifest.permissions || []).join(" / ");
        this.emit(record);
        return false;
      }
      for (const dep of record.manifest.dependencies || []) {
        const parsed = parseDependency(dep);
        const target = this.records.get(parsed.id);
        if (!target) {
          this.markDegraded(record, `缺少依赖扩展 ${parsed.id}`);
          return false;
        }
        if (!satisfies(target.manifest.version, parsed.range)) {
          this.markDegraded(record, `依赖 ${parsed.id} 需要 ${parsed.range}，实际 ${target.manifest.version}`);
          return false;
        }
        if (target.status !== "active") {
          const ok = await this.activate(parsed.id, `dependency:${extId}`);
          if (!ok) {
            this.markDegraded(record, `依赖 ${parsed.id} 激活失败`);
            return false;
          }
        }
      }
      record.status = "activating";
      this.emit(record);
      const store = new DisposableStore();
      try {
        const module = await this.loadModule(record);
        record.module = module;
        record.exports = this.snapshotExports(module);
        const context = this.createContext(record, store);
        if (typeof module.activate === "function") {
          await module.activate(context);
        }
        record.disposables.push(store);
        record.status = "active";
        record.message = "";
        record.activatedAt = Date.now();
        record.activatedBy = reason;
        record.lastError = "";
        this.emit(record);
        return true;
      } catch (err) {
        record.status = "failed";
        record.module = null;
        record.lastError = err instanceof Error ? err.message : String(err);
        record.message = `激活失败：${record.lastError}`;
        console.error(`[XHGCS_CORE] 扩展 ${extId} 激活失败`, err);
        store.dispose();
        this.emit(record);
        return false;
      }
    }
    markDegraded(record, message) {
      record.status = "degraded";
      record.message = message;
      this.emit(record);
    }
    async loadModule(record) {
      const { manifest } = record;
      if (!manifest.main || manifest.main === "inline") {
        return this.compileInline(record);
      }
      await loadClassicScript(manifest.main);
      const bucket = window.XHGCS_EXTENSIONS;
      const module = bucket?.[manifest.id];
      if (!module) {
        throw new Error(`插件 ${manifest.id} 未注册 window.XHGCS_EXTENSIONS["${manifest.id}"]`);
      }
      return module;
    }
    /**
     * inline 形态：AI 现场生成的插件与存量视图插件共用这一条路。
     * 代码里写 `function activate(ctx){}` / `function deactivate(){}` 即可。
     */
    compileInline(record) {
      const code = record.manifest.inlineScript || "";
      if (!code.trim()) throw new Error("inline 插件没有代码");
      const factory = new Function(
        `'use strict';
${code}
;return {
  activate: typeof activate === 'function' ? activate : undefined,
  deactivate: typeof deactivate === 'function' ? deactivate : undefined
};`
      );
      return factory();
    }
    snapshotExports(module) {
      const out = {};
      for (const [key, value] of Object.entries(module)) {
        if (key === "activate" || key === "deactivate") continue;
        out[key] = value;
      }
      return out;
    }
    createContext(record, store) {
      const { manifest } = record;
      const granted = record.source === "user" ? grantedPermissions(manifest) : manifest.permissions;
      const api = createExtensionApi(
        {
          host: this,
          registry: this.registry,
          configuration,
          commands: { execute: executeCommand },
          storage: createStorage(manifest.id),
          env: this.env,
          getContext: () => this.getContext(),
          activateOnEvent: (event, arg) => this.fireEvent(event, arg)
        },
        manifest,
        store,
        granted
      );
      return {
        extensionId: manifest.id,
        extensionPath: `plugins/${manifest.id}/`,
        api,
        subscriptions: store,
        storage: createStorage(manifest.id),
        log: (message, detail) => this.env.log("info", `[${manifest.id}] ${message}`, detail),
        exports: record.exports || {},
        utils: {
          when: evaluateWhen
        }
      };
    }
    async deactivate(extId) {
      const record = this.records.get(extId);
      if (!record) return;
      const module = record.module || null;
      try {
        if (module && typeof module.deactivate === "function") await module.deactivate();
      } catch (err) {
        console.warn(`[XHGCS_CORE] 扩展 ${extId} deactivate 抛错`, err);
      }
      const disposables = record.disposables.splice(0, record.disposables.length);
      for (let i = disposables.length - 1; i >= 0; i--) {
        try {
          disposables[i].dispose();
        } catch (err) {
          console.warn("[XHGCS_CORE] 释放扩展资源失败", err);
        }
      }
      this.registry.unregisterAll(extId);
      this.dropRuntime(extId);
      record.status = "resolved";
      record.module = null;
      record.exports = null;
      record.activatedAt = 0;
      this.emit(record);
    }
    dropRuntime(extId) {
      for (const bucket of Object.values(this.runtime)) {
        for (const [key, value] of Array.from(bucket.entries())) {
          const owner = value?.owner;
          if (owner === extId) bucket.delete(key);
        }
      }
    }
    async reload(extId) {
      const record = this.records.get(extId);
      if (!record) return false;
      const wasActive = record.status === "active";
      await this.deactivate(extId);
      const main = record.manifest.main;
      if (main && main !== "inline") {
        const existing = document.querySelector('script[data-xhgcs-ext="' + main + '"]');
        if (existing && existing.parentNode) existing.parentNode.removeChild(existing);
        const bucket = window.XHGCS_EXTENSIONS;
        if (bucket) delete bucket[record.manifest.id];
      }
      this.registerContributions(record);
      record.status = "resolved";
      record.message = "";
      if (wasActive) return this.activate(extId, "reload");
      this.emit(record);
      return true;
    }
    /** 禁用：卸载 + 记住禁用状态（由调用方持久化）。 */
    async disable(extId) {
      await this.deactivate(extId);
      this.registry.unregisterAll(extId);
      const record = this.records.get(extId);
      if (record) {
        record.status = "disabled";
        record.message = "已停用（用户设置）";
        setDisabled(extId, true);
        this.emit(record);
      }
    }
    async enable(extId) {
      const record = this.records.get(extId);
      if (!record) return false;
      setDisabled(extId, false);
      record.status = record.source === "user" && (record.manifest.permissions || []).length && !isGranted(record.manifest) ? "pending" : "resolved";
      record.message = record.status === "pending" ? "权限已变化，需要重新授权" : "";
      this.registerContributions(record);
      this.emit(record);
      return true;
    }
    /** 启动时应用「用户上次停用了哪些插件」。 */
    applyPersistedState() {
      for (const record of this.records.values()) {
        if (!isDisabled(record.manifest.id)) continue;
        record.status = "disabled";
        record.message = "已停用（用户设置）";
        this.emit(record);
      }
    }
    /** 授权页调用：勾选后写入授权并回到可激活状态。 */
    grantAccess(extId, permissions) {
      const record = this.records.get(extId);
      if (!record) return false;
      grant(record.manifest, permissions || defaultGrant(record.manifest));
      record.status = "resolved";
      record.message = "";
      this.emit(record);
      return true;
    }
    /** 撤销授权：已激活的先停掉，再回到待授权。 */
    async revokeAccess(extId) {
      const record = this.records.get(extId);
      revoke(extId);
      if (record) {
        await this.deactivate(extId);
        record.status = "pending";
        record.message = "授权已撤销";
        this.emit(record);
      }
    }
    dispose() {
      this.keybindingDisposer?.dispose();
      this.keybindingDisposer = null;
      for (const record of this.records.values()) {
        const disposables = record.disposables.splice(0, record.disposables.length);
        disposables.forEach((item) => {
          try {
            item.dispose();
          } catch {
          }
        });
      }
      this.records.clear();
      this.onChange.clear();
    }
    emit(record) {
      this.onChange.emit({ extId: record.manifest.id, status: record.status, message: record.message });
    }
  }
  function matchesEvent(spec, event, arg) {
    const text = String(spec || "").trim();
    if (!text) return false;
    if (text === "*") return true;
    if (text === event && !arg) return true;
    if (text === `${event}:*`) return true;
    if (arg && text === `${event}:${arg}`) return true;
    return false;
  }
  function createStorageDisposer(owner) {
    return { dispose: () => void 0 };
  }
  const env = {
    now: () => Date.now(),
    log(level, message, detail) {
      const fn = level === "error" ? console.error : level === "warn" ? console.warn : console.info;
      if (detail === void 0) fn.call(console, `[XHGCS_CORE] ${message}`);
      else fn.call(console, `[XHGCS_CORE] ${message}`, detail);
    },
    toast(message) {
      const legacy = window.XHGCS_APP;
      if (legacy && typeof legacy.toast === "function") {
        legacy.toast(message);
        return;
      }
      const el = document.createElement("div");
      el.textContent = message;
      el.style.cssText = "position:fixed;left:50%;bottom:48px;transform:translateX(-50%);z-index:99999;padding:10px 16px;border-radius:10px;background:rgba(20,26,34,.94);color:#e8eef7;border:1px solid rgba(255,255,255,.14);font:13px/1.4 system-ui;box-shadow:0 12px 32px rgba(0,0,0,.42)";
      document.body.appendChild(el);
      window.setTimeout(() => el.remove(), 2600);
    }
  };
  const host = new ExtensionHost(env, { registry });
  host.setContextProvider(buildWhenContext);
  statusBar.setContextProvider(buildWhenContext);
  const stack = [];
  let installed$1 = false;
  function install() {
    if (installed$1 || typeof document === "undefined") return;
    installed$1 = true;
    document.addEventListener(
      "keydown",
      (event) => {
        if (event.key !== "Escape") return;
        const top = stack[stack.length - 1];
        if (!top) return;
        event.preventDefault();
        event.stopPropagation();
        let handled = false;
        try {
          handled = top.onEscape ? top.onEscape() === true : false;
        } catch (err) {
          console.warn("[XHGCS_OVERLAY] onEscape 抛错", err);
        }
        if (!handled) top.close();
      },
      true
    );
    window.XHGCS_OVERLAY = {
      depth: () => stack.length,
      top: () => stack.length ? stack[stack.length - 1].id : null,
      ids: () => stack.map((layer) => layer.id)
    };
  }
  function pushOverlay(layer) {
    install();
    const existing = stack.findIndex((item) => item.id === layer.id);
    if (existing >= 0) stack.splice(existing, 1);
    stack.push(layer);
    let disposed = false;
    return () => {
      if (disposed) return;
      disposed = true;
      const index = stack.findIndex((item) => item === layer);
      if (index >= 0) stack.splice(index, 1);
    };
  }
  const STYLE_ID$5 = "xhgcs-ui-shell-style";
  const Z = 9600;
  function ensureShellStyles() {
    if (document.getElementById(STYLE_ID$5)) return;
    const style = document.createElement("style");
    style.id = STYLE_ID$5;
    style.textContent = `
/* 命令面板 / 扩展管理：统一 L3 浮层。数值全部走 B1a 令牌（字号 6 档、无面板级描边）。 */
.xhgcs-mask{position:fixed;inset:0;z-index:${Z};background:rgba(4,7,11,.55);
  display:flex;justify-content:center;align-items:flex-start;padding-top:12vh}
.xhgcs-mask[data-kind="panel"]{align-items:center;padding-top:0}
html[data-theme="light"] .xhgcs-mask{background:rgba(15,23,42,.32)}
html[data-fx="glass"] .xhgcs-mask{backdrop-filter:blur(4px)}
/* 命令面板 */
.xhgcs-palette{width:min(660px,88vw);background-color:var(--surf-3,#242c36);background-image:var(--surf-sheen,none);
  background-size:100% 40%;background-repeat:no-repeat;border:0;border-radius:var(--r-overlay,16px);
  box-shadow:var(--elev-3,0 30px 72px -16px rgba(0,0,0,.62));backdrop-filter:var(--surf-blur-strong,none);
  overflow:hidden;display:flex;flex-direction:column;animation:xhgcs-pop .14s ease}
@keyframes xhgcs-pop{from{opacity:0;transform:translateY(-6px) scale(.99)}to{opacity:1;transform:none}}
.xhgcs-palette-search{display:flex;align-items:center;gap:8px;padding:0 14px;border-bottom:1px solid var(--edge-soft,rgba(255,255,255,.035));
  background:transparent}
.xhgcs-palette-search .xhgcs-search-ico{color:var(--acc,#6da8d2);font-size:var(--fs-13,13px);line-height:1;opacity:.9}
.xhgcs-palette input{flex:1 1 auto;width:100%;height:46px;border:0;background:transparent;
  color:var(--heading,#e6f2ff);font:var(--fs-14,14px)/1.4 inherit;padding:0;outline:none;letter-spacing:.01em}
.xhgcs-palette input::placeholder{color:var(--text-dim,#8b97a5)}
.xhgcs-palette-list{max-height:52vh;overflow:auto;padding:6px 6px 8px}
.xhgcs-palette-item{display:flex;align-items:center;gap:8px;padding:8px 10px;border-radius:var(--r-ctl,6px);cursor:pointer;
  color:var(--text,#c7d1dc);font-size:var(--fs-13,13px);border:1px solid transparent;position:relative}
.xhgcs-palette-item[data-active="1"]{background:var(--surf-hover,rgba(255,255,255,.045));border-color:var(--edge-soft,rgba(255,255,255,.035));color:var(--heading,#e9f1fa)}
.xhgcs-palette-item[data-active="1"]::before{content:'';position:absolute;left:2px;top:8px;bottom:8px;width:2px;border-radius:2px;
  background:var(--acc,#6da8d2)}
.xhgcs-palette-item b{font-weight:600}
.xhgcs-palette-item small{margin-left:auto;color:var(--text-dim,#8b97a5);font-size:var(--fs-10,10px);
  font-family:var(--font-mono,ui-monospace,Consolas,monospace);opacity:.9}
.xhgcs-palette-item[data-active="1"] .xhgcs-palette-cat,.xhgcs-palette-item[data-active="1"] small{color:var(--text,#c7d1dc)}
.xhgcs-palette-cat{color:var(--text-dim,#8b97a5);font-size:var(--fs-10,10px);min-width:40px;text-align:center;padding:1px 6px;
  border-radius:999px;border:1px solid var(--edge-soft,rgba(255,255,255,.035));flex:0 0 auto}
.xhgcs-palette-foot{display:flex;align-items:center;gap:12px;padding:7px 12px;border-top:1px solid var(--edge-soft,rgba(255,255,255,.035));
  color:var(--text-dim,#8b97a5);font-size:var(--fs-11,11px);background:transparent}
.xhgcs-palette-foot kbd{font:inherit;padding:1px 5px;border-radius:4px;border:1px solid var(--edge-hair,rgba(255,255,255,.06));
  background:var(--surf-inset,#0b0e13);color:var(--text,#c7d1dc);margin-right:3px}
/* 扩展管理 */
.xhgcs-panel{width:min(760px,92vw);max-height:76vh;display:flex;flex-direction:column;
  background-color:var(--surf-3,#242c36);background-image:var(--surf-sheen,none);background-size:100% 40%;background-repeat:no-repeat;
  border:0;border-radius:var(--r-overlay,16px);box-shadow:var(--elev-3,0 30px 72px -16px rgba(0,0,0,.62));
  backdrop-filter:var(--surf-blur-strong,none);overflow:hidden}
.xhgcs-panel-head{display:flex;align-items:center;gap:8px;padding:12px 14px;border-bottom:0}
.xhgcs-panel-head h3{margin:0;font-size:var(--fs-14,14px);font-weight:600;color:var(--heading,#e9f1fa)}
.xhgcs-panel-head .xhgcs-close{margin-left:auto;border:0;background:transparent;color:var(--text-dim,#8b97a5);
  font-size:var(--fs-13,13px);cursor:pointer;padding:3px 8px;border-radius:var(--r-ctl,6px)}
.xhgcs-panel-head .xhgcs-close:hover{background:var(--surf-hover,rgba(255,255,255,.045));color:var(--text,#c7d1dc)}
.xhgcs-panel-body{overflow:auto;padding:4px 12px 12px}
.xhgcs-ext{display:flex;gap:10px;align-items:flex-start;padding:10px 2px;border-bottom:1px solid var(--edge-soft,rgba(255,255,255,.035))}
.xhgcs-ext:last-child{border-bottom:0}
.xhgcs-ext-main{flex:1 1 auto;min-width:0}
.xhgcs-ext-title{display:flex;align-items:center;gap:8px;color:var(--heading,#e9f1fa);font-size:var(--fs-13,13px);font-weight:600}
.xhgcs-ext-id{color:var(--text-dim,#8b97a5);font-size:var(--fs-11,11px);margin-top:2px;word-break:break-all}
.xhgcs-ext-msg{margin-top:6px;font-size:var(--fs-11,11px);color:var(--warn,#e0a34a);white-space:pre-wrap}
.xhgcs-chip{font-size:var(--fs-10,10px);padding:1px 6px;border-radius:999px;border:1px solid currentColor;line-height:1.6}
.xhgcs-chip[data-s="active"]{color:var(--ok,#58c08a)}
.xhgcs-chip[data-s="resolved"]{color:var(--acc,#6da8d2)}
.xhgcs-chip[data-s="disabled"]{color:var(--text-dim,#8b97a5)}
.xhgcs-chip[data-s="degraded"]{color:var(--warn,#e0a34a)}
.xhgcs-chip[data-s="failed"]{color:var(--danger,#e05c5c)}
.xhgcs-chip[data-s="pending"]{color:var(--warn,#e0a34a)}
.xhgcs-chip[data-s="activating"]{color:var(--acc,#6da8d2)}
.xhgcs-consent{margin-top:8px;padding:8px 10px;border:1px dashed rgba(var(--k-amber),.45);border-radius:var(--r-card,10px);
  background:rgba(var(--k-amber),.07);display:flex;flex-wrap:wrap;gap:6px 12px;align-items:center}
.xhgcs-consent-row{display:inline-flex;align-items:center;gap:5px;font-size:var(--fs-11,11px);color:var(--text,#c7d1dc);
  font-family:var(--font-mono,ui-monospace,Consolas,monospace);cursor:pointer}
.xhgcs-consent button{border:1px solid rgba(var(--k-amber),.55);background:rgba(var(--k-amber),.16);color:var(--k-amber-t,#e0a34a);
  font-size:var(--fs-11,11px);padding:3px 9px;border-radius:var(--r-ctl,6px);cursor:pointer}
.xhgcs-consent button:hover{background:rgba(var(--k-amber),.26)}
.xhgcs-consent-note{flex:1 1 100%;font-size:var(--fs-10,10px);color:var(--text-dim,#8b97a5);line-height:1.5}
.xhgcs-ext-actions{display:flex;gap:6px;flex:0 0 auto}
.xhgcs-ext-actions button{border:1px solid var(--line,#2a3340);background:var(--surf-inset,#0b0e13);color:var(--text,#c7d1dc);
  font-size:var(--fs-11,11px);padding:3px 9px;border-radius:var(--r-ctl,6px);cursor:pointer}
.xhgcs-ext-actions button:hover{border-color:var(--acc,#6da8d2);color:var(--heading,#e9f1fa)}
.xhgcs-empty{color:var(--text-dim,#8b97a5);font-size:var(--fs-12,12px);padding:16px 4px;text-align:center}
`;
    document.head.appendChild(style);
  }
  function mountMask(kind, onClose) {
    ensureShellStyles();
    const mask = document.createElement("div");
    mask.className = "xhgcs-mask";
    mask.dataset.kind = kind;
    document.body.appendChild(mask);
    let closed = false;
    let disposeOverlay = () => void 0;
    const close = () => {
      if (closed) return;
      closed = true;
      disposeOverlay();
      mask.remove();
      onClose();
    };
    disposeOverlay = pushOverlay({ id: kind === "palette" ? "palette" : "extensions", kind: "panel", close });
    mask.addEventListener("mousedown", (event) => {
      if (event.target === mask) close();
    });
    return { mask, close };
  }
  let paletteVisible = false;
  function openPalette() {
    if (paletteVisible) return;
    paletteVisible = true;
    const { mask, close } = mountMask("palette", () => {
      paletteVisible = false;
    });
    const wrap = document.createElement("div");
    wrap.className = "xhgcs-palette";
    const input = document.createElement("input");
    input.placeholder = "搜索命令 / 扩展入口…";
    input.autocomplete = "off";
    const search = document.createElement("div");
    search.className = "xhgcs-palette-search";
    const ico = document.createElement("span");
    ico.className = "xhgcs-search-ico";
    ico.textContent = "⌕";
    search.append(ico, input);
    const list = document.createElement("div");
    list.className = "xhgcs-palette-list";
    const foot = document.createElement("div");
    foot.className = "xhgcs-palette-foot";
    foot.innerHTML = "<span><kbd>↑</kbd><kbd>↓</kbd> 选择</span><span><kbd>↵</kbd> 执行</span><span><kbd>Esc</kbd> 关闭</span>";
    wrap.append(search, list, foot);
    mask.appendChild(wrap);
    let filtered = listCommands();
    let cursor = 0;
    const render = () => {
      list.replaceChildren();
      if (!filtered.length) {
        const empty = document.createElement("div");
        empty.className = "xhgcs-empty";
        empty.textContent = "没有匹配的命令";
        list.appendChild(empty);
        return;
      }
      filtered.forEach((command, index) => {
        const row = document.createElement("div");
        row.className = "xhgcs-palette-item";
        row.dataset.active = index === cursor ? "1" : "0";
        const cat = document.createElement("span");
        cat.className = "xhgcs-palette-cat";
        cat.textContent = command.category || "命令";
        const title = document.createElement("b");
        title.textContent = command.title;
        const id = document.createElement("small");
        id.textContent = command.id;
        row.append(cat, title, id);
        row.addEventListener("mouseenter", () => {
          cursor = index;
          render();
        });
        row.addEventListener("click", () => {
          cursor = index;
          run();
        });
        list.appendChild(row);
      });
      const active2 = list.querySelector('[data-active="1"]');
      active2?.scrollIntoView({ block: "nearest" });
    };
    const refilter = () => {
      const query = input.value.trim().toLowerCase();
      filtered = listCommands().filter((command) => {
        if (!query) return true;
        return `${command.id} ${command.title} ${command.category}`.toLowerCase().includes(query);
      });
      cursor = 0;
      render();
    };
    const run = () => {
      const target = filtered[cursor];
      if (!target) return;
      close();
      executeCommand(target.id).catch(() => void 0);
    };
    input.addEventListener("input", refilter);
    input.addEventListener("keydown", (event) => {
      if (event.key === "ArrowDown") {
        event.preventDefault();
        cursor = Math.min(filtered.length - 1, cursor + 1);
        render();
      } else if (event.key === "ArrowUp") {
        event.preventDefault();
        cursor = Math.max(0, cursor - 1);
        render();
      } else if (event.key === "Enter") {
        event.preventDefault();
        run();
      }
    });
    render();
    window.setTimeout(() => input.focus(), 10);
  }
  function openExtensions() {
    const { mask, close } = mountMask("panel", () => void 0);
    const panel = document.createElement("div");
    panel.className = "xhgcs-panel";
    const head = document.createElement("div");
    head.className = "xhgcs-panel-head";
    const title = document.createElement("h3");
    title.textContent = "扩展管理";
    const closeBtn = document.createElement("button");
    closeBtn.className = "xhgcs-close";
    closeBtn.textContent = "✕";
    closeBtn.addEventListener("click", close);
    head.append(title, closeBtn);
    const body = document.createElement("div");
    body.className = "xhgcs-panel-body";
    panel.append(head, body);
    mask.appendChild(panel);
    const render = () => {
      body.replaceChildren();
      const records = host.list().sort((a, b) => a.manifest.id.localeCompare(b.manifest.id));
      if (!records.length) {
        const empty = document.createElement("div");
        empty.className = "xhgcs-empty";
        empty.textContent = "还没有发现任何扩展。把插件放进 plugins/ 目录后刷新即可。";
        body.appendChild(empty);
        return;
      }
      for (const record of records) {
        const row = document.createElement("div");
        row.className = "xhgcs-ext";
        const main = document.createElement("div");
        main.className = "xhgcs-ext-main";
        const titleEl = document.createElement("div");
        titleEl.className = "xhgcs-ext-title";
        const name = document.createElement("span");
        name.textContent = record.manifest.name;
        const chip = document.createElement("span");
        chip.className = "xhgcs-chip";
        chip.dataset.s = record.status;
        chip.textContent = record.status;
        titleEl.append(name, chip);
        const id = document.createElement("div");
        id.className = "xhgcs-ext-id";
        id.textContent = `${record.manifest.id} · v${record.manifest.version}`;
        main.append(titleEl, id);
        if (record.message) {
          const msg = document.createElement("div");
          msg.className = "xhgcs-ext-msg";
          msg.textContent = record.message;
          main.appendChild(msg);
        }
        const actions = document.createElement("div");
        actions.className = "xhgcs-ext-actions";
        if (record.status === "pending") {
          const box = document.createElement("div");
          box.className = "xhgcs-consent";
          const perms = record.manifest.permissions || [];
          const checks = [];
          for (const permission of perms) {
            const row2 = document.createElement("label");
            row2.className = "xhgcs-consent-row";
            const input = document.createElement("input");
            input.type = "checkbox";
            input.checked = !RISKY_PERMISSIONS.has(permission);
            const text = document.createElement("span");
            text.textContent = permission;
            row2.append(input, text);
            box.appendChild(row2);
            checks.push({ permission, input });
          }
          const trust = document.createElement("div");
          trust.className = "xhgcs-consent-note";
          trust.textContent = "插件代码以应用权限运行（不是沙箱），只授权你信任的插件。";
          box.appendChild(trust);
          const confirm = document.createElement("button");
          confirm.textContent = "授权并启用";
          confirm.addEventListener("click", async () => {
            const chosen = checks.filter((item) => item.input.checked).map((item) => item.permission);
            host.grantAccess(record.manifest.id, chosen);
            await host.activate(record.manifest.id, "consent");
            render();
          });
          box.appendChild(confirm);
          main.appendChild(box);
        }
        if (record.status === "disabled") {
          const enable = document.createElement("button");
          enable.textContent = "启用";
          enable.addEventListener("click", async () => {
            await host.enable(record.manifest.id);
            if ((record.manifest.activationEvents || []).some((event) => event === "onStartup" || event === "*")) {
              await host.activate(record.manifest.id, "manual");
            }
            render();
          });
          actions.appendChild(enable);
        } else {
          const reload = document.createElement("button");
          reload.textContent = "重载";
          reload.addEventListener("click", async () => {
            await host.reload(record.manifest.id);
            render();
          });
          const disable = document.createElement("button");
          disable.textContent = "停用";
          disable.addEventListener("click", async () => {
            await host.disable(record.manifest.id);
            render();
          });
          actions.append(reload, disable);
        }
        row.append(main, actions);
        body.appendChild(row);
      }
    };
    host.onDidChange(() => {
      if (document.body.contains(mask)) render();
    });
    render();
  }
  const STYLE_ID$4 = "xhgcs-ext-settings-style";
  function ensureConfigStyles() {
    if (document.getElementById(STYLE_ID$4)) return;
    const style = document.createElement("style");
    style.id = STYLE_ID$4;
    style.textContent = `
.xst-body{display:flex;min-height:0;height:100%}
.xst-nav{width:220px;flex:0 0 220px;border-right:1px solid var(--edge-hair,rgba(255,255,255,.08));overflow:auto;padding:8px;background:var(--bg2,#161b22)}
.xst-nav-item{width:100%;text-align:left;border:0;background:transparent;color:var(--text,#c9d4e0);font:12px/1.4 inherit;
  padding:8px 10px;border-radius:8px;cursor:pointer;display:block}
.xst-nav-item:hover{background:var(--bg3,#1f2731)}
.xst-nav-item[data-active="1"]{background:rgba(var(--acc-rgb), .16);color:var(--heading,#e6f2ff)}
.xst-nav-item small{display:block;color:var(--text-dim,#7d8896);font-size:10px;margin-top:2px}
.xst-sec{font-size:10px;letter-spacing:.08em;text-transform:uppercase;color:var(--text-dim,#7d8896);margin:10px 4px 6px}
.xst-open-dir{width:100%;margin-top:10px;border:1px dashed rgba(255,255,255,.16);background:rgba(var(--acc-rgb), .08);
  color:var(--acc,#6da8d2);font:12px/1 inherit;padding:8px 10px;border-radius:9px;cursor:pointer;transition:background .13s,border-color .13s}
.xst-open-dir:hover{background:rgba(var(--acc-rgb), .16);border-color:rgba(var(--acc-rgb), .5)}
.xst-help{font-size:10px;color:var(--text-dim,#7d8896);margin:6px 4px 0;line-height:1.6;word-break:break-all}
.xst-detail{flex:1 1 auto;overflow:auto;padding:4px 18px 18px;min-width:0}
.xst-row{display:flex;gap:14px;align-items:flex-start;padding:10px 0;border-bottom:1px solid rgba(255,255,255,.05)}
.xst-row:last-child{border-bottom:0}
.xst-copy{flex:1 1 auto;min-width:0}
.xst-key{font-size:12px;color:var(--text,#c9d4e0);font-family:ui-monospace,Consolas,monospace}
.xst-desc{font-size:11px;color:var(--text-dim,#7d8896);margin-top:3px;line-height:1.45}
.xst-control{flex:0 0 220px;display:flex;justify-content:flex-end}
.xst-control input[type="text"],.xst-control input[type="number"],.xst-control select{width:200px;height:28px;border-radius:7px;
  border:1px solid var(--edge-hair,rgba(255,255,255,.08));background:var(--bg3,#1f2731);color:var(--text,#c9d4e0);font:12px/1 inherit;padding:0 8px;outline:none}
.xst-control input:focus,.xst-control select:focus{border-color:var(--acc,#6da8d2)}
.xst-empty{color:var(--text-dim,#7d8896);font-size:12px;padding:22px 4px;text-align:center;line-height:1.7;white-space:pre-line}
.xst-actions{display:flex;gap:8px;margin:6px 0 14px}
.xst-actions button{border:1px solid var(--edge-hair,rgba(255,255,255,.08));background:var(--bg3,#1f2731);color:var(--text,#c9d4e0);
  font-size:12px;padding:5px 12px;border-radius:7px;cursor:pointer}
.xst-actions button:hover{border-color:var(--acc,#6da8d2);color:var(--heading,#e6f2ff)}
.xst-ext{display:flex;gap:10px;align-items:flex-start;padding:9px 0;border-bottom:1px solid rgba(255,255,255,.05)}
.xst-ext:last-child{border-bottom:0}
.xst-ext-main{flex:1 1 auto;min-width:0}
.xst-ext-title{display:flex;align-items:center;gap:8px;font-size:12px;color:var(--text,#c9d4e0);font-weight:600}
.xst-ext-id{font-size:11px;color:var(--text-dim,#7d8896);margin-top:2px}
.xst-ext-msg{font-size:11px;color:var(--warn,#fbbf24);margin-top:4px}
.xst-chip{font-size:10px;padding:0 7px;border-radius:999px;border:1px solid currentColor;line-height:1.7}
.xst-chip[data-s="active"]{color:var(--ok,#34d399)}
.xst-chip[data-s="resolved"]{color:var(--acc,#6da8d2)}
.xst-chip[data-s="disabled"]{color:var(--text-dim,#7d8896)}
.xst-chip[data-s="degraded"]{color:var(--warn,#fbbf24)}
.xst-chip[data-s="failed"]{color:var(--danger,#f87171)}
.xst-ext-actions{display:flex;gap:6px}
.xst-ext-actions button{border:1px solid var(--edge-hair,rgba(255,255,255,.08));background:var(--bg3,#1f2731);color:var(--text,#c9d4e0);
  font-size:11px;padding:3px 9px;border-radius:6px;cursor:pointer}
.xst-ext-actions button:hover{border-color:var(--acc,#6da8d2)}
.xst-mask{position:fixed;inset:0;z-index:9650;background:rgba(6,10,16,.55);backdrop-filter:blur(2px);display:flex;align-items:center;justify-content:center}
.xst-shell{width:min(880px,92vw);height:min(620px,84vh);display:flex;flex-direction:column;background:var(--surface-1,var(--bg,#0d1117));
  border:1px solid var(--edge-hair,rgba(255,255,255,.08));border-radius:14px;overflow:hidden;box-shadow:0 28px 70px rgba(0,0,0,.55)}
.xst-head{display:flex;align-items:center;gap:10px;padding:12px 14px;border-bottom:1px solid var(--line,#2d333b);background:var(--bg2,#161b22)}
.xst-head h3{margin:0;font-size:13px;color:var(--heading,#e6f2ff)}
.xst-head button{margin-left:auto;border:0;background:transparent;color:var(--text-dim,#7d8896);font-size:16px;cursor:pointer;padding:4px 8px;border-radius:6px}
.xst-head button:hover{background:var(--bg3,#1f2731);color:var(--text,#c9d4e0)}
.xst-foot{padding:10px 16px;border-top:1px solid var(--line,#2d333b);display:flex;gap:8px;align-items:center;background:var(--bg2,#161b22)}
.xst-foot .xst-hint{color:var(--text-dim,#7d8896);font-size:11px;margin-right:auto}
.xst-foot button{border:1px solid var(--line,#2d333b);background:var(--bg3,#1f2731);color:var(--text,#c9d4e0);
  font-size:12px;padding:5px 12px;border-radius:7px;cursor:pointer}
.xst-foot button:hover{border-color:var(--acc,#6da8d2);color:var(--heading,#e6f2ff)}
.xst-nav{width:260px;flex:0 0 260px}
.xst-ext{display:flex;gap:10px;align-items:center;padding:8px;border-bottom:1px solid rgba(255,255,255,.05);border-radius:8px}
.xst-ext[data-selectable="1"]{cursor:pointer}
.xst-ext[data-selectable="1"]:hover{background:var(--bg3,#1f2731)}
.xst-ext[data-selectable="1"]:focus-visible{outline:2px solid var(--acc,#6da8d2);outline-offset:-2px}
.xst-ext[data-active="1"]{background:rgba(var(--acc-rgb), .16)}
.xst-ext[data-active="1"] .xst-ext-title{color:var(--heading,#e6f2ff)}
.xst-ext-actions{display:flex;flex:0 0 auto;gap:6px;align-items:center}
.xst-ext-actions button{min-width:44px;height:26px;padding:0 8px;white-space:nowrap;flex:0 0 auto}
.xst-chip[data-s="none"]{color:var(--text-dim,#7d8896);opacity:.8}
.xst-nav{width:310px;flex:0 0 310px}
.xst-ext-title{flex-wrap:nowrap;min-width:0}
.xst-ext-title>span:first-child{min-width:0;overflow:hidden;text-overflow:ellipsis;white-space:nowrap}
.xst-chip{white-space:nowrap;flex:0 0 auto}
.xst-ext-id{display:flex;align-items:center;gap:6px;min-width:0}
.xst-ext-id>span:first-child{min-width:0;overflow:hidden;text-overflow:ellipsis;white-space:nowrap}
.xst-ext-actions{gap:4px}
.xst-control{flex:0 0 200px}
.xst-control input[type="text"],.xst-control input[type="number"],.xst-control select{width:180px}
`;
    document.head.appendChild(style);
  }
  function buildControl(owner, key, spec) {
    const wrap = document.createElement("div");
    const current = configuration.get(owner, key);
    if (spec.type === "boolean") {
      const input2 = document.createElement("input");
      input2.type = "checkbox";
      input2.checked = current === true;
      input2.addEventListener("change", () => configuration.update(owner, key, input2.checked));
      wrap.appendChild(input2);
      return wrap;
    }
    if (spec.type === "enum") {
      const select = document.createElement("select");
      (spec.enum || []).forEach((value, index) => {
        const option = document.createElement("option");
        option.value = String(value);
        option.textContent = spec.enumLabels?.[index] || String(value);
        select.appendChild(option);
      });
      select.value = String(current);
      select.addEventListener("change", () => configuration.update(owner, key, select.value));
      wrap.appendChild(select);
      return wrap;
    }
    if (spec.type === "number" || spec.type === "integer") {
      const input2 = document.createElement("input");
      input2.type = "number";
      if (spec.minimum != null) input2.min = String(spec.minimum);
      if (spec.maximum != null) input2.max = String(spec.maximum);
      if (spec.step != null) input2.step = String(spec.step);
      input2.value = current == null ? "" : String(current);
      input2.addEventListener("change", () => {
        configuration.update(owner, key, Number(input2.value));
        input2.value = String(configuration.get(owner, key));
      });
      wrap.appendChild(input2);
      return wrap;
    }
    const input = document.createElement("input");
    input.type = "text";
    input.value = current == null ? "" : String(current);
    input.addEventListener("change", () => configuration.update(owner, key, input.value));
    wrap.appendChild(input);
    return wrap;
  }
  function renderExtensionPane(root, options = {}) {
    ensureConfigStyles();
    root.replaceChildren();
    const body = document.createElement("div");
    body.className = "xst-body";
    const nav = document.createElement("div");
    nav.className = "xst-nav";
    const detail = document.createElement("div");
    detail.className = "xst-detail";
    body.append(nav, detail);
    root.appendChild(body);
    let recordsEl = null;
    if (options.showList !== false) {
      const listTitle = document.createElement("div");
      listTitle.className = "xst-sec";
      listTitle.textContent = "已发现扩展";
      nav.appendChild(listTitle);
      recordsEl = document.createElement("div");
      nav.appendChild(recordsEl);
      const desktop = window.XHGCS_DESKTOP;
      if (desktop && desktop.extensions && typeof desktop.extensions.openDir === "function") {
        const openBtn = document.createElement("button");
        openBtn.className = "xst-open-dir";
        openBtn.textContent = "打开用户插件目录";
        openBtn.title = "把插件文件夹放进去后，点扩展面板的「刷新」或重启应用";
        openBtn.addEventListener("click", () => {
          desktop.extensions?.openDir?.();
        });
        nav.appendChild(openBtn);
        const hint = document.createElement("div");
        hint.className = "xst-help";
        hint.textContent = "目录：%APPDATA%\\Xuanji\\extensions\\<插件id>\\";
        nav.appendChild(hint);
      }
    }
    const hasSchema = (id) => Boolean(configuration.schema(id));
    let records = host.list().sort((a, b) => a.manifest.id.localeCompare(b.manifest.id));
    let activeId = "";
    const pickActive = () => {
      if (activeId && hasSchema(activeId) && records.some((r) => r.manifest.id === activeId)) return;
      const first = records.find((r) => hasSchema(r.manifest.id));
      if (first) {
        activeId = first.manifest.id;
        return;
      }
      const schemas = configuration.schemas_();
      activeId = schemas.length ? schemas[0].owner : "";
    };
    const renderRows = () => {
      if (!recordsEl) return;
      recordsEl.replaceChildren();
      if (!records.length) {
        const empty = document.createElement("div");
        empty.className = "xst-empty";
        empty.textContent = "还没有发现任何扩展";
        recordsEl.appendChild(empty);
        return;
      }
      for (const record of records) {
        const id = record.manifest.id;
        const selectable = hasSchema(id);
        const row = document.createElement("div");
        row.className = "xst-ext";
        row.dataset.selectable = selectable ? "1" : "0";
        row.dataset.active = selectable && id === activeId ? "1" : "0";
        if (selectable) {
          row.tabIndex = 0;
          row.setAttribute("role", "button");
          row.setAttribute("aria-pressed", id === activeId ? "true" : "false");
          row.addEventListener("click", () => {
            if (activeId === id) return;
            activeId = id;
            renderRows();
            renderDetail();
          });
          row.addEventListener("keydown", (event) => {
            if (event.key !== "Enter" && event.key !== " ") return;
            event.preventDefault();
            activeId = id;
            renderRows();
            renderDetail();
          });
        } else {
          row.setAttribute("aria-disabled", "true");
        }
        const main = document.createElement("div");
        main.className = "xst-ext-main";
        const title = document.createElement("div");
        title.className = "xst-ext-title";
        const name = document.createElement("span");
        name.textContent = record.manifest.name;
        const chip = document.createElement("span");
        chip.className = "xst-chip";
        chip.dataset.s = record.status;
        chip.textContent = record.status;
        title.append(name, chip);
        const idEl = document.createElement("div");
        idEl.className = "xst-ext-id";
        const idText = document.createElement("span");
        idText.textContent = id;
        idEl.appendChild(idText);
        if (!selectable) {
          const quiet = document.createElement("span");
          quiet.className = "xst-chip";
          quiet.dataset.s = "none";
          quiet.textContent = "无配置";
          idEl.appendChild(quiet);
        }
        main.append(title, idEl);
        if (record.message) {
          const msg = document.createElement("div");
          msg.className = "xst-ext-msg";
          msg.textContent = record.message;
          main.appendChild(msg);
        }
        const actions = document.createElement("div");
        actions.className = "xst-ext-actions";
        const stop = (event) => event.stopPropagation();
        const toggle = document.createElement("button");
        if (record.status === "pending") {
          toggle.textContent = "授权";
          toggle.title = "按清单授予权限（高风险能力需要到扩展管理里逐项勾选）";
          toggle.addEventListener("click", async (event) => {
            stop(event);
            host.grantAccess(id);
            await host.activate(id, "consent");
            refresh();
          });
        } else if (record.status === "disabled") {
          toggle.textContent = "启用";
          toggle.addEventListener("click", async (event) => {
            stop(event);
            await host.enable(id);
            refresh();
          });
        } else {
          toggle.textContent = "停用";
          toggle.addEventListener("click", async (event) => {
            stop(event);
            await host.disable(id);
            refresh();
          });
        }
        const reload = document.createElement("button");
        reload.textContent = "重载";
        reload.addEventListener("click", async (event) => {
          stop(event);
          await host.reload(id);
          refresh();
        });
        actions.append(toggle, reload);
        row.append(main, actions);
        recordsEl.appendChild(row);
      }
    };
    const renderDetail = () => {
      detail.replaceChildren();
      const schema = activeId ? configuration.schema(activeId) : void 0;
      if (!schema) {
        const empty = document.createElement("div");
        empty.className = "xst-empty";
        empty.textContent = "当前没有任何扩展声明配置项。";
        detail.appendChild(empty);
        return;
      }
      const entries = Object.entries(schema.properties).sort((a, b) => (a[1].order ?? 100) - (b[1].order ?? 100));
      for (const [key, spec] of entries) {
        const row = document.createElement("div");
        row.className = "xst-row";
        const copy = document.createElement("div");
        copy.className = "xst-copy";
        const keyEl = document.createElement("div");
        keyEl.className = "xst-key";
        keyEl.textContent = key;
        const desc = document.createElement("div");
        desc.className = "xst-desc";
        desc.textContent = spec.description || spec.type + " · 默认 " + JSON.stringify(spec.default);
        copy.append(keyEl, desc);
        const control = document.createElement("div");
        control.className = "xst-control";
        control.appendChild(buildControl(activeId, key, spec));
        row.append(copy, control);
        detail.appendChild(row);
      }
      const actions = document.createElement("div");
      actions.className = "xst-actions";
      const reset = document.createElement("button");
      reset.textContent = "恢复默认";
      reset.addEventListener("click", () => {
        configuration.reset(activeId);
        renderDetail();
      });
      actions.appendChild(reset);
      detail.appendChild(actions);
    };
    const refresh = () => {
      records = host.list().sort((a, b) => a.manifest.id.localeCompare(b.manifest.id));
      pickActive();
      renderRows();
      renderDetail();
    };
    pickActive();
    renderRows();
    renderDetail();
  }
  function openExtensionSettings() {
    ensureConfigStyles();
    const mask = document.createElement("div");
    mask.className = "xst-mask";
    const shell = document.createElement("div");
    shell.className = "xst-shell";
    const head = document.createElement("div");
    head.className = "xst-head";
    const title = document.createElement("h3");
    title.textContent = "扩展配置";
    head.append(title);
    const pane = document.createElement("div");
    pane.style.cssText = "flex:1 1 auto;min-height:0;display:flex;";
    renderExtensionPane(pane);
    const foot = document.createElement("div");
    foot.className = "xst-foot";
    const hint = document.createElement("span");
    hint.className = "xst-hint";
    hint.textContent = "所有值按 schema 校验后写入 xhgcs.ext.config.v1";
    const done = document.createElement("button");
    done.textContent = "完成";
    foot.append(hint, done);
    const close = () => {
      document.removeEventListener("keydown", onKey, true);
      mask.remove();
    };
    const onKey = (event) => {
      if (event.key === "Escape") {
        event.preventDefault();
        close();
      }
    };
    document.addEventListener("keydown", onKey, true);
    done.addEventListener("click", close);
    mask.addEventListener("mousedown", (event) => {
      if (event.target === mask) close();
    });
    shell.append(head, pane, foot);
    mask.appendChild(shell);
    document.body.appendChild(mask);
  }
  const STYLE_ID$3 = "xhgcs-pipeline-style";
  function ensureStyles$3() {
    if (document.getElementById(STYLE_ID$3)) return;
    const style = document.createElement("style");
    style.id = STYLE_ID$3;
    style.textContent = `
.pipe-mask{position:fixed;inset:0;z-index:9680;background:rgba(6,10,16,.55);backdrop-filter:blur(2px);display:flex;align-items:center;justify-content:center}
.pipe-shell{width:min(820px,92vw);max-height:84vh;display:flex;flex-direction:column;background:var(--bg,#0d1117);
  border:1px solid var(--line,#2d333b);border-radius:14px;overflow:hidden;box-shadow:0 28px 70px rgba(0,0,0,.55)}
.pipe-head{display:flex;align-items:center;gap:10px;padding:12px 14px;border-bottom:1px solid var(--line,#2d333b);background:var(--bg2,#161b22)}
.pipe-head h3{margin:0;font-size:14px;color:var(--heading,#e6f2ff)}
.pipe-head .pipe-dot{width:7px;height:7px;border-radius:50%;background:var(--ok,#34d399);box-shadow:0 0 8px currentColor}
.pipe-head .pipe-dot[data-on="0"]{background:var(--text-dim,#7d8896);box-shadow:none}
.pipe-head button{margin-left:auto;border:0;background:transparent;color:var(--text-dim,#7d8896);font-size:16px;cursor:pointer;padding:4px 8px;border-radius:6px}
.pipe-head button:hover{background:var(--bg3,#1f2731);color:var(--text,#c9d4e0)}
.pipe-body{overflow:auto;padding:14px 16px 18px}
.pipe-grid{display:grid;grid-template-columns:repeat(4,minmax(0,1fr));gap:10px;margin-bottom:16px}
.pipe-card{border:1px solid var(--line,#2d333b);border-radius:10px;padding:10px 12px;background:var(--bg2,#161b22)}
.pipe-card b{display:block;font-size:19px;color:var(--heading,#e6f2ff);font-variant-numeric:tabular-nums;line-height:1.2}
.pipe-card small{display:block;color:var(--text-dim,#7d8896);font-size:11px;margin-top:4px}
.pipe-card[data-tone="warn"] b{color:var(--warn,#fbbf24)}
.pipe-card[data-tone="error"] b{color:var(--danger,#f87171)}
.pipe-card[data-tone="ok"] b{color:var(--ok,#34d399)}
.pipe-sec{font-size:11px;letter-spacing:.06em;text-transform:uppercase;color:var(--text-dim,#7d8896);margin:16px 0 8px}
.pipe-list{display:flex;flex-wrap:wrap;gap:8px}
.pipe-chip{display:inline-flex;align-items:center;gap:7px;border:1px solid var(--line,#2d333b);border-radius:999px;
  padding:5px 11px;font-size:12px;color:var(--text,#c9d4e0);background:var(--bg3,#1f2731);cursor:pointer;user-select:none}
.pipe-chip[data-on="0"]{opacity:.5}
.pipe-chip i{width:7px;height:7px;border-radius:50%;background:var(--acc,#6da8d2);font-style:normal}
.pipe-chip[data-on="0"] i{background:var(--text-dim,#7d8896)}
.pipe-err{margin-top:6px;font-size:11.5px;color:var(--warn,#fbbf24);font-family:ui-monospace,Consolas,monospace}
.pipe-foot{padding:10px 16px;border-top:1px solid var(--line,#2d333b);display:flex;gap:8px;align-items:center;background:var(--bg2,#161b22)}
.pipe-foot span{color:var(--text-dim,#7d8896);font-size:11px;margin-right:auto}
.pipe-foot button{border:1px solid var(--line,#2d333b);background:var(--bg3,#1f2731);color:var(--text,#c9d4e0);
  font-size:12px;padding:5px 12px;border-radius:7px;cursor:pointer}
.pipe-foot button:hover{border-color:var(--acc,#6da8d2);color:var(--heading,#e6f2ff)}
.pipe-empty{color:var(--text-dim,#7d8896);font-size:12px}
.pipe-params{margin-top:10px;display:flex;flex-direction:column;gap:8px}
.pipe-param-row{display:flex;flex-wrap:wrap;align-items:center;gap:8px 12px;padding:9px 11px;border:1px solid rgba(255,255,255,.08);
  border-radius:9px;background:rgba(255,255,255,.02)}
.pipe-param-name{font-size:11.5px;color:var(--acc,#6da8d2);min-width:74px}
.pipe-param-field{display:inline-flex;align-items:center;gap:6px;font-size:11px;color:var(--text-dim,#7d8896)}
.pipe-param-field input[type="number"],.pipe-param-field input[type="text"]{width:92px;height:26px;border-radius:7px;
  border:1px solid rgba(255,255,255,.12);background:rgba(255,255,255,.05);color:var(--text,#c9d4e0);
  font:11.5px/1 inherit;padding:0 7px;outline:none}
.pipe-param-field input:focus{border-color:var(--acc,#6da8d2);box-shadow:0 0 0 2px rgba(var(--acc-rgb), .18)}
.pipe-param-field input[type="checkbox"]{accent-color:var(--acc,#6da8d2)}
`;
    document.head.appendChild(style);
  }
  function openPipelinePanel() {
    ensureStyles$3();
    let unsubscribe = null;
    let timer = null;
    const mask = document.createElement("div");
    mask.className = "pipe-mask";
    const shell = document.createElement("div");
    shell.className = "pipe-shell";
    const head = document.createElement("div");
    head.className = "pipe-head";
    const dot = document.createElement("span");
    dot.className = "pipe-dot";
    const title = document.createElement("h3");
    title.textContent = "数据管线";
    const closeBtn = document.createElement("button");
    closeBtn.textContent = "✕";
    head.append(dot, title, closeBtn);
    const body = document.createElement("div");
    body.className = "pipe-body";
    const grid = document.createElement("div");
    grid.className = "pipe-grid";
    const opSection = document.createElement("div");
    const sourceSection = document.createElement("div");
    const sinkSection = document.createElement("div");
    const errSection = document.createElement("div");
    body.append(grid, sourceSection, opSection, sinkSection, errSection);
    const foot = document.createElement("div");
    foot.className = "pipe-foot";
    const hint = document.createElement("span");
    hint.textContent = "Source → Operator → Sink · 每帧带时间戳 · 入口有界，满了丢最旧";
    const reset = document.createElement("button");
    reset.textContent = "重置计数";
    const done = document.createElement("button");
    done.textContent = "完成";
    foot.append(hint, reset, done);
    shell.append(head, body, foot);
    mask.appendChild(shell);
    document.body.appendChild(mask);
    let disposeOverlay = () => void 0;
    const close = () => {
      disposeOverlay();
      if (unsubscribe) unsubscribe();
      if (timer != null) window.clearInterval(timer);
      mask.remove();
    };
    disposeOverlay = pushOverlay({ id: "pipeline", kind: "modal", close });
    closeBtn.addEventListener("click", close);
    done.addEventListener("click", close);
    mask.addEventListener("mousedown", (event) => {
      if (event.target === mask) close();
    });
    const card = (label, value, tone) => {
      const el = document.createElement("div");
      el.className = "pipe-card";
      if (tone) el.dataset.tone = tone;
      const b = document.createElement("b");
      b.textContent = value;
      const small = document.createElement("small");
      small.textContent = label;
      el.append(b, small);
      return el;
    };
    const renderMetrics = (metrics) => {
      dot.dataset.on = metrics.running ? "1" : "0";
      grid.replaceChildren(
        card("已处理帧", String(metrics.processed), "ok"),
        card("积压队列", `${metrics.queued} / ${metrics.capacity}`, metrics.queued > metrics.capacity * 0.8 ? "warn" : void 0),
        card("丢弃帧", String(metrics.dropped), metrics.dropped ? "warn" : void 0),
        card("阶段错误", String(metrics.errors), metrics.errors ? "error" : void 0),
        card("平均处理耗时", metrics.avgLatencyMs ? metrics.avgLatencyMs.toFixed(2) + " ms" : "—"),
        card("峰值队列", String(metrics.peakQueue)),
        card("最后帧 t", metrics.lastT ? metrics.lastT.toFixed(2) + " s" : "—"),
        card("最近一帧", metrics.lastFrameAt ? new Date(metrics.lastFrameAt).toLocaleTimeString() : "—")
      );
    };
    const renderSources = () => {
      sourceSection.replaceChildren();
      const head2 = document.createElement("div");
      head2.className = "pipe-sec";
      head2.textContent = "数据源（点击启停）";
      sourceSection.appendChild(head2);
      const list = document.createElement("div");
      list.className = "pipe-list";
      const metrics = pipeline.metrics();
      if (!metrics.sources.length) {
        const empty = document.createElement("span");
        empty.className = "pipe-empty";
        empty.textContent = "没有注册任何数据源";
        list.appendChild(empty);
      }
      for (const source of metrics.sources) {
        const chip = document.createElement("button");
        chip.className = "pipe-chip";
        chip.dataset.on = source.running ? "1" : "0";
        const mark = document.createElement("i");
        const label = document.createElement("span");
        label.textContent = source.label;
        chip.title = source.id;
        chip.append(mark, label);
        chip.addEventListener("click", () => {
          if (pipeline.isSourceRunning(source.id)) pipeline.stopSource(source.id);
          else pipeline.startSource(source.id);
          renderSources();
          renderMetrics(pipeline.metrics());
        });
        list.appendChild(chip);
      }
      sourceSection.appendChild(list);
      const tools = document.createElement("div");
      tools.className = "pipe-list";
      tools.style.marginTop = "8px";
      const recording = pipeline.metrics().sinks.includes("builtin.record");
      const rec = document.createElement("button");
      rec.className = "pipe-chip";
      rec.dataset.on = recording ? "1" : "0";
      rec.append(Object.assign(document.createElement("i"), {}), Object.assign(document.createElement("span"), { textContent: `内存录制 · ${recorder.size} 帧` }));
      rec.addEventListener("click", () => {
        pipeline.setSinkEnabled("builtin.record", !pipeline.metrics().sinks.includes("builtin.record"));
        renderSources();
      });
      const replayBtn = document.createElement("button");
      replayBtn.className = "pipe-chip";
      replayBtn.append(Object.assign(document.createElement("i"), {}), Object.assign(document.createElement("span"), { textContent: "回放 ×4" }));
      replayBtn.addEventListener("click", () => {
        pipeline.stopSource("builtin.replay");
        pipeline.startSource("builtin.replay");
        renderSources();
      });
      const stopReplay = document.createElement("button");
      stopReplay.className = "pipe-chip";
      stopReplay.dataset.on = "0";
      stopReplay.append(Object.assign(document.createElement("i"), {}), Object.assign(document.createElement("span"), { textContent: "停止回放" }));
      stopReplay.addEventListener("click", () => {
        pipeline.stopSource("builtin.replay");
        renderSources();
      });
      const clear = document.createElement("button");
      clear.className = "pipe-chip";
      clear.dataset.on = "0";
      clear.append(Object.assign(document.createElement("i"), {}), Object.assign(document.createElement("span"), { textContent: "清空录制" }));
      clear.addEventListener("click", () => {
        recorder.clear();
        renderSources();
      });
      tools.append(rec, replayBtn, stopReplay, clear);
      sourceSection.appendChild(tools);
    };
    const renderStages = () => {
      opSection.replaceChildren();
      const opHead = document.createElement("div");
      opHead.className = "pipe-sec";
      opHead.textContent = "处理阶段（点击启停）";
      opSection.appendChild(opHead);
      const opList = document.createElement("div");
      opList.className = "pipe-list";
      const operators2 = pipeline.operatorList();
      if (!operators2.length) {
        const empty = document.createElement("span");
        empty.className = "pipe-empty";
        empty.textContent = "没有注册任何阶段";
        opList.appendChild(empty);
      }
      for (const operator of operators2) {
        const on = pipeline.isOperatorEnabled(operator.id);
        const chip = document.createElement("button");
        chip.className = "pipe-chip";
        chip.dataset.on = on ? "1" : "0";
        chip.textContent = "";
        const mark = document.createElement("i");
        const label = document.createElement("span");
        label.textContent = operator.label;
        chip.title = operator.id;
        chip.append(mark, label);
        chip.addEventListener("click", () => {
          pipeline.setOperatorEnabled(operator.id, !on);
          renderStages();
        });
        opList.appendChild(chip);
      }
      opSection.appendChild(opList);
      const paramRows = document.createElement("div");
      paramRows.className = "pipe-params";
      for (const operator of operators2) {
        if (!operator.params || !operator.params.length) continue;
        const values = pipeline.operatorParamValues(operator.id);
        const row = document.createElement("div");
        row.className = "pipe-param-row";
        const name = document.createElement("span");
        name.className = "pipe-param-name";
        name.textContent = operator.label;
        row.appendChild(name);
        for (const spec of operator.params) {
          const fieldLabel = document.createElement("label");
          fieldLabel.className = "pipe-param-field";
          const text = document.createElement("span");
          text.textContent = spec.label;
          const input = document.createElement("input");
          if (spec.type === "boolean") {
            input.type = "checkbox";
            input.checked = Boolean(values[spec.key] ?? spec.default);
            input.addEventListener("change", () => {
              pipeline.setOperatorParams(operator.id, { [spec.key]: input.checked });
              renderStages();
            });
          } else {
            input.type = spec.type === "number" ? "number" : "text";
            if (spec.min != null) input.min = String(spec.min);
            if (spec.max != null) input.max = String(spec.max);
            if (spec.step != null) input.step = String(spec.step);
            input.value = values[spec.key] == null ? String(spec.default) : String(values[spec.key]);
            input.addEventListener("change", () => {
              const raw = spec.type === "number" ? Number(input.value) : input.value;
              pipeline.setOperatorParams(operator.id, { [spec.key]: raw });
              renderStages();
            });
          }
          fieldLabel.append(text, input);
          row.appendChild(fieldLabel);
        }
        paramRows.appendChild(row);
      }
      if (paramRows.childElementCount) opSection.appendChild(paramRows);
      sinkSection.replaceChildren();
      const sinkHead = document.createElement("div");
      sinkHead.className = "pipe-sec";
      sinkHead.textContent = "端点（点击启停）";
      sinkSection.appendChild(sinkHead);
      const sinkList = document.createElement("div");
      sinkList.className = "pipe-list";
      const sinks = pipeline.sinkList();
      if (!sinks.length) {
        const empty = document.createElement("span");
        empty.className = "pipe-empty";
        empty.textContent = "没有注册任何端点";
        sinkList.appendChild(empty);
      }
      for (const sink of sinks) {
        const chip = document.createElement("button");
        chip.className = "pipe-chip";
        const mark = document.createElement("i");
        const label = document.createElement("span");
        label.textContent = sink.label;
        chip.title = sink.id;
        chip.append(mark, label);
        chip.dataset.on = pipeline.metrics().sinks.includes(sink.id) ? "1" : "0";
        chip.addEventListener("click", () => {
          const enabled = chip.dataset.on === "1";
          pipeline.setSinkEnabled(sink.id, !enabled);
          chip.dataset.on = enabled ? "0" : "1";
        });
        sinkList.appendChild(chip);
      }
      sinkSection.appendChild(sinkList);
      errSection.replaceChildren();
      const errors = pipeline.recentErrorList();
      if (errors.length) {
        const errHead = document.createElement("div");
        errHead.className = "pipe-sec";
        errHead.textContent = "最近错误";
        errSection.appendChild(errHead);
        for (const error of errors) {
          const line = document.createElement("div");
          line.className = "pipe-err";
          line.textContent = `${new Date(error.at).toLocaleTimeString()} · ${error.id} · ${error.message}`;
          errSection.appendChild(line);
        }
      }
    };
    unsubscribe = pipeline.onMetricsChange(renderMetrics);
    timer = window.setInterval(() => {
      renderMetrics(pipeline.metrics());
    }, 500);
    renderMetrics(pipeline.metrics());
    renderSources();
    renderStages();
    reset.addEventListener("click", () => {
      pipeline.resetCounters();
      renderMetrics(pipeline.metrics());
    });
  }
  const FALLBACK = {
    fg: "#c9d4e0",
    dim: "#7d8896",
    line: "#2d333b",
    acc: "#6da8d2",
    warn: "#fbbf24",
    ok: "#34d399",
    danger: "#f87171",
    bg: "#161b22"
  };
  function readTheme(el) {
    const base = el || document.body;
    const read = (name, fallback) => {
      try {
        const value = getComputedStyle(base).getPropertyValue(name).trim();
        return value || fallback;
      } catch {
        return fallback;
      }
    };
    return {
      fg: read("--text", FALLBACK.fg),
      dim: read("--text-dim", FALLBACK.dim),
      line: read("--line", FALLBACK.line),
      acc: read("--acc", FALLBACK.acc),
      warn: read("--warn", FALLBACK.warn),
      ok: read("--ok", FALLBACK.ok),
      danger: read("--danger", FALLBACK.danger),
      bg: read("--bg2", FALLBACK.bg)
    };
  }
  function fitCanvas(canvas, host2) {
    const width = Math.max(1, Math.floor(host2.clientWidth));
    const height = Math.max(1, Math.floor(host2.clientHeight));
    const dpr = Math.max(1, Math.min(3, window.devicePixelRatio || 1));
    if (canvas.width !== Math.floor(width * dpr) || canvas.height !== Math.floor(height * dpr)) {
      canvas.width = Math.floor(width * dpr);
      canvas.height = Math.floor(height * dpr);
    }
    canvas.style.width = width + "px";
    canvas.style.height = height + "px";
    const ctx = canvas.getContext("2d");
    if (!ctx) return null;
    ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
    ctx.clearRect(0, 0, width, height);
    return { ctx, width, height, dpr };
  }
  const INSET = { left: 34, right: 10, top: 12, bottom: 18 };
  function laneKit() {
    const views = window.XHGCS_VIEWS;
    const kit = views && views.chartLaneKit;
    if (!kit) return null;
    if (typeof kit.laneDomain !== "function" || typeof kit.laneYOf !== "function" || typeof kit.laneGapFor !== "function") return null;
    return kit;
  }
  function drawLaneChart(frame, list, theme, opts, plot, kit) {
    const { ctx } = frame;
    const count = list.length;
    const gap = Math.max(0, Number(kit.laneGapFor(count, plot.h)) || 0);
    const laneH = (plot.h - gap * (count - 1)) / count;
    if (!(laneH > 4)) {
      drawSingleAxis(frame, list, theme, opts, plot);
      return;
    }
    const lanes = list.map((item, index) => {
      const values = opts.normalize ? normalizeValues(item.values) : item.values;
      const fallback = (() => {
        const range = valueRange([{ ...item, values }], false);
        const ticks = niceTicks(range.min, range.max, 4);
        return { yMin: range.min, yMax: range.max, ticks, step: ticks.length > 1 ? ticks[1] - ticks[0] : 1 };
      })();
      const domain = kit.laneDomain([{ data: values }], { targetTicks: 4 }) || fallback;
      const top = plot.y + index * (laneH + gap);
      return { item, values, domain, top, bot: top + laneH };
    });
    lanes.forEach((lane) => {
      const yOf = (value) => kit.laneYOf(value, { top: lane.top, h: laneH, yMin: lane.domain.yMin, yMax: lane.domain.yMax });
      ctx.save();
      ctx.beginPath();
      ctx.rect(plot.x, lane.top, plot.w, laneH);
      ctx.clip();
      if (opts.grid !== false) {
        ctx.strokeStyle = theme.line;
        ctx.globalAlpha = 0.55;
        ctx.lineWidth = 1;
        lane.domain.ticks.forEach((tick) => {
          const y = Math.round(yOf(tick)) + 0.5;
          ctx.beginPath();
          ctx.moveTo(plot.x, y);
          ctx.lineTo(plot.x + plot.w, y);
          ctx.stroke();
        });
        ctx.globalAlpha = 1;
      }
      if (lane.values.length >= 2) {
        ctx.beginPath();
        for (let i = 0; i < lane.values.length; i++) {
          const x = plot.x + i / (lane.values.length - 1) * plot.w;
          const y = yOf(lane.values[i]);
          if (i === 0) ctx.moveTo(x, y);
          else ctx.lineTo(x, y);
        }
        ctx.strokeStyle = lane.item.color;
        ctx.lineWidth = 1.6;
        ctx.lineJoin = "round";
        ctx.stroke();
        if (opts.fill !== false) {
          ctx.lineTo(plot.x + plot.w, lane.bot);
          ctx.lineTo(plot.x, lane.bot);
          ctx.closePath();
          const alpha = count > 1 ? 0.1 : 0.22;
          const gradient = ctx.createLinearGradient(0, lane.top, 0, lane.bot);
          gradient.addColorStop(0, hexToRgba(lane.item.color, alpha));
          gradient.addColorStop(1, hexToRgba(lane.item.color, 0));
          ctx.fillStyle = gradient;
          ctx.fill();
        }
      }
      ctx.restore();
      ctx.fillStyle = theme.dim;
      ctx.font = '10px "Segoe UI", system-ui, sans-serif';
      ctx.textAlign = "right";
      ctx.textBaseline = "middle";
      lane.domain.ticks.forEach((tick) => {
        const ty = Math.max(lane.top + 7, Math.min(lane.bot - 7, yOf(tick)));
        ctx.fillText(fmtTick(tick), plot.x - 6, ty);
      });
      const label = lane.item.unit ? lane.item.label + " " + lane.item.unit : lane.item.label;
      const text = label.length > 18 ? label.slice(0, 17) + "…" : label;
      ctx.font = '11px "Segoe UI", "Microsoft YaHei", system-ui, sans-serif';
      ctx.textAlign = "left";
      ctx.textBaseline = "top";
      ctx.fillStyle = lane.item.color;
      ctx.fillRect(plot.x + 2, lane.top + 4, 6, 3);
      ctx.fillStyle = theme.dim;
      ctx.fillText(text, plot.x + 12, lane.top + 1);
    });
  }
  function drawSingleAxis(frame, list, theme, opts, plot) {
    const { ctx, width } = frame;
    const range = valueRange(list, Boolean(opts.normalize));
    const span = range.max - range.min || 1;
    const project = (value) => plot.y + plot.h - (value - range.min) / span * plot.h;
    if (opts.grid !== false) {
      ctx.strokeStyle = theme.line;
      ctx.globalAlpha = 0.55;
      ctx.lineWidth = 1;
      const ticks = niceTicks(range.min, range.max, 4);
      ticks.forEach((tick) => {
        const y = Math.round(project(tick)) + 0.5;
        ctx.beginPath();
        ctx.moveTo(plot.x, y);
        ctx.lineTo(plot.x + plot.w, y);
        ctx.stroke();
      });
      ctx.globalAlpha = 1;
      ctx.fillStyle = theme.dim;
      ctx.font = '10px "Segoe UI", system-ui, sans-serif';
      ctx.textAlign = "right";
      ctx.textBaseline = "middle";
      ticks.forEach((tick) => ctx.fillText(fmtTick(tick), plot.x - 6, project(tick)));
    }
    list.forEach((item) => {
      const values = opts.normalize ? normalizeValues(item.values) : item.values;
      const n = values.length;
      if (n < 2) return;
      ctx.beginPath();
      for (let i = 0; i < n; i++) {
        const x = plot.x + i / (n - 1) * plot.w;
        const y = project(values[i]);
        if (i === 0) ctx.moveTo(x, y);
        else ctx.lineTo(x, y);
      }
      ctx.strokeStyle = item.color;
      ctx.lineWidth = 1.6;
      ctx.lineJoin = "round";
      ctx.stroke();
      if (opts.fill !== false) {
        ctx.lineTo(plot.x + plot.w, plot.y + plot.h);
        ctx.lineTo(plot.x, plot.y + plot.h);
        ctx.closePath();
        const alpha = list.length > 1 ? 0.1 : 0.22;
        const gradient = ctx.createLinearGradient(0, plot.y, 0, plot.y + plot.h);
        gradient.addColorStop(0, hexToRgba(item.color, alpha));
        gradient.addColorStop(1, hexToRgba(item.color, 0));
        ctx.fillStyle = gradient;
        ctx.fill();
      }
    });
    if (list.length > 1) {
      ctx.font = '10px "Segoe UI", system-ui, sans-serif';
      ctx.textAlign = "left";
      ctx.textBaseline = "top";
      let x = plot.x + 2;
      const y = 2;
      for (const item of list) {
        ctx.fillStyle = item.color;
        ctx.fillRect(x, y + 3, 6, 3);
        x += 9;
        ctx.fillStyle = theme.dim;
        const label = item.label.length > 10 ? item.label.slice(0, 9) + "…" : item.label;
        ctx.fillText(label, x, y);
        x += ctx.measureText(label).width + 10;
        if (x > width - 40) break;
      }
    }
  }
  function valueRange(series, normalize) {
    if (normalize) return { min: 0, max: 1 };
    let min = Infinity;
    let max = -Infinity;
    for (const item of series) {
      for (const value of item.values) {
        if (!Number.isFinite(value)) continue;
        if (value < min) min = value;
        if (value > max) max = value;
      }
    }
    if (!Number.isFinite(min) || !Number.isFinite(max)) return { min: 0, max: 1 };
    if (max - min < 1e-9) {
      const pad2 = Math.abs(max) * 0.1 || 1;
      return { min: min - pad2, max: max + pad2 };
    }
    const pad = (max - min) * 0.08;
    return { min: min - pad, max: max + pad };
  }
  function niceTicks(min, max, count = 4) {
    if (!Number.isFinite(min) || !Number.isFinite(max) || max <= min) return [min];
    const step = (max - min) / Math.max(1, count);
    const out = [];
    for (let i = 0; i <= count; i++) out.push(min + step * i);
    return out;
  }
  function fmtTick(value) {
    const abs = Math.abs(value);
    if (abs >= 1e3) return (value / 1e3).toFixed(abs >= 1e4 ? 0 : 1) + "k";
    if (abs >= 10) return value.toFixed(0);
    if (abs >= 1) return value.toFixed(1);
    if (abs === 0) return "0";
    return value.toFixed(2);
  }
  function drawEmpty(frame, theme, message) {
    const { ctx, width, height } = frame;
    ctx.fillStyle = theme.dim;
    ctx.font = '12px "Segoe UI", "Microsoft YaHei", system-ui, sans-serif';
    ctx.textAlign = "center";
    ctx.textBaseline = "middle";
    ctx.fillText(message, width / 2, height / 2);
  }
  function drawLineChart(frame, series, theme, opts = {}) {
    const { ctx, width, height } = frame;
    const list = series.filter((item) => item.values.length);
    if (!list.length) {
      drawEmpty(frame, theme, "未绑定通道");
      return;
    }
    const plot = {
      x: INSET.left,
      y: INSET.top,
      w: Math.max(10, width - INSET.left - INSET.right),
      h: Math.max(10, height - INSET.top - INSET.bottom)
    };
    const kit = list.length > 1 ? laneKit() : null;
    if (kit) {
      drawLaneChart(frame, list, theme, opts, plot, kit);
      return;
    }
    const range = valueRange(list, Boolean(opts.normalize));
    const span = range.max - range.min || 1;
    const project = (value) => plot.y + plot.h - (value - range.min) / span * plot.h;
    if (opts.grid !== false) {
      ctx.strokeStyle = theme.line;
      ctx.globalAlpha = 0.55;
      ctx.lineWidth = 1;
      const ticks = niceTicks(range.min, range.max, 4);
      ticks.forEach((tick) => {
        const y = Math.round(project(tick)) + 0.5;
        ctx.beginPath();
        ctx.moveTo(plot.x, y);
        ctx.lineTo(plot.x + plot.w, y);
        ctx.stroke();
      });
      ctx.globalAlpha = 1;
      ctx.fillStyle = theme.dim;
      ctx.font = '10px "Segoe UI", system-ui, sans-serif';
      ctx.textAlign = "right";
      ctx.textBaseline = "middle";
      ticks.forEach((tick) => ctx.fillText(fmtTick(tick), plot.x - 6, project(tick)));
    }
    list.forEach((item) => {
      const values = opts.normalize ? normalizeValues(item.values) : item.values;
      const count = values.length;
      if (count < 2) return;
      ctx.beginPath();
      for (let i = 0; i < count; i++) {
        const x = plot.x + i / (count - 1) * plot.w;
        const y = project(values[i]);
        if (i === 0) ctx.moveTo(x, y);
        else ctx.lineTo(x, y);
      }
      ctx.strokeStyle = item.color;
      ctx.lineWidth = 1.6;
      ctx.lineJoin = "round";
      ctx.stroke();
      if (opts.fill !== false) {
        ctx.lineTo(plot.x + plot.w, plot.y + plot.h);
        ctx.lineTo(plot.x, plot.y + plot.h);
        ctx.closePath();
        const alpha = list.length > 1 ? 0.1 : 0.22;
        const gradient = ctx.createLinearGradient(0, plot.y, 0, plot.y + plot.h);
        gradient.addColorStop(0, hexToRgba(item.color, alpha));
        gradient.addColorStop(1, hexToRgba(item.color, 0));
        ctx.fillStyle = gradient;
        ctx.fill();
      }
    });
    if (list.length > 1) {
      ctx.font = '10px "Segoe UI", system-ui, sans-serif';
      ctx.textAlign = "left";
      ctx.textBaseline = "top";
      let x = plot.x + 2;
      const y = 2;
      for (const item of list) {
        ctx.fillStyle = item.color;
        ctx.fillRect(x, y + 3, 6, 3);
        x += 9;
        ctx.fillStyle = theme.dim;
        const label = item.label.length > 10 ? item.label.slice(0, 9) + "…" : item.label;
        ctx.fillText(label, x, y);
        x += ctx.measureText(label).width + 10;
        if (x > width - 40) break;
      }
    }
  }
  function normalizeValues(values) {
    const min = Math.min(...values);
    const max = Math.max(...values);
    const span = max - min || 1;
    return values.map((value) => (value - min) / span);
  }
  function hexToRgba(color, alpha) {
    const text = String(color || "").trim();
    if (text.startsWith("#")) {
      const hex = text.length === 4 ? text.replace(/#(.)(.)(.)/, "#$1$1$2$2$3$3") : text;
      const value = Number.parseInt(hex.slice(1), 16);
      if (Number.isFinite(value)) {
        const r = value >> 16 & 255;
        const g = value >> 8 & 255;
        const b = value & 255;
        return `rgba(${r}, ${g}, ${b}, ${alpha})`;
      }
    }
    return text;
  }
  function drawGauge(frame, value, opts, theme) {
    const { ctx, width, height } = frame;
    if (!Number.isFinite(value)) {
      drawEmpty(frame, theme, "未绑定通道");
      return;
    }
    const min = Number(opts.min ?? 0);
    const max = Number(opts.max ?? 100) || 1;
    const ratio = Math.max(0, Math.min(1, (value - min) / (max - min || 1)));
    const cx = width / 2;
    const cy = height * 0.62;
    const radius = Math.max(18, Math.min(width, height * 1.6) * 0.34);
    const start = Math.PI * 0.75;
    const end = Math.PI * 2.25;
    ctx.lineCap = "round";
    ctx.lineWidth = Math.max(6, radius * 0.16);
    ctx.strokeStyle = theme.line;
    ctx.beginPath();
    ctx.arc(cx, cy, radius, start, end);
    ctx.stroke();
    const tone = ratio > 0.85 ? theme.danger : ratio > 0.65 ? theme.warn : theme.ok;
    ctx.strokeStyle = tone;
    ctx.beginPath();
    ctx.arc(cx, cy, radius, start, start + (end - start) * ratio);
    ctx.stroke();
    ctx.fillStyle = theme.fg;
    ctx.textAlign = "center";
    ctx.textBaseline = "middle";
    ctx.font = `700 ${Math.min(32, Math.max(14, Math.round(radius * 0.52)))}px "Segoe UI", system-ui, sans-serif`;
    const text = Math.abs(value) >= 100 ? value.toFixed(0) : Math.abs(value) >= 1 ? value.toFixed(2) : value.toFixed(3);
    ctx.fillText(text + (opts.unit ? " " + opts.unit : ""), cx, cy);
    ctx.font = '11px "Segoe UI", "Microsoft YaHei", system-ui, sans-serif';
    ctx.fillStyle = theme.dim;
    ctx.fillText(opts.label || "", cx, cy + radius * 0.5);
  }
  function drawBars(frame, items, theme, opts = {}) {
    const { ctx, width, height } = frame;
    if (!items.length) {
      drawEmpty(frame, theme, "未绑定通道");
      return;
    }
    const left = 8;
    const right = 8;
    const bottom = 20;
    const top = 10;
    const slot = (width - left - right) / items.length;
    const barWidth = Math.max(6, Math.min(34, slot * 0.55));
    const min = Number(opts.min ?? 0);
    const max = Number(opts.max ?? Math.max(...items.map((item) => Math.abs(item.value)), 1));
    const span = max - min || 1;
    const baseY = height - bottom;
    const usable = Math.max(10, baseY - top);
    ctx.font = '10px "Segoe UI", "Microsoft YaHei", system-ui, sans-serif';
    items.forEach((item, index) => {
      const ratio = Math.max(0, Math.min(1, (item.value - min) / span));
      const barHeight = Math.max(2, ratio * usable);
      const cx = left + slot * index + slot / 2;
      const x = cx - barWidth / 2;
      ctx.fillStyle = hexToRgba(item.color, 0.85);
      roundRect(ctx, x, baseY - barHeight, barWidth, barHeight, Math.min(4, barWidth / 2));
      ctx.fill();
      ctx.fillStyle = theme.dim;
      ctx.textAlign = "center";
      ctx.textBaseline = "top";
      const label = item.label.length > 6 ? item.label.slice(0, 5) + "…" : item.label;
      ctx.fillText(label, cx, baseY + 4);
    });
  }
  function drawDonut(frame, items, theme) {
    const { ctx, width, height } = frame;
    const list = items.filter((item) => Number.isFinite(item.value) && item.value > 0);
    if (!list.length) {
      drawEmpty(frame, theme, "未绑定通道");
      return;
    }
    const cx = width / 2;
    const cy = height / 2;
    const radius = Math.max(16, Math.min(width, height) * 0.34);
    const inner = radius * 0.62;
    const total = list.reduce((sum, item) => sum + item.value, 0);
    let angle = -Math.PI / 2;
    list.forEach((item) => {
      const slice = item.value / total * Math.PI * 2;
      ctx.beginPath();
      ctx.moveTo(cx, cy);
      ctx.arc(cx, cy, radius, angle, angle + slice);
      ctx.closePath();
      ctx.fillStyle = item.color;
      ctx.fill();
      angle += slice;
    });
    ctx.beginPath();
    ctx.arc(cx, cy, inner, 0, Math.PI * 2);
    ctx.fillStyle = theme.bg;
    ctx.fill();
    ctx.fillStyle = theme.dim;
    ctx.font = '10px "Segoe UI", system-ui, sans-serif';
    ctx.textAlign = "center";
    ctx.textBaseline = "middle";
    ctx.fillText(list.length + " 项", cx, cy);
  }
  function drawTable(frame, rows, theme) {
    const { ctx, width, height } = frame;
    if (!rows.length) {
      drawEmpty(frame, theme, "未绑定通道");
      return;
    }
    const header = 16;
    const rowHeight = Math.max(18, (height - header - 6) / rows.length);
    const maxRows = Math.max(1, Math.floor((height - header) / rowHeight));
    const visible = rows.slice(0, maxRows);
    const fontSize = Math.max(11, Math.min(15, rowHeight * 0.58));
    ctx.font = `${fontSize}px "Segoe UI", "Microsoft YaHei", system-ui, sans-serif`;
    ctx.textBaseline = "middle";
    visible.forEach((row, index) => {
      const y = header + index * rowHeight;
      if (index % 2 === 0) {
        ctx.fillStyle = hexToRgba(theme.fg, 0.04);
        ctx.fillRect(4, y, width - 8, rowHeight);
      }
      ctx.fillStyle = row.color;
      ctx.fillRect(8, y + rowHeight / 2 - 3, 6, 6);
      ctx.fillStyle = theme.fg;
      ctx.textAlign = "left";
      ctx.fillText(row.name.length > 14 ? row.name.slice(0, 13) + "…" : row.name, 20, y + rowHeight / 2);
      ctx.textAlign = "right";
      ctx.fillStyle = theme.dim;
      ctx.fillText(row.value + (row.unit ? " " + row.unit : ""), width - 10, y + rowHeight / 2);
    });
  }
  function roundRect(ctx, x, y, w, h, r) {
    const radius = Math.max(0, Math.min(r, w / 2, h / 2));
    ctx.beginPath();
    ctx.moveTo(x + radius, y);
    ctx.arcTo(x + w, y, x + w, y + h, radius);
    ctx.arcTo(x + w, y + h, x, y + h, radius);
    ctx.arcTo(x, y + h, x, y, radius);
    ctx.arcTo(x, y, x + w, y, radius);
    ctx.closePath();
  }
  const STYLE_ID$2 = "xhgcs-view-container-style";
  function legacyChannels() {
    const state = window.XHGCS?.state;
    if (!state) return [];
    const list = [];
    if (Array.isArray(state.channels)) list.push(...state.channels);
    if (Array.isArray(state.scriptChannels)) list.push(...state.scriptChannels);
    return list;
  }
  function ensureStyles$2() {
    if (document.getElementById(STYLE_ID$2)) return;
    const style = document.createElement("style");
    style.id = STYLE_ID$2;
    style.textContent = `
/* 插件视图容器：统一 L3 浮层（B6 第二批）。只换令牌与材质，不改行为。 */
.vc-mask{position:fixed;inset:0;z-index:9620;background:rgba(4,7,11,.55);display:flex;align-items:center;justify-content:center}
html[data-theme="light"] .vc-mask{background:rgba(15,23,42,.32)}
html[data-fx="glass"] .vc-mask{backdrop-filter:blur(4px)}
.vc-shell{width:min(1080px,94vw);height:min(760px,88vh);display:flex;flex-direction:column;
  background-color:var(--surf-3,#242c36);background-image:var(--surf-sheen,none);background-size:100% 40%;background-repeat:no-repeat;
  border:0;border-radius:var(--r-overlay,16px);overflow:hidden;box-shadow:var(--elev-3,0 30px 72px -16px rgba(0,0,0,.62));
  backdrop-filter:var(--surf-blur-strong,none)}
.vc-head{display:flex;align-items:center;gap:8px;padding:11px 14px;border-bottom:0;background:transparent}
.vc-head h3{margin:0;font-size:var(--fs-14,14px);font-weight:600;color:var(--heading,#e9f1fa)}
.vc-head .vc-tag{font-size:var(--fs-10,10px);color:var(--text-dim,#8b97a5);border:1px solid var(--edge-soft,rgba(255,255,255,.035));border-radius:999px;padding:1px 8px}
.vc-head button{margin-left:auto;border:0;background:transparent;color:var(--text-dim,#8b97a5);font-size:var(--fs-13,13px);cursor:pointer;padding:3px 8px;border-radius:var(--r-ctl,6px)}
.vc-head button:hover{background:var(--surf-hover,rgba(255,255,255,.045));color:var(--text,#c7d1dc)}
.vc-body{flex:1 1 auto;display:flex;min-height:0}
.vc-nav{width:210px;flex:0 0 210px;overflow:auto;padding:8px;background:var(--surf-inset,#0b0e13)}
.vc-nav-item{width:100%;display:flex;align-items:center;gap:8px;border:0;background:transparent;color:var(--text,#c7d1dc);
  font-size:var(--fs-12,12px);line-height:1.4;font-family:inherit;padding:8px 10px;border-radius:var(--r-ctl,6px);cursor:pointer;text-align:left}
.vc-nav-item:hover{background:var(--surf-hover,rgba(255,255,255,.045))}
.vc-nav-item[data-active="1"]{background:var(--acc-soft,rgba(109,168,210,.14));color:var(--acc-text,#a9d4ef)}
.vc-nav-item i{font-style:normal;color:var(--acc,#6da8d2);width:16px;text-align:center}
.vc-nav-item[data-active="1"] i{color:inherit}
.vc-nav-item small{margin-left:auto;color:var(--text-dim,#8b97a5);font-size:var(--fs-10,10px)}
.vc-sec{font-size:var(--fs-10,10px);letter-spacing:.08em;color:var(--text-dim,#8b97a5);margin:12px 6px 5px}
.vc-stage{flex:1 1 auto;min-width:0;position:relative;overflow:hidden;background:var(--surf-inset,#0b0e13)}
.vc-host{position:absolute;inset:0;padding:12px;overflow:hidden}
.vc-host canvas{display:block}
.vc-empty{position:absolute;inset:0;display:flex;flex-direction:column;align-items:center;justify-content:center;gap:8px;
  color:var(--text-dim,#8b97a5);font-size:var(--fs-12,12px);line-height:1.7;text-align:center;padding:0 24px}
.vc-empty b{color:var(--warn,#e0a34a);font-weight:600;font-size:var(--fs-13,13px)}
.vc-foot{padding:8px 14px;border-top:0;display:flex;gap:10px;align-items:center;
  background:transparent;color:var(--text-dim,#8b97a5);font-size:var(--fs-11,11px)}
.vc-foot .vc-err{color:var(--danger-text,#f28c8c)}
`;
    document.head.appendChild(style);
  }
  function findImplementation(viewId) {
    for (const entry of registry.all("views")) {
      if (entry.value.id !== viewId) continue;
      const runtime = host.runtime.views.get(`${entry.owner}:${viewId}`);
      if (runtime?.implementation) return { owner: entry.owner, impl: runtime.implementation };
    }
    return null;
  }
  function legacyViews() {
    const list = window.XHGCS?.state?.views;
    return Array.isArray(list) ? list.filter((item) => item && item.id && typeof item.code === "string") : [];
  }
  function openViewContainer(preferredId) {
    if (document.querySelector(".vc-mask")) return;
    ensureStyles$2();
    const mask = document.createElement("div");
    mask.className = "vc-mask";
    const shell = document.createElement("div");
    shell.className = "vc-shell";
    const head = document.createElement("div");
    head.className = "vc-head";
    const title = document.createElement("h3");
    title.textContent = "插件视图";
    const tag = document.createElement("span");
    tag.className = "vc-tag";
    tag.textContent = "views 贡献点";
    const closeBtn = document.createElement("button");
    closeBtn.textContent = "✕";
    head.append(title, tag, closeBtn);
    const body = document.createElement("div");
    body.className = "vc-body";
    const nav = document.createElement("div");
    nav.className = "vc-nav";
    const stage = document.createElement("div");
    stage.className = "vc-stage";
    const hostEl = document.createElement("div");
    hostEl.className = "vc-host";
    const empty = document.createElement("div");
    empty.className = "vc-empty";
    stage.append(hostEl, empty);
    body.append(nav, stage);
    const foot = document.createElement("div");
    foot.className = "vc-foot";
    const footText = document.createElement("span");
    footText.textContent = "插件视图只拿到 ctx，不接触 window 内部状态";
    foot.appendChild(footText);
    shell.append(head, body, foot);
    mask.appendChild(shell);
    document.body.appendChild(mask);
    let activeId = "";
    let activeCtx = null;
    let activeImpl = null;
    let legacyRuntime = null;
    let legacyTimer = null;
    let rafHandle = null;
    let resizeObserver = null;
    const sampleListeners = /* @__PURE__ */ new Set();
    const resizeListeners = /* @__PURE__ */ new Set();
    const requestUpdate = () => {
      if (rafHandle != null) return;
      rafHandle = window.requestAnimationFrame(() => {
        rafHandle = null;
        if (!activeImpl || !activeCtx) return;
        try {
          activeImpl.update?.(activeCtx);
        } catch (err) {
          footText.className = "vc-err";
          footText.textContent = "视图更新失败：" + (err instanceof Error ? err.message : String(err));
          env.log("warn", "视图更新失败", err);
        }
        sampleListeners.forEach((listener) => {
          try {
            listener();
          } catch {
          }
        });
      });
    };
    const onSample = () => requestUpdate();
    window.addEventListener("xhgcs:sample", onSample);
    const teardown = () => {
      if (legacyTimer != null) {
        window.clearInterval(legacyTimer);
        legacyTimer = null;
      }
      if (legacyRuntime) {
        try {
          legacyRuntime.def.unmount?.(legacyRuntime.ctx);
        } catch (err) {
          console.warn("[XHGCS_CORE] 旧版视图卸载失败", err);
        }
        try {
          legacyRuntime.ctx.dispose?.();
        } catch (err) {
          console.warn("[XHGCS_CORE] 旧版视图上下文释放失败", err);
        }
        legacyRuntime = null;
      }
      if (activeImpl && activeCtx) {
        try {
          activeImpl.unmount?.(activeCtx);
        } catch (err) {
          console.warn("[XHGCS_CORE] 视图卸载失败", err);
        }
      }
      activeImpl = null;
      activeCtx = null;
      hostEl.replaceChildren();
      resizeObserver?.disconnect();
      resizeObserver = null;
      sampleListeners.clear();
      resizeListeners.clear();
    };
    const buildContext = (id) => {
      let canvasEl = null;
      const ctx = {
        id,
        host: hostEl,
        get width() {
          return hostEl.clientWidth;
        },
        get height() {
          return hostEl.clientHeight;
        },
        theme: () => readTheme(hostEl),
        channels: () => legacyChannels().map((channel) => ({
          id: channel.id,
          name: channel.name || channel.id,
          unit: channel.unit || "",
          color: channel.color || "#6da8d2",
          data: Array.isArray(channel.data) ? channel.data : []
        })),
        latest(channelId) {
          const channel = legacyChannels().find((item) => item.id === channelId);
          const data = channel?.data;
          return data && data.length ? Number(data[data.length - 1]) || 0 : 0;
        },
        series(channelId, limit = 200) {
          const channel = legacyChannels().find((item) => item.id === channelId);
          const data = channel?.data;
          if (!data) return [];
          const count = Math.max(0, Math.min(limit, data.length));
          return data.slice(data.length - count);
        },
        canvas() {
          if (!canvasEl) {
            canvasEl = document.createElement("canvas");
            canvasEl.style.display = "block";
            hostEl.appendChild(canvasEl);
          }
          return fitCanvas(canvasEl, hostEl);
        },
        toast: (message) => env.toast(message),
        esc(text) {
          return String(text == null ? "" : text).replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;").replace(/"/g, "&quot;").replace(/'/g, "&#39;");
        },
        onSample(listener) {
          sampleListeners.add(listener);
          return () => sampleListeners.delete(listener);
        },
        onResize(listener) {
          resizeListeners.add(listener);
          return () => resizeListeners.delete(listener);
        },
        requestRender: requestUpdate
      };
      return ctx;
    };
    const showEmpty = (message, hint) => {
      empty.replaceChildren();
      const bold = document.createElement("b");
      bold.textContent = message;
      empty.appendChild(bold);
      if (hint) {
        const text = document.createElement("span");
        text.textContent = hint;
        empty.appendChild(text);
      }
      empty.style.display = "flex";
    };
    const mountView = async (viewId) => {
      teardown();
      activeId = viewId;
      renderNav();
      empty.style.display = "none";
      footText.className = "";
      footText.textContent = "激活中…";
      try {
        await host.fireEvent("onView", viewId);
      } catch (err) {
        env.log("warn", `激活视图 ${viewId} 失败`, err);
      }
      const found = findImplementation(viewId);
      if (!found) {
        showEmpty(
          "这个视图还没有实现",
          "清单里声明了 views，但插件没有调用 api.views.register()。检查它是否已激活、id 是否一致。"
        );
        footText.textContent = "未找到实现";
        return;
      }
      activeImpl = found.impl;
      activeCtx = buildContext(viewId);
      try {
        found.impl.mount?.(activeCtx);
        footText.textContent = `${found.owner} · ${viewId} · ${activeCtx.width}×${activeCtx.height}`;
      } catch (err) {
        showEmpty("视图挂载失败", err instanceof Error ? err.message : String(err));
        footText.className = "vc-err";
        footText.textContent = "挂载失败";
        return;
      }
      if (typeof ResizeObserver !== "undefined") {
        resizeObserver = new ResizeObserver(() => {
          if (!activeImpl || !activeCtx) return;
          try {
            activeImpl.resize?.(activeCtx);
          } catch (err) {
            env.log("warn", "视图 resize 失败", err);
          }
          resizeListeners.forEach((listener) => {
            try {
              listener();
            } catch {
            }
          });
        });
        resizeObserver.observe(hostEl);
      }
      requestUpdate();
    };
    const mountLegacyView = (viewId) => {
      teardown();
      activeId = `legacy:${viewId}`;
      renderNav();
      empty.style.display = "none";
      footText.className = "";
      const record = legacyViews().find((item) => item.id === viewId);
      if (!record) {
        showEmpty("找不到这个旧版视图", "state.views 里已经没有它了");
        return;
      }
      const runtime = window.XHGCS_VIEWS;
      if (!runtime || typeof runtime.compileSource !== "function" || typeof runtime.createViewContext !== "function") {
        showEmpty("旧版视图运行时未加载", "需要 assets/js/views-plugins.js");
        return;
      }
      let def;
      try {
        def = runtime.compileSource(record.code);
      } catch (err) {
        showEmpty("视图代码编译失败", err instanceof Error ? err.message : String(err));
        footText.className = "vc-err";
        footText.textContent = "编译失败";
        return;
      }
      try {
        const ctx = runtime.createViewContext(def, hostEl);
        def.mount?.(ctx);
        legacyRuntime = { def, ctx };
        footText.textContent = `旧版表达式视图 · ${record.name || record.id}`;
        legacyTimer = window.setInterval(() => {
          if (!legacyRuntime) return;
          try {
            legacyRuntime.def.update?.(legacyRuntime.ctx);
          } catch (err) {
            footText.className = "vc-err";
            footText.textContent = "更新失败：" + (err instanceof Error ? err.message : String(err));
          }
        }, 250);
      } catch (err) {
        showEmpty("视图挂载失败", err instanceof Error ? err.message : String(err));
        footText.className = "vc-err";
        footText.textContent = "挂载失败";
      }
    };
    const viewItems = () => registry.all("views").filter((entry) => evaluateWhen(entry.value.when, buildWhenContext())).sort((a, b) => (a.value.order ?? 100) - (b.value.order ?? 100));
    const renderNav = () => {
      nav.replaceChildren();
      const items2 = viewItems();
      if (!items2.length && !legacyViews().length) {
        const emptyNav = document.createElement("div");
        emptyNav.className = "vc-empty";
        emptyNav.textContent = "还没有任何视图贡献";
        nav.appendChild(emptyNav);
        return;
      }
      for (const entry of items2) {
        const view = entry.value;
        const item = document.createElement("button");
        item.className = "vc-nav-item";
        item.dataset.active = view.id === activeId ? "1" : "0";
        const icon = document.createElement("i");
        icon.textContent = view.icon || "◈";
        const label = document.createElement("span");
        label.textContent = view.name;
        const owner = document.createElement("small");
        owner.textContent = entry.owner;
        item.append(icon, label, owner);
        item.addEventListener("click", () => {
          if (view.id === activeId) return;
          mountView(view.id).catch((err) => env.log("warn", "挂载视图失败", err));
        });
        nav.appendChild(item);
      }
      const legacy = legacyViews();
      if (legacy.length) {
        const head2 = document.createElement("div");
        head2.className = "vc-sec";
        head2.textContent = "自定义视图（旧版）";
        nav.appendChild(head2);
        for (const record of legacy) {
          const item = document.createElement("button");
          item.className = "vc-nav-item";
          item.dataset.legacy = "1";
          item.dataset.active = `legacy:${record.id}` === activeId ? "1" : "0";
          const icon = document.createElement("i");
          icon.textContent = record.icon || "◇";
          const label = document.createElement("span");
          label.textContent = record.name || record.id;
          const tag2 = document.createElement("small");
          tag2.textContent = "legacy";
          item.append(icon, label, tag2);
          item.addEventListener("click", () => mountLegacyView(record.id));
          nav.appendChild(item);
        }
      }
    };
    let disposeOverlay = () => void 0;
    const close = () => {
      window.removeEventListener("xhgcs:sample", onSample);
      disposeOverlay();
      if (rafHandle != null) window.cancelAnimationFrame(rafHandle);
      teardown();
      mask.remove();
    };
    disposeOverlay = pushOverlay({ id: "view-container", kind: "modal", close });
    closeBtn.addEventListener("click", close);
    mask.addEventListener("mousedown", (event) => {
      if (event.target === mask) close();
    });
    renderNav();
    const items = viewItems();
    const target = preferredId && items.find((entry) => entry.value.id === preferredId)?.value.id || items[0] && items[0].value.id;
    if (target) {
      mountView(target).catch((err) => env.log("warn", "挂载视图失败", err));
    } else {
      showEmpty("还没有插件贡献视图", "在清单的 contributes.views 里声明，并在 activate 里调用 api.views.register()。");
    }
  }
  const SECTION_KEY = "extensions";
  let installed = false;
  function activateSection(key) {
    document.querySelectorAll(".settings-nav-btn").forEach((node) => {
      node.classList.toggle("active", node.dataset.settingsNav === key);
    });
    document.querySelectorAll(".settings-section").forEach((node) => {
      node.classList.toggle("active", node.dataset.settingsPanel === key);
    });
  }
  function installSettingsSection() {
    if (installed) return;
    const nav = document.getElementById("settingsNav");
    const detail = document.getElementById("settingsDetail");
    if (!nav || !detail) return;
    if (nav.querySelector(`[data-settings-nav="${SECTION_KEY}"]`)) {
      installed = true;
      return;
    }
    const button = document.createElement("button");
    button.className = "settings-nav-btn";
    button.dataset.settingsNav = SECTION_KEY;
    button.innerHTML = '<span class="settings-nav-icon">✳</span>扩展与插件';
    const section = document.createElement("section");
    section.className = "settings-section";
    section.dataset.settingsPanel = SECTION_KEY;
    const head = document.createElement("div");
    head.className = "settings-section-head";
    const copy = document.createElement("div");
    const title = document.createElement("h3");
    title.textContent = "扩展与插件";
    const desc = document.createElement("p");
    desc.textContent = "已发现的扩展、启停状态与它们声明的配置项。扩展抛错不会影响地面站本体。";
    copy.append(title, desc);
    head.appendChild(copy);
    section.appendChild(head);
    const mount = document.createElement("div");
    mount.style.cssText = "height:min(520px,58vh);display:flex;min-height:0;border:1px solid var(--line);border-radius:10px;overflow:hidden;margin-top:10px";
    section.appendChild(mount);
    let rendered = false;
    const render = () => {
      renderExtensionPane(mount);
      rendered = true;
    };
    button.addEventListener("click", () => {
      activateSection(SECTION_KEY);
      render();
    });
    const refreshIfVisible = () => {
      if (!rendered || !section.classList.contains("active")) return;
      renderExtensionPane(mount);
    };
    host.onDidChange(refreshIfVisible);
    configuration.onDidChange(refreshIfVisible);
    const anchor = nav.querySelector(".settings-nav-btn.desktop-only");
    if (anchor && anchor.parentElement === nav) nav.insertBefore(button, anchor);
    else nav.appendChild(button);
    detail.appendChild(section);
    installed = true;
  }
  const DOC_FORMAT = "xhgcs.ui";
  const DOC_VERSION = 2;
  const GRID_COLS = 12;
  const ROW_HEIGHT = 44;
  let seq = 0;
  function nextNodeId(prefix = "n") {
    seq += 1;
    return `${prefix}${Date.now().toString(36).slice(-4)}${seq.toString(36)}`;
  }
  function isPlainObject(value) {
    return Boolean(value) && typeof value === "object" && !Array.isArray(value);
  }
  function clampGrid(rect, cols = GRID_COLS) {
    const w = Math.max(1, Math.min(cols, Math.round(rect.w) || 1));
    const h = Math.max(1, Math.round(rect.h) || 1);
    const x = Math.max(0, Math.min(cols - w, Math.round(rect.x) || 0));
    const y = Math.max(0, Math.round(rect.y) || 0);
    return { x, y, w, h };
  }
  function createDoc(name = "新建看板") {
    const now = Date.now();
    return {
      format: DOC_FORMAT,
      version: DOC_VERSION,
      id: `ui.${now.toString(36)}`,
      name,
      cols: GRID_COLS,
      rowHeight: ROW_HEIGHT,
      root: { id: "root", type: "layout.grid", props: { gap: 10 }, grid: { x: 0, y: 0, w: GRID_COLS, h: 12 }, children: [] },
      bindings: {},
      createdAt: now,
      updatedAt: now
    };
  }
  function normalizeNode(raw, fallbackType = "widget.unknown") {
    if (!isPlainObject(raw)) return null;
    const id = String(raw.id || "").trim() || nextNodeId();
    const type = String(raw.type || fallbackType).trim() || fallbackType;
    const gridRaw = isPlainObject(raw.grid) ? raw.grid : {};
    const childrenRaw = Array.isArray(raw.children) ? raw.children : [];
    const children = childrenRaw.map((child) => normalizeNode(child)).filter((child) => Boolean(child));
    const node = {
      id,
      type,
      props: isPlainObject(raw.props) ? { ...raw.props } : {},
      grid: clampGrid({
        x: Number(gridRaw.x) || 0,
        y: Number(gridRaw.y) || 0,
        w: Number(gridRaw.w) || 4,
        h: Number(gridRaw.h) || 3
      }),
      bind: Array.isArray(raw.bind) ? raw.bind.map(String) : void 0
    };
    if (children.length) node.children = children;
    return node;
  }
  function normalizeBindings(raw) {
    const out = {};
    if (!isPlainObject(raw)) return out;
    for (const [key, value] of Object.entries(raw)) {
      if (!isPlainObject(value)) continue;
      const source = String(value.source || "channel");
      if (!["channel", "channels", "query", "state", "expr"].includes(source)) continue;
      out[key] = {
        source,
        ref: Array.isArray(value.ref) ? value.ref.map(String) : String(value.ref ?? ""),
        transform: isPlainObject(value.transform) ? value.transform : void 0
      };
    }
    return out;
  }
  function normalizeDoc(raw) {
    if (!isPlainObject(raw)) return null;
    if (raw.format != null && raw.format !== DOC_FORMAT) return null;
    const root = normalizeNode(raw.root, "layout.grid");
    if (!root) return null;
    const now = Date.now();
    return {
      format: DOC_FORMAT,
      version: DOC_VERSION,
      id: String(raw.id || `ui.${now.toString(36)}`),
      name: String(raw.name || "未命名看板").slice(0, 40),
      cols: Math.max(4, Math.min(24, Number(raw.cols) || GRID_COLS)),
      rowHeight: Math.max(24, Math.min(120, Number(raw.rowHeight) || ROW_HEIGHT)),
      root,
      bindings: normalizeBindings(raw.bindings),
      createdAt: Number(raw.createdAt) || now,
      updatedAt: Number(raw.updatedAt) || now
    };
  }
  function serializeDoc(doc) {
    return JSON.stringify({ ...doc, updatedAt: Date.now() }, null, 2);
  }
  function parseDoc(text) {
    try {
      return normalizeDoc(JSON.parse(text));
    } catch {
      return null;
    }
  }
  function cloneDoc(doc) {
    return JSON.parse(JSON.stringify(doc));
  }
  function forEachNode(root, visit) {
    const walk = (node, parent) => {
      visit(node, parent);
      for (const child of node.children || []) walk(child, node);
    };
    walk(root, null);
  }
  function findNode(root, id) {
    let hit = null;
    forEachNode(root, (node) => {
      if (node.id === id) hit = node;
    });
    return hit;
  }
  function findParent(root, id) {
    let hit = null;
    forEachNode(root, (node, parent) => {
      if (node.id === id) hit = parent;
    });
    return hit;
  }
  function allWidgets(root) {
    const out = [];
    forEachNode(root, (node) => {
      if (node.type !== "layout.grid" && node.type !== "layout.row" && node.type !== "layout.col") out.push(node);
    });
    return out;
  }
  function findFreeSlot(root, w, h, cols = GRID_COLS) {
    const taken = allWidgets(root).map((node) => node.grid);
    const overflows = (rect) => taken.some((r) => !(rect.x + rect.w <= r.x || rect.x >= r.x + r.w || rect.y + rect.h <= r.y || rect.y >= r.y + r.h));
    for (let y = 0; y < 400; y++) {
      for (let x = 0; x + w <= cols; x++) {
        const rect = { x, y, w, h };
        if (!overflows(rect)) return rect;
      }
    }
    const bottom = taken.reduce((max, r) => Math.max(max, r.y + r.h), 0);
    return { x: 0, y: bottom, w, h };
  }
  class UiHistory {
    constructor(limit = 200) {
      this.limit = limit;
      this.undoStack = [];
      this.redoStack = [];
      this.depth = 0;
      this.pending = [];
      this.listeners = /* @__PURE__ */ new Set();
    }
    onChange(listener) {
      this.listeners.add(listener);
      return () => this.listeners.delete(listener);
    }
    emit() {
      this.listeners.forEach((fn) => fn());
    }
    get canUndo() {
      return this.undoStack.length > 0;
    }
    get canRedo() {
      return this.redoStack.length > 0;
    }
    get undoLabel() {
      return this.undoStack.length ? this.undoStack[this.undoStack.length - 1].label : "";
    }
    /** transaction 内的命令合并成一条，适合拖拽/连续输入。 */
    transaction(fn, label = "批量修改") {
      this.depth += 1;
      try {
        fn();
      } finally {
        this.depth -= 1;
        if (this.depth === 0 && this.pending.length) {
          const batch = this.pending.slice();
          this.pending = [];
          this.push({
            label,
            do: (doc) => batch.forEach((command) => command.do(doc)),
            undo: (doc) => {
              for (let i = batch.length - 1; i >= 0; i--) batch[i].undo(doc);
            }
          });
        }
      }
    }
    push(command) {
      if (this.depth > 0) {
        this.pending.push(command);
        return;
      }
      this.undoStack.push(command);
      if (this.undoStack.length > this.limit) this.undoStack.shift();
      this.redoStack.length = 0;
      this.emit();
    }
    undo(doc) {
      const command = this.undoStack.pop();
      if (!command) return false;
      command.undo(doc);
      this.redoStack.push(command);
      this.emit();
      return true;
    }
    redo(doc) {
      const command = this.redoStack.pop();
      if (!command) return false;
      command.do(doc);
      this.undoStack.push(command);
      this.emit();
      return true;
    }
    clear() {
      this.undoStack.length = 0;
      this.redoStack.length = 0;
      this.pending.length = 0;
      this.emit();
    }
  }
  function insertNodeCommand(parentId, node, label = "添加控件") {
    const snapshot = JSON.parse(JSON.stringify(node));
    return {
      label,
      do(doc) {
        const parent = findNode(doc.root, parentId);
        if (!parent) return;
        parent.children = parent.children || [];
        parent.children.push(JSON.parse(JSON.stringify(snapshot)));
      },
      undo(doc) {
        const parent = findNode(doc.root, parentId);
        if (!parent || !parent.children) return;
        const index = parent.children.findIndex((child) => child.id === snapshot.id);
        if (index >= 0) parent.children.splice(index, 1);
      }
    };
  }
  function removeNodeCommand(nodeId, label = "删除控件") {
    let removed = null;
    let removedIndex = -1;
    let parentId = "";
    return {
      label,
      do(doc) {
        const parent = findParent(doc.root, nodeId);
        if (!parent || !parent.children) return;
        const index = parent.children.findIndex((child) => child.id === nodeId);
        if (index < 0) return;
        parentId = parent.id;
        removedIndex = index;
        removed = JSON.parse(JSON.stringify(parent.children[index]));
        parent.children.splice(index, 1);
      },
      undo(doc) {
        if (!removed) return;
        const parent = findNode(doc.root, parentId);
        if (!parent) return;
        parent.children = parent.children || [];
        parent.children.splice(removedIndex, 0, JSON.parse(JSON.stringify(removed)));
      }
    };
  }
  function moveNodeCommand(nodeId, next, label = "移动控件") {
    let previous = null;
    return {
      label,
      do(doc) {
        const node = findNode(doc.root, nodeId);
        if (!node) return;
        previous = { ...node.grid };
        node.grid = { ...next };
      },
      undo(doc) {
        const node = findNode(doc.root, nodeId);
        if (!node || !previous) return;
        node.grid = { ...previous };
      }
    };
  }
  function propsCommand(nodeId, patch, label = "修改属性") {
    let before = null;
    return {
      label,
      do(doc) {
        const node = findNode(doc.root, nodeId);
        if (!node) return;
        before = { ...node.props };
        node.props = { ...node.props, ...patch };
      },
      undo(doc) {
        const node = findNode(doc.root, nodeId);
        if (!node || !before) return;
        node.props = before;
      }
    };
  }
  function bindingsCommand(nodeId, bind, bindings2, label = "修改数据绑定") {
    let beforeBind = [];
    let beforeBindings = {};
    return {
      label,
      do(doc) {
        const node = findNode(doc.root, nodeId);
        if (!node) return;
        beforeBind = Array.isArray(node.bind) ? node.bind.slice() : [];
        beforeBindings = {};
        beforeBind.forEach((key) => {
          if (doc.bindings[key]) beforeBindings[key] = doc.bindings[key];
          delete doc.bindings[key];
        });
        node.bind = bind.slice();
        for (const [key, value] of Object.entries(bindings2)) doc.bindings[key] = value;
      },
      undo(doc) {
        const node = findNode(doc.root, nodeId);
        if (!node) return;
        const current = Array.isArray(node.bind) ? node.bind : [];
        current.forEach((key) => delete doc.bindings[key]);
        node.bind = beforeBind.slice();
        for (const [key, value] of Object.entries(beforeBindings)) doc.bindings[key] = value;
      }
    };
  }
  class Coalescer {
    constructor(windowMs = 400) {
      this.windowMs = windowMs;
      this.key = "";
      this.timer = null;
    }
    shouldMerge(key) {
      const same = this.key === key && this.timer != null;
      this.key = key;
      if (this.timer != null) window.clearTimeout(this.timer);
      this.timer = window.setTimeout(() => {
        this.timer = null;
        this.key = "";
      }, this.windowMs);
      return same;
    }
  }
  function duplicateNode(node) {
    const copy = JSON.parse(JSON.stringify(node));
    const renumber = (target) => {
      target.id = `${target.id}_c${Math.random().toString(36).slice(2, 5)}`;
      (target.children || []).forEach(renumber);
    };
    renumber(copy);
    return copy;
  }
  const PALETTE = ["#6da8d2", "#34d399", "#fbbf24", "#f472b6", "#a78bfa", "#fb923c", "#38bdf8", "#facc15"];
  function currentChannels() {
    const state = window.XHGCS?.state;
    if (!state) return [];
    const list = [];
    if (Array.isArray(state.channels)) list.push(...state.channels);
    if (Array.isArray(state.scriptChannels)) list.push(...state.scriptChannels);
    return list;
  }
  function channelById(id) {
    return currentChannels().find((channel) => channel.id === id);
  }
  function channelsByQuery(query) {
    const text = String(query || "").trim();
    const all = currentChannels();
    if (!text || text === "*") return all;
    const lower = text.toLowerCase();
    return all.filter((channel) => `${channel.id} ${channel.name || ""}`.toLowerCase().includes(lower));
  }
  function colorOf(channel, index) {
    return channel.color || PALETTE[index % PALETTE.length];
  }
  function toSeries(channel, index) {
    return {
      id: channel.id,
      label: channel.name || channel.id,
      unit: channel.unit || "",
      color: colorOf(channel, index),
      values: Array.isArray(channel.data) ? channel.data : []
    };
  }
  function tail(values, count) {
    const size = Math.max(0, Math.floor(count) || 0);
    if (!size) return values.slice();
    return values.length > size ? values.slice(values.length - size) : values.slice();
  }
  function latestValue(values) {
    return values.length ? Number(values[values.length - 1]) || 0 : 0;
  }
  function createCanvasWidget(el, draw, series) {
    const canvas = document.createElement("canvas");
    canvas.style.display = "block";
    canvas.style.width = "100%";
    canvas.style.height = "100%";
    el.appendChild(canvas);
    let props = {};
    let observer = null;
    const paint = () => {
      if (!el.clientWidth || !el.clientHeight) return;
      const frame = fitCanvas(canvas, el);
      if (!frame) return;
      const theme = readTheme(el);
      if (frame.width < 12 || frame.height < 12) {
        drawEmpty(frame, theme, "空间太小");
        return;
      }
      let data = [];
      try {
        data = series() || [];
      } catch (err) {
        console.warn("[XHGCS_CORE] 绑定解析失败", err);
      }
      draw(frame, theme, props, data);
    };
    if (typeof ResizeObserver !== "undefined") {
      observer = new ResizeObserver(() => paint());
      observer.observe(el);
    }
    window.setTimeout(paint, 0);
    return {
      render: paint,
      resize: paint,
      setProps(next) {
        props = next || {};
        paint();
      },
      dispose() {
        observer?.disconnect();
        observer = null;
        el.replaceChildren();
      }
    };
  }
  const BUILTIN_WIDGETS = [
    {
      type: "widget.scope",
      label: "折线示波",
      icon: "≋",
      group: "图表",
      defaultSize: { w: 6, h: 4 },
      minSize: { w: 3, h: 2 },
      defaults: { points: 160, normalize: false, grid: true, fill: true },
      propSchema: [
        { key: "points", label: "采样点数", type: "number", min: 10, max: 2e3, step: 10, group: "数据" },
        { key: "normalize", label: "归一化 Y 轴", type: "boolean", group: "坐标" },
        { key: "grid", label: "显示网格", type: "boolean", group: "坐标" },
        { key: "fill", label: "曲线填充", type: "boolean", group: "样式" }
      ],
      create({ el, props, series }) {
        const instance = createCanvasWidget(
          el,
          (frame, theme, current, data) => {
            const count = Number(current.points) || 160;
            const list = data.map((item) => ({ label: item.label, color: item.color, unit: item.unit, values: tail(item.values, count) }));
            drawLineChart(frame, list, theme, {
              normalize: Boolean(current.normalize),
              grid: current.grid !== false,
              fill: current.fill !== false
            });
          },
          series
        );
        instance.setProps(props);
        return instance;
      }
    },
    {
      type: "widget.gauge",
      label: "仪表盘",
      icon: "◔",
      group: "图表",
      defaultSize: { w: 3, h: 4 },
      minSize: { w: 2, h: 2 },
      defaults: { min: 0, max: 100 },
      propSchema: [
        { key: "min", label: "量程下限", type: "number", step: 1, group: "量程" },
        { key: "max", label: "量程上限", type: "number", step: 1, group: "量程" }
      ],
      create({ el, props, series }) {
        const instance = createCanvasWidget(
          el,
          (frame, theme, current, data) => {
            const first = data[0];
            if (!first) {
              drawEmpty(frame, theme, "未绑定通道");
              return;
            }
            drawGauge(
              frame,
              latestValue(first.values),
              { min: Number(current.min) || 0, max: Number(current.max) || 100, unit: first.unit, label: first.label },
              theme
            );
          },
          series
        );
        instance.setProps(props);
        return instance;
      }
    },
    {
      type: "widget.bars",
      label: "柱状对比",
      icon: "▥",
      group: "图表",
      defaultSize: { w: 4, h: 4 },
      minSize: { w: 3, h: 2 },
      defaults: { max: 0 },
      propSchema: [{ key: "max", label: "Y 轴上限", type: "number", step: 1, help: "0 表示自动取当前最大值", group: "坐标" }],
      create({ el, props, series }) {
        const instance = createCanvasWidget(
          el,
          (frame, theme, current, data) => {
            const items = data.map((item) => ({ label: item.label, value: latestValue(item.values), color: item.color }));
            drawBars(frame, items, theme, { max: Number(current.max) || void 0 });
          },
          series
        );
        instance.setProps(props);
        return instance;
      }
    },
    {
      type: "widget.donut",
      label: "环形占比",
      icon: "◍",
      group: "图表",
      defaultSize: { w: 3, h: 4 },
      minSize: { w: 2, h: 2 },
      defaults: {},
      propSchema: [],
      create({ el, props, series }) {
        const instance = createCanvasWidget(
          el,
          (frame, theme, _current, data) => {
            const items = data.map((item) => ({
              label: item.label,
              value: Math.abs(latestValue(item.values)),
              color: item.color
            }));
            drawDonut(frame, items, theme);
          },
          series
        );
        instance.setProps(props);
        return instance;
      }
    },
    {
      type: "widget.table",
      label: "数据表",
      icon: "▤",
      group: "数据",
      defaultSize: { w: 4, h: 4 },
      minSize: { w: 3, h: 2 },
      defaults: { digits: 2 },
      propSchema: [{ key: "digits", label: "小数位", type: "number", min: 0, max: 6, step: 1, group: "样式" }],
      create({ el, props, series }) {
        const instance = createCanvasWidget(
          el,
          (frame, theme, current, data) => {
            const digits = Number(current.digits);
            const rows = data.map((item) => ({
              name: item.label,
              value: latestValue(item.values).toFixed(Number.isFinite(digits) ? digits : 2),
              unit: item.unit,
              color: item.color
            }));
            drawTable(frame, rows, theme);
          },
          series
        );
        instance.setProps(props);
        return instance;
      }
    },
    {
      type: "widget.stat",
      label: "数值卡",
      icon: "◈",
      group: "数据",
      defaultSize: { w: 3, h: 2 },
      minSize: { w: 2, h: 1 },
      defaults: { title: "当前值", digits: 2, tone: "default" },
      propSchema: [
        { key: "title", label: "标题", type: "text", group: "样式" },
        { key: "digits", label: "小数位", type: "number", min: 0, max: 6, step: 1, group: "样式" },
        {
          key: "tone",
          label: "配色",
          type: "select",
          options: [
            { value: "default", label: "默认" },
            { value: "ok", label: "正常" },
            { value: "warn", label: "警告" },
            { value: "danger", label: "危险" }
          ],
          group: "样式"
        }
      ],
      create({ el, props, series }) {
        const box = document.createElement("div");
        box.className = "dsg-stat";
        const title = document.createElement("div");
        title.className = "dsg-stat-title";
        const value = document.createElement("div");
        value.className = "dsg-stat-value";
        const unit = document.createElement("span");
        unit.className = "dsg-stat-unit";
        box.append(title, value);
        el.appendChild(box);
        let current = {};
        const paint = () => {
          const first = series()[0];
          title.textContent = String(current.title || "当前值");
          const digits = Number(current.digits);
          const number = first ? latestValue(first.values) : NaN;
          value.className = "dsg-stat-value";
          if (current.tone && current.tone !== "default") value.dataset.tone = String(current.tone);
          else delete value.dataset.tone;
          value.textContent = Number.isFinite(number) ? number.toFixed(Number.isFinite(digits) ? digits : 2) : "--";
          unit.textContent = first && first.unit ? " " + first.unit : "";
          value.appendChild(unit);
        };
        paint();
        return {
          render: paint,
          resize: paint,
          setProps(next) {
            current = next || {};
            paint();
          },
          dispose() {
            el.replaceChildren();
          }
        };
      }
    },
    {
      type: "widget.label",
      label: "文本",
      icon: "T",
      group: "基础",
      defaultSize: { w: 4, h: 1 },
      minSize: { w: 1, h: 1 },
      defaults: { text: "标题文本", align: "left", size: 14 },
      propSchema: [
        { key: "text", label: "内容", type: "text", group: "内容" },
        {
          key: "align",
          label: "对齐",
          type: "select",
          options: [
            { value: "left", label: "左" },
            { value: "center", label: "中" },
            { value: "right", label: "右" }
          ],
          group: "样式"
        },
        { key: "size", label: "字号", type: "number", min: 10, max: 48, step: 1, group: "样式" }
      ],
      create({ el, props }) {
        const text = document.createElement("div");
        text.className = "dsg-label";
        el.appendChild(text);
        let current = {};
        const paint = () => {
          text.textContent = String(current.text ?? "");
          text.style.textAlign = String(current.align || "left");
          text.style.fontSize = (Number(current.size) || 14) + "px";
        };
        paint();
        return {
          render: paint,
          resize: paint,
          setProps(next) {
            current = next || {};
            paint();
          },
          dispose() {
            el.replaceChildren();
          }
        };
      }
    }
  ];
  function widgetDef(type, extra = []) {
    return extra.find((def) => def.type === type) || BUILTIN_WIDGETS.find((def) => def.type === type);
  }
  function createMissingWidget(el, type) {
    const box = document.createElement("div");
    box.className = "dsg-missing";
    box.textContent = "缺少控件：" + type;
    el.appendChild(box);
    return {
      render: () => void 0,
      resize: () => void 0,
      setProps: () => void 0,
      dispose: () => el.replaceChildren()
    };
  }
  const DEFAULT_WINDOW = 120;
  function applyTransform(series, binding) {
    const transform = binding.transform;
    if (!transform) return series;
    const values = series.values;
    if (transform.fn === "window") {
      const limit = Number(transform.args?.limit) || DEFAULT_WINDOW;
      return { ...series, values: values.length > limit ? values.slice(values.length - limit) : values.slice() };
    }
    if (transform.fn === "scale") {
      const factor = Number(transform.args?.factor);
      const k = Number.isFinite(factor) ? factor : 1;
      return { ...series, values: values.map((value) => value * k) };
    }
    if (transform.fn === "normalize") {
      let min = Infinity;
      let max = -Infinity;
      for (const value of values) {
        if (!Number.isFinite(value)) continue;
        if (value < min) min = value;
        if (value > max) max = value;
      }
      if (!Number.isFinite(min) || !Number.isFinite(max) || max - min < 1e-9) {
        return { ...series, values: values.map(() => 0.5) };
      }
      const span = max - min;
      return { ...series, values: values.map((value) => (value - min) / span) };
    }
    return series;
  }
  function resolveNode(doc, target) {
    const out = [];
    const issues = [];
    const keys = Array.isArray(target.bind) ? target.bind : [];
    const started = performance.now();
    if (keys.length) {
      keys.forEach((key) => {
        const binding = doc.bindings[key];
        if (!binding) {
          issues.push({ nodeId: target.id, bindingKey: key, message: `绑定 ${key} 不存在` });
          return;
        }
        try {
          pushBinding(out, binding, key, target, issues);
        } catch (err) {
          issues.push({ nodeId: target.id, bindingKey: key, message: err instanceof Error ? err.message : String(err) });
        }
      });
    } else {
      const legacy = target.props?.channels;
      const ids = Array.isArray(legacy) ? legacy.map(String) : typeof legacy === "string" && legacy ? [legacy] : [];
      ids.forEach((id, index) => {
        const channel = channelById(id);
        if (!channel) {
          issues.push({ nodeId: target.id, bindingKey: "props.channels", message: `通道 ${id} 不存在` });
          return;
        }
        out.push(toSeries(channel, index));
      });
    }
    if (!out.length && !keys.length) {
      currentChannels().slice(0, 3).forEach((channel, index) => out.push(toSeries(channel, index)));
    }
    const elapsed = performance.now() - started;
    if (elapsed > 8) console.warn(`[XHGCS_CORE] 绑定解析耗时 ${elapsed.toFixed(1)}ms（节点 ${target.id}）`);
    return { series: out, issues };
  }
  function pushBinding(out, binding, key, target, issues) {
    if (binding.source === "channel") {
      const id = String(binding.ref || "");
      const channel = channelById(id);
      if (!channel) {
        issues.push({ nodeId: target.id, bindingKey: key, message: `通道 ${id} 不存在` });
        return;
      }
      out.push(applyTransform(toSeries(channel, out.length), binding));
      return;
    }
    if (binding.source === "channels") {
      const ids = Array.isArray(binding.ref) ? binding.ref.map(String) : [String(binding.ref || "")];
      ids.forEach((id) => {
        const channel = channelById(id);
        if (!channel) {
          issues.push({ nodeId: target.id, bindingKey: key, message: `通道 ${id} 不存在` });
          return;
        }
        out.push(applyTransform(toSeries(channel, out.length), binding));
      });
      return;
    }
    if (binding.source === "query") {
      const query = String(binding.ref || "");
      const hits = channelsByQuery(query);
      if (!hits.length) {
        issues.push({ nodeId: target.id, bindingKey: key, message: `没有通道匹配「${query}」` });
        return;
      }
      hits.forEach((channel) => out.push(applyTransform(toSeries(channel, out.length), binding)));
      return;
    }
    if (binding.source === "state") {
      issues.push({ nodeId: target.id, bindingKey: key, message: "state 绑定暂不作为序列" });
      return;
    }
    issues.push({ nodeId: target.id, bindingKey: key, message: `不支持的绑定类型 ${binding.source}` });
  }
  function describeBinding(binding) {
    const ref = Array.isArray(binding.ref) ? binding.ref.join(", ") : String(binding.ref || "");
    const map = {
      channel: "通道",
      channels: "多通道",
      query: "名字匹配",
      state: "状态",
      expr: "表达式"
    };
    const suffix = binding.transform ? ` · ${binding.transform.fn}` : "";
    return `${map[binding.source] || binding.source}：${ref || "（空）"}${suffix}`;
  }
  function bindingsForChannels(ids, transform) {
    const bind = [];
    const bindings2 = {};
    ids.forEach((id, index) => {
      const key = `b${index + 1}`;
      bind.push(key);
      bindings2[key] = { source: "channel", ref: id, transform };
    });
    return { bind, bindings: bindings2 };
  }
  function bindingsForQuery(query, transform) {
    return { bind: ["b1"], bindings: { b1: { source: "query", ref: query, transform } } };
  }
  function bindingTransformOf(doc, node) {
    const keys = Array.isArray(node.bind) ? node.bind : [];
    for (const key of keys) {
      const binding = doc.bindings[key];
      if (binding && binding.transform) return binding.transform;
    }
    return void 0;
  }
  function bindingsOf(doc, node) {
    const keys = Array.isArray(node.bind) ? node.bind : [];
    return keys.map((key) => doc.bindings[key]).filter((binding) => Boolean(binding));
  }
  function gridAreaOf(rect) {
    return `${rect.y + 1} / ${rect.x + 1} / span ${rect.h} / span ${rect.w}`;
  }
  class DocRuntime {
    constructor(options) {
      this.cells = /* @__PURE__ */ new Map();
      this.timer = null;
      this.doc = null;
      this.selected = "";
      this.interactive = false;
      this.container = options.container;
      this.extraWidgets = options.extraWidgets || [];
      this.tickMs = options.tickMs == null ? 250 : options.tickMs;
      this.onSelect = options.onSelect;
    }
    setInteractive(interactive) {
      this.interactive = interactive;
      this.container.dataset.interactive = interactive ? "1" : "0";
    }
    setSelected(nodeId) {
      if (this.selected === nodeId) return;
      this.selected = nodeId;
      for (const [id, cell] of this.cells) cell.el.classList.toggle("is-selected", id === nodeId);
    }
    get nodeCount() {
      return this.cells.size;
    }
    sync(doc) {
      this.doc = doc;
      this.container.style.setProperty("--dsg-cols", String(doc.cols));
      this.container.style.setProperty("--dsg-row", doc.rowHeight + "px");
      const widgets = allWidgets(doc.root);
      const seen = /* @__PURE__ */ new Set();
      for (const node of widgets) {
        seen.add(node.id);
        const existing = this.cells.get(node.id);
        if (existing && existing.type === node.type) {
          this.updateCell(existing, node);
        } else {
          if (existing) this.dropCell(node.id);
          this.createCell(node);
        }
      }
      for (const id of Array.from(this.cells.keys())) {
        if (!seen.has(id)) this.dropCell(id);
      }
      this.container.dataset.empty = widgets.length ? "0" : "1";
      const maxRow = widgets.reduce((max, node) => Math.max(max, node.grid.y + node.grid.h), 0);
      const rows = Math.max(5, maxRow + 2);
      this.container.style.minHeight = `${rows * (doc.rowHeight + 10) + 12}px`;
      this.setSelected(this.selected);
      this.restartTicker();
    }
    gridStyle(node) {
      return gridAreaOf(node.grid);
    }
    createCell(node) {
      const el = document.createElement("div");
      el.className = "dsg-cell";
      el.dataset.nodeId = node.id;
      el.style.gridArea = this.gridStyle(node);
      const head = document.createElement("div");
      head.className = "dsg-cell-head";
      head.dataset.role = "drag";
      const label = document.createElement("span");
      label.className = "dsg-cell-label";
      const def = widgetDef(node.type, this.extraWidgets);
      label.textContent = def ? def.label : node.type.replace("widget.", "");
      head.appendChild(label);
      const actions = document.createElement("div");
      actions.className = "dsg-cell-actions";
      const del = document.createElement("button");
      del.type = "button";
      del.textContent = "✕";
      del.dataset.role = "delete";
      del.title = "删除控件";
      actions.appendChild(del);
      head.appendChild(actions);
      const content = document.createElement("div");
      content.className = "dsg-cell-content";
      const resize = document.createElement("div");
      resize.className = "dsg-cell-resize";
      resize.dataset.role = "resize";
      el.append(head, content, resize);
      el.addEventListener("pointerdown", (event) => {
        if (event.target.dataset.role !== "drag") {
          this.onSelect?.(node.id);
        }
      });
      const instance = def ? def.create({
        el: content,
        props: { ...def.defaults, ...node.props },
        // 每次取数都回查当前文档：导入/撤销会换掉节点对象，闭包不能抓着旧的那份
        series: () => {
          const current = this.doc ? findNode(this.doc.root, node.id) : null;
          return current ? resolveNode(this.doc, current).series : [];
        }
      }) : createMissingWidget(content, node.type);
      this.cells.set(node.id, {
        el,
        content,
        instance,
        propsKey: JSON.stringify(node.props),
        gridKey: this.gridStyle(node),
        bindKey: Array.isArray(node.bind) ? node.bind.join("|") : "",
        type: node.type
      });
      this.container.appendChild(el);
    }
    updateCell(cell, node) {
      const gridKey = this.gridStyle(node);
      if (gridKey !== cell.gridKey) {
        cell.el.style.gridArea = gridKey;
        cell.gridKey = gridKey;
        cell.instance.resize();
      }
      const propsKey = JSON.stringify(node.props);
      if (propsKey !== cell.propsKey) {
        cell.propsKey = propsKey;
        cell.instance.setProps(node.props);
      }
      const bindKey = Array.isArray(node.bind) ? node.bind.join("|") : "";
      if (bindKey !== cell.bindKey) {
        cell.bindKey = bindKey;
        cell.instance.render();
      }
    }
    dropCell(nodeId) {
      const cell = this.cells.get(nodeId);
      if (!cell) return;
      try {
        cell.instance.dispose();
      } catch (err) {
        console.warn("[XHGCS_CORE] 释放控件失败", err);
      }
      cell.el.remove();
      this.cells.delete(nodeId);
      if (this.selected === nodeId) this.selected = "";
    }
    restartTicker() {
      if (this.timer != null) {
        window.clearInterval(this.timer);
        this.timer = null;
      }
      if (!this.tickMs) return;
      this.timer = window.setInterval(() => {
        for (const cell of this.cells.values()) {
          try {
            cell.instance.render();
          } catch (err) {
            console.warn("[XHGCS_CORE] 控件渲染失败", err);
          }
        }
      }, this.tickMs);
    }
    /** 兼容旧调用：整份重画。 */
    refresh() {
      if (this.doc) this.sync(this.doc);
    }
    get isInteractive() {
      return this.interactive;
    }
    dispose() {
      if (this.timer != null) window.clearInterval(this.timer);
      this.timer = null;
      for (const id of Array.from(this.cells.keys())) this.dropCell(id);
    }
  }
  const BOARD_WIDGET_TYPES = ["scope", "gauge", "stat", "table", "donut", "bars", "label"];
  const DEFAULT_SIZE = {
    scope: { w: 6, h: 4 },
    gauge: { w: 3, h: 4 },
    stat: { w: 3, h: 2 },
    table: { w: 6, h: 4 },
    donut: { w: 3, h: 4 },
    bars: { w: 6, h: 4 },
    label: { w: 12, h: 1 }
  };
  const MAX_WIDGETS = 12;
  function isType(value) {
    return BOARD_WIDGET_TYPES.includes(value);
  }
  function composeBoard(spec) {
    const warnings = [];
    if (!spec || typeof spec !== "object") return { ok: false, error: "规格不是对象", warnings };
    const widgets = Array.isArray(spec.widgets) ? spec.widgets : [];
    if (!widgets.length) return { ok: false, error: "缺少 widgets（至少一个控件）", warnings };
    const names = currentChannels().map((channel) => channel.id);
    const accepted = [];
    for (const raw of widgets) {
      const item = raw || {};
      const type = String(item.type || "").toLowerCase();
      if (!isType(type)) {
        return {
          ok: false,
          error: `不支持的控件类型「${type}」，只能是 ${BOARD_WIDGET_TYPES.join(" / ")}`,
          warnings
        };
      }
      if (item.channel && !channelById(String(item.channel))) {
        return {
          ok: false,
          error: `通道「${item.channel}」不存在。可用通道：${names.slice(0, 12).join(", ") || "（暂无）"}`,
          warnings
        };
      }
      if (Array.isArray(item.channels)) {
        const missing = item.channels.map(String).filter((id) => !channelById(id));
        if (missing.length) {
          return { ok: false, error: `通道「${missing.join(", ")}」不存在`, warnings };
        }
      }
      if (item.query) {
        const needle = String(item.query);
        const hits = currentChannels().filter((channel) => `${channel.id} ${channel.name || ""}`.includes(needle));
        if (!hits.length) warnings.push(`「${needle}」当前没有匹配通道（有数据后会自动绑定）`);
      }
      if ((type === "gauge" || type === "stat") && !item.channel && !item.channels && !item.query) {
        warnings.push(`${type} 控件没有指定通道，将默认取第一个通道`);
      }
      accepted.push(item);
      if (accepted.length >= MAX_WIDGETS) {
        warnings.push(`控件超过 ${MAX_WIDGETS} 个，已截断`);
        break;
      }
    }
    const doc = createDoc(String(spec.name || "AI 看板").slice(0, 40));
    if (spec.cols) doc.cols = Math.max(6, Math.min(24, Math.round(Number(spec.cols)) || doc.cols));
    if (spec.rowHeight) doc.rowHeight = Math.max(28, Math.min(96, Math.round(Number(spec.rowHeight)) || doc.rowHeight));
    let cursorX = 0;
    let cursorY = 0;
    let rowHeight = 0;
    for (const item of accepted) {
      const type = String(item.type || "").toLowerCase();
      const def = widgetDef(`widget.${type}`);
      const size = {
        w: clamp(Number(item.w) || (def ? def.defaultSize.w : DEFAULT_SIZE[type].w), 1, doc.cols),
        h: clamp(Number(item.h) || (def ? def.defaultSize.h : DEFAULT_SIZE[type].h), 1, 24)
      };
      if (cursorX + size.w > doc.cols) {
        cursorX = 0;
        cursorY += rowHeight;
        rowHeight = 0;
      }
      const nodeId = nextNodeId();
      const node = {
        id: nodeId,
        type: `widget.${type}`,
        props: { ...def ? def.defaults : {} },
        grid: { x: cursorX, y: cursorY, w: size.w, h: size.h }
      };
      applyProps(node, item);
      applyBinding(doc, node, item);
      doc.root.children?.push(node);
      cursorX += size.w;
      rowHeight = Math.max(rowHeight, size.h);
    }
    if (!doc.root.children || !doc.root.children.length) return { ok: false, error: "没有生成任何控件", warnings };
    return { ok: true, doc, warnings };
  }
  function clamp(value, min, max) {
    return Math.max(min, Math.min(max, Math.round(value) || min));
  }
  function applyProps(node, item) {
    if (item.title) {
      node.props.title = String(item.title).slice(0, 24);
      if (node.type === "widget.label") node.props.text = String(item.title).slice(0, 80);
    }
    if (item.type === "label" && item.text) node.props.text = String(item.text).slice(0, 80);
    if (item.type === "scope") {
      if (item.points) node.props.points = clamp(Number(item.points) || 160, 20, 2e3);
      node.props.normalize = Boolean(item.normalize);
    }
    if (item.type === "table") node.props.digits = 2;
  }
  function applyBinding(doc, node, item) {
    const transform = item.points ? { fn: "window", args: { limit: clamp(Number(item.points) || 120, 10, 2e3) } } : void 0;
    let generated = null;
    if (item.query) {
      generated = toScoped(node.id, bindingsForQuery(String(item.query), transform));
    } else if (Array.isArray(item.channels) && item.channels.length) {
      generated = toScoped(node.id, bindingsForChannels(item.channels.map(String), transform));
    } else if (item.channel) {
      generated = toScoped(node.id, bindingsForChannels([String(item.channel)], transform));
    }
    if (!generated) return;
    node.bind = generated.bind;
    for (const [key, value] of Object.entries(generated.bindings)) {
      doc.bindings[key] = value;
    }
  }
  function toScoped(nodeId, generated) {
    const bindings2 = {};
    const bind = generated.bind.map((key) => {
      const next = `${nodeId}:${key}`;
      bindings2[next] = generated.bindings[key];
      return next;
    });
    return { bind, bindings: bindings2 };
  }
  const MAX_PATCH_OPS = 50;
  const CONTROL_PROPS = /* @__PURE__ */ new Set(["title", "text", "digits", "tone", "points", "normalize", "grid", "fill", "min", "max", "align", "size", "columns"]);
  function emptyDiff() {
    return { added: 0, removed: 0, updated: 0, moved: 0, renamed: 0 };
  }
  function allowedProps(type) {
    const def = widgetDef(type);
    const keys = new Set(CONTROL_PROPS);
    for (const spec of def ? def.propSchema : []) keys.add(spec.key);
    return keys;
  }
  function gridOf(raw, fallbackW, fallbackH, cols) {
    const w = Math.max(1, Math.min(cols, Math.round(Number(raw?.w) || fallbackW)));
    const h = Math.max(1, Math.round(Number(raw?.h) || fallbackH));
    const x = Math.max(0, Math.min(cols - w, Math.round(Number(raw?.x) || 0)));
    const y = Math.max(0, Math.round(Number(raw?.y) || 0));
    return { x, y, w, h };
  }
  function validateWidgetData(widget, where) {
    const errors = [];
    const type = String(widget.type || "");
    if (!type) errors.push(`${where} 缺少 type`);
    else if (!BOARD_WIDGET_TYPES.includes(type)) {
      errors.push(`${where} 的 type 不支持：${type}（只能是 ${BOARD_WIDGET_TYPES.join("/")}）`);
    }
    if (widget.channel && !channelById(String(widget.channel))) {
      errors.push(`${where} 的 channel 不存在：${widget.channel}`);
    }
    if (Array.isArray(widget.channels)) {
      const bad = widget.channels.map(String).filter((id) => !channelById(id));
      if (bad.length) errors.push(`${where} 的 channels 有未知通道：${bad.join(",")}`);
    }
    return errors;
  }
  function validateNodeId(doc, id, where) {
    if (!id) return [`${where} 缺少 id`];
    return findNode(doc.root, id) ? [] : [`${where} 的控件不存在：${id}`];
  }
  function validatePatch(doc, patch) {
    const errors = [];
    if (!patch || typeof patch !== "object") return ["补丁不是对象"];
    const ops = Array.isArray(patch.ops) ? patch.ops : [];
    if (!ops.length) errors.push("补丁没有任何操作（ops 为空）");
    if (ops.length > MAX_PATCH_OPS) errors.push(`一次最多 ${MAX_PATCH_OPS} 个操作，实际 ${ops.length}`);
    if (patch.baseUpdatedAt && Number(patch.baseUpdatedAt) !== Number(doc.updatedAt)) {
      errors.push("看板已被修改（updatedAt 不一致），请重新读取后再提交");
    }
    const removed = /* @__PURE__ */ new Set();
    ops.forEach((raw, index) => {
      const where = `ops[${index}]`;
      const op = String(raw.op || "");
      if (!["add", "remove", "update", "move", "rename"].includes(op)) {
        errors.push(`${where} 的 op 不支持：${op || "(空)"}`);
        return;
      }
      if (op === "add") {
        const widget = raw.widget;
        if (!widget || typeof widget !== "object") {
          errors.push(`${where} 缺少 widget`);
          return;
        }
        errors.push(...validateWidgetData(widget, `${where}.widget`));
        return;
      }
      if (op === "rename") {
        const name = String(raw.name || "").trim();
        if (!name) errors.push(`${where} 缺少 name`);
        if (name.length > 40) errors.push(`${where} 的 name 超过 40 字`);
        return;
      }
      const id = String(raw.id || "");
      const idErrors = validateNodeId(doc, id, where);
      if (idErrors.length) {
        errors.push(...idErrors);
        return;
      }
      if (removed.has(id)) errors.push(`${where} 重复操作同一个控件：${id}`);
      if (op === "remove") {
        removed.add(id);
        const node = findNode(doc.root, id);
        if (node && node.type === "layout.grid") errors.push(`${where} 不能删除根容器`);
        return;
      }
      if (op === "update") {
        const node = findNode(doc.root, id);
        const allowed = allowedProps(node ? node.type : "");
        const props = raw.props;
        if (props) {
          for (const key of Object.keys(props)) {
            if (!allowed.has(key)) errors.push(`${where}.props 不允许修改字段：${key}`);
          }
        }
        const patchData = {};
        const update = raw;
        if (update.channel) patchData.channel = update.channel;
        if (Array.isArray(update.channels)) patchData.channels = update.channels;
        if (update.query) patchData.query = update.query;
        errors.push(...validateWidgetData({ type: "scope", ...patchData }, `${where}`));
        return;
      }
      if (op === "move") {
        const grid = raw.grid;
        if (!grid || typeof grid !== "object") errors.push(`${where} 缺少 grid`);
        else if (Number(grid.w) < 0 || Number(grid.h) < 0) errors.push(`${where} 的宽高不能为负`);
      }
    });
    return errors;
  }
  function applyPatch(doc, patch) {
    const errors = validatePatch(doc, patch);
    if (errors.length) return { ok: false, errors, diff: emptyDiff() };
    const next = cloneDoc(doc);
    const diff = emptyDiff();
    const cols = next.cols || GRID_COLS;
    for (const raw of patch.ops) {
      const op = raw.op;
      if (op === "add") {
        const widget = raw.widget;
        const explicitGrid = raw.grid;
        const built = composeBoard({ name: next.name, widgets: [widget] });
        if (!built.ok || !built.doc) {
          return { ok: false, errors: [built.error || "控件生成失败"], diff: emptyDiff() };
        }
        const source = built.doc.root.children && built.doc.root.children[0];
        if (!source) return { ok: false, errors: ["控件生成失败：没有节点"], diff: emptyDiff() };
        const def = widgetDef(source.type);
        const fallback = def ? def.defaultSize : { w: 4, h: 3 };
        const slot = explicitGrid ? gridOf(explicitGrid, fallback.w, fallback.h, cols) : findFreeSlot(next.root, fallback.w, fallback.h, cols);
        const node2 = {
          id: source.id,
          type: source.type,
          props: { ...source.props },
          grid: slot
        };
        if (source.bind && source.bind.length) {
          node2.bind = source.bind.slice();
          for (const key of node2.bind) {
            const binding = built.doc.bindings[key];
            if (binding) next.bindings[key] = binding;
          }
        }
        next.root.children = next.root.children || [];
        next.root.children.push(node2);
        diff.added += 1;
        continue;
      }
      if (op === "rename") {
        const name = String(raw.name).trim().slice(0, 40);
        next.name = name;
        diff.renamed += 1;
        continue;
      }
      const node = findNode(next.root, String(raw.id));
      if (!node) continue;
      if (op === "remove") {
        const parent = findParentOf(next.root, node.id);
        if (parent && parent.children) {
          parent.children = parent.children.filter((child) => child.id !== node.id);
          diff.removed += 1;
        }
        continue;
      }
      if (op === "move") {
        const grid = raw.grid;
        node.grid = gridOf({ ...node.grid, ...grid }, node.grid.w, node.grid.h, cols);
        diff.moved += 1;
        continue;
      }
      if (op === "update") {
        const update = raw;
        if (update.props) {
          const allowed = allowedProps(node.type);
          for (const [key, value] of Object.entries(update.props)) {
            if (!allowed.has(key)) continue;
            node.props[key] = value;
          }
        }
        if (update.title != null) node.props.title = String(update.title).slice(0, 24);
        const channelRef = update.channel ? { source: "channel", ref: update.channel } : Array.isArray(update.channels) && update.channels.length ? { source: "channels", ref: update.channels.map(String) } : update.query ? { source: "query", ref: update.query } : null;
        if (channelRef) {
          if (node.bind) node.bind.forEach((key) => delete next.bindings[key]);
          const bindKey = `${node.id}:b1`;
          next.bindings[bindKey] = channelRef;
          node.bind = [bindKey];
        }
        diff.updated += 1;
      }
    }
    next.updatedAt = Date.now();
    return { ok: true, errors: [], doc: normalizeDoc(next) || next, diff };
  }
  function findParentOf(root, id) {
    let found = null;
    const walk = (node) => {
      for (const child of node.children || []) {
        if (child.id === id) {
          found = node;
          return;
        }
        walk(child);
      }
    };
    walk(root);
    return found;
  }
  function describePatch(diff) {
    const parts = [];
    if (diff.added) parts.push(`+${diff.added}`);
    if (diff.removed) parts.push(`-${diff.removed}`);
    if (diff.updated) parts.push(`~${diff.updated}`);
    if (diff.moved) parts.push(`↔${diff.moved}`);
    if (diff.renamed) parts.push("改名");
    return parts.length ? parts.join(" ") : "无变化";
  }
  const STORE_KEY = "xhgcs.ui.boards.v2";
  const LEGACY_KEY = "xhgcs.ui.doc.v1";
  const BACKUP_KEY = "xhgcs.ui.doc.v1.bak";
  const MAX_BOARDS = 50;
  let cached = null;
  function readJSON(key) {
    try {
      const raw = localStorage.getItem(key);
      return raw ? JSON.parse(raw) : null;
    } catch {
      return null;
    }
  }
  function writeJSON(key, value) {
    try {
      localStorage.setItem(key, JSON.stringify(value));
      return true;
    } catch (err) {
      console.warn("[XHGCS_BOARDS] 写入失败", key, err);
      try {
        window.dispatchEvent(new CustomEvent("xhgcs:persist-failed", { detail: { key, error: err instanceof Error ? err.message : String(err) } }));
      } catch (notifyError) {
      }
      return false;
    }
  }
  function makeRecord(doc) {
    return { id: doc.id, name: doc.name, updatedAt: doc.updatedAt || Date.now(), doc };
  }
  function newBoardId() {
    return `ui.${Date.now().toString(36)}${Math.random().toString(36).slice(2, 6)}`;
  }
  function migrateLegacy() {
    const raw = readJSON(LEGACY_KEY);
    if (raw == null) return null;
    const doc = normalizeDoc(raw);
    if (!doc) return null;
    try {
      if (localStorage.getItem(BACKUP_KEY) == null) {
        localStorage.setItem(BACKUP_KEY, JSON.stringify(raw));
      }
    } catch (err) {
      console.warn("[XHGCS_BOARDS] 备份旧存档失败", err);
    }
    return makeRecord(doc);
  }
  function normalizeState(raw) {
    if (!raw || typeof raw !== "object") return null;
    const source = raw;
    if (source.version !== 2 || !Array.isArray(source.boards)) return null;
    const boards = [];
    for (const item of source.boards) {
      if (!item || typeof item !== "object") continue;
      const record = item;
      const doc = normalizeDoc(record.doc);
      if (!doc) continue;
      const id = String(record.id || doc.id);
      const name = String(record.name || doc.name || "看板").slice(0, 40);
      doc.id = id;
      doc.name = name;
      boards.push({ id, name, updatedAt: Number(record.updatedAt) || doc.updatedAt || Date.now(), doc });
      if (boards.length >= MAX_BOARDS) break;
    }
    if (!boards.length) return null;
    const activeId = String(source.activeId || "");
    return {
      version: 2,
      activeId: boards.some((board) => board.id === activeId) ? activeId : boards[0].id,
      boards
    };
  }
  function load() {
    if (cached) return cached;
    const rawStored = localStorage.getItem(STORE_KEY);
    const stored = normalizeState(readJSON(STORE_KEY));
    if (stored) {
      cached = stored;
      return stored;
    }
    if (rawStored) {
      try {
        localStorage.setItem(STORE_KEY + ".bak", rawStored);
      } catch (err) {
        console.warn("[XHGCS_BOARDS] 损坏存档备份失败", err);
      }
    }
    const migrated = migrateLegacy();
    const doc = migrated ? migrated.doc : createDoc("主看板");
    cached = { version: 2, activeId: migrated ? migrated.id : doc.id, boards: [migrated || makeRecord(doc)] };
    persist(cached);
    return cached;
  }
  function persist(state) {
    cached = state;
    return writeJSON(STORE_KEY, {
      version: 2,
      activeId: state.activeId,
      boards: state.boards.map((board) => ({
        id: board.id,
        name: board.name,
        updatedAt: board.updatedAt,
        doc: JSON.parse(serializeDoc(board.doc))
      }))
    });
  }
  function listBoards() {
    const state = load();
    return state.boards.map((board) => ({
      id: board.id,
      name: board.name,
      updatedAt: board.updatedAt,
      active: board.id === state.activeId
    }));
  }
  function activeBoardId() {
    return load().activeId;
  }
  function activeDoc() {
    return activeBoard().doc;
  }
  function activeBoard() {
    const state = load();
    return state.boards.find((board) => board.id === state.activeId) || state.boards[0];
  }
  function getBoard(id) {
    const board = load().boards.find((item) => item.id === id);
    return board ? board.doc : null;
  }
  function saveDoc(doc) {
    const state = load();
    const board = state.boards.find((item) => item.id === state.activeId) || state.boards[0];
    board.doc = doc;
    board.name = doc.name || board.name;
    board.updatedAt = Date.now();
    doc.updatedAt = board.updatedAt;
    return persist(state);
  }
  function replaceActive(doc) {
    saveDoc(doc);
    return activeBoard();
  }
  function switchTo(id) {
    const state = load();
    const board = state.boards.find((item) => item.id === id);
    if (!board) return null;
    state.activeId = id;
    persist(state);
    return board.doc;
  }
  function createBoard(name = "新建看板") {
    const state = load();
    if (state.boards.length >= MAX_BOARDS) {
      throw new Error(`看板数量已达上限 ${MAX_BOARDS} 块，请先删掉不用的`);
    }
    const doc = createDoc(String(name || "新建看板").slice(0, 40));
    state.boards.push(makeRecord(doc));
    state.activeId = doc.id;
    persist(state);
    return doc;
  }
  function duplicateBoard(id) {
    const state = load();
    const source = state.boards.find((item) => item.id === id);
    if (!source) return null;
    if (state.boards.length >= MAX_BOARDS) throw new Error(`看板数量已达上限 ${MAX_BOARDS} 块`);
    const copy = normalizeDoc(JSON.parse(JSON.stringify(source.doc))) || createDoc(source.name + " 副本");
    copy.id = newBoardId();
    copy.name = (source.name + " 副本").slice(0, 40);
    copy.createdAt = Date.now();
    copy.updatedAt = Date.now();
    state.boards.push(makeRecord(copy));
    state.activeId = copy.id;
    persist(state);
    return copy;
  }
  function renameBoard(id, name) {
    const state = load();
    const board = state.boards.find((item) => item.id === id);
    if (!board) return;
    const next = String(name || "").trim().slice(0, 40);
    if (!next) return;
    board.name = next;
    board.doc.name = next;
    board.updatedAt = Date.now();
    persist(state);
  }
  function deleteBoard(id) {
    const state = load();
    if (state.boards.length <= 1) return { ok: false, error: "至少要保留一块看板" };
    const index = state.boards.findIndex((item) => item.id === id);
    if (index < 0) return { ok: false, error: "看板不存在" };
    state.boards.splice(index, 1);
    if (state.activeId === id) state.activeId = state.boards[0].id;
    persist(state);
    return { ok: true };
  }
  function importDoc(text) {
    const doc = parseDoc(text);
    if (!doc) return { ok: false, error: "不是合法的 XHGCS UI 文档" };
    const state = load();
    if (state.boards.length >= MAX_BOARDS) return { ok: false, error: `看板数量已达上限 ${MAX_BOARDS} 块` };
    doc.id = newBoardId();
    doc.updatedAt = Date.now();
    state.boards.push(makeRecord(doc));
    state.activeId = doc.id;
    persist(state);
    return { ok: true, doc };
  }
  function resetBoardCache() {
    cached = null;
  }
  const PATCH_BACKUP_KEY = "xhgcs.ui.patch.backup.v1";
  function applyPatchToActive(patch) {
    const state = load();
    const board = state.boards.find((item) => item.id === state.activeId) || state.boards[0];
    if (!board) return { ok: false, error: "没有活动看板" };
    const result = applyPatch(board.doc, patch);
    if (!result.ok || !result.doc) {
      return { ok: false, error: result.errors.join("；") || "补丁被拒绝", errors: result.errors };
    }
    try {
      localStorage.setItem(PATCH_BACKUP_KEY, JSON.stringify({ id: board.id, at: Date.now(), doc: board.doc }));
    } catch (err) {
      console.warn("[XHGCS_BOARDS] 补丁备份失败", err);
    }
    board.doc = result.doc;
    board.name = result.doc.name || board.name;
    board.updatedAt = Date.now();
    result.doc.updatedAt = board.updatedAt;
    if (!persist(state)) {
      return { ok: false, error: "补丁已应用但写入本机存储失败（可能已满），请先清理空间后重试", diff: result.diff, doc: board.doc };
    }
    try {
      document.dispatchEvent(new CustomEvent("xhgcs:board-changed", { detail: { id: board.id, source: "patch" } }));
    } catch (err) {
    }
    return {
      ok: true,
      diff: result.diff,
      summary: describePatch(result.diff || { added: 0, removed: 0, updated: 0, moved: 0, renamed: 0 }),
      doc: board.doc
    };
  }
  function previewPatch(patch) {
    const state = load();
    const board = state.boards.find((item) => item.id === state.activeId) || state.boards[0];
    if (!board) return { ok: false, errors: ["没有活动看板"], ops: 0 };
    const errors = validatePatch(board.doc, patch);
    return { ok: errors.length === 0, errors, ops: (patch.ops || []).length };
  }
  function revertLastPatch() {
    const raw = readJSON(PATCH_BACKUP_KEY);
    if (!raw || typeof raw !== "object") return { ok: false, error: "没有可回退的补丁" };
    const backup = raw;
    const doc = normalizeDoc(backup.doc);
    if (!doc) return { ok: false, error: "补丁备份已损坏" };
    const state = load();
    const board = state.boards.find((item) => item.id === backup.id) || state.boards.find((item) => item.id === state.activeId);
    if (!board) return { ok: false, error: "备份对应的看板已不存在" };
    board.doc = doc;
    board.name = doc.name || board.name;
    board.updatedAt = Date.now();
    persist(state);
    try {
      document.dispatchEvent(new CustomEvent("xhgcs:board-changed", { detail: { id: board.id, source: "revert" } }));
    } catch (err) {
    }
    return { ok: true };
  }
  const BOARD_STORAGE_KEYS = { store: STORE_KEY, legacy: LEGACY_KEY, backup: BACKUP_KEY };
  const STYLE_ID$1 = "xhgcs-board-style";
  function ensureStyles$1() {
    if (document.getElementById(STYLE_ID$1)) return;
    const style = document.createElement("style");
    style.id = STYLE_ID$1;
    style.textContent = `
.board-mask{position:fixed;inset:0;z-index:9760;background:var(--surf-0,#0d1117);display:flex;flex-direction:column;overflow:hidden}
.board-head{position:absolute;top:0;left:0;right:0;height:44px;display:flex;align-items:center;gap:10px;padding:0 18px;
  background:var(--surf-1,rgba(24,30,37,.72));box-shadow:var(--seam-y,inset 0 -1px 0 rgba(255,255,255,.055));color:var(--text-dim,#8b97a5);font-size:12px;
  opacity:0;transition:opacity .22s ease;z-index:2;pointer-events:none}
.board-mask[data-chrome="1"] .board-head{position:absolute;top:0;left:0;right:0;height:44px;display:flex;align-items:center;gap:10px;padding:0 18px;
  background:var(--surf-1,rgba(24,30,37,.72));box-shadow:var(--seam-y,inset 0 -1px 0 rgba(255,255,255,.055));color:var(--text-dim,#8b97a5);font-size:12px;
  opacity:1;transition:opacity .22s ease;z-index:2;pointer-events:auto}
.board-head b{color:var(--heading,#e6f2ff);font-size:13px;font-weight:600;letter-spacing:.02em}
.board-head .board-spacer{flex:1 1 auto}
.board-head button{border:1px solid var(--edge-hair,rgba(255,255,255,.08));background:var(--surf-2,rgba(30,37,45,.86));color:var(--text,#c9d4e0);
  font-size:11px;padding:5px 11px;border-radius:8px;cursor:pointer;transition:border-color .14s,color .14s,background .14s}
.board-head button:hover{border-color:var(--acc,#6da8d2);color:var(--heading,#e6f2ff);background:rgba(var(--acc-rgb), .16)}
.board-stage{position:absolute;inset:0;padding:52px 22px 22px;overflow:hidden;
  background:radial-gradient(1400px 700px at 50% -12%,rgba(var(--acc-rgb), .05),transparent 62%)}
.board-canvas{position:relative;display:grid;grid-template-columns:repeat(var(--dsg-cols,12),minmax(0,1fr));
  gap:12px;height:100%;width:100%}
.board-canvas .dsg-cell{border:1px solid var(--edge-hair,rgba(255,255,255,.055));border-radius:var(--r-card,10px);
  background:var(--surf-2,rgba(30,37,45,.86));
  overflow:hidden;display:flex;flex-direction:column;min-width:0;min-height:0;
  box-shadow:var(--elev-2,0 10px 22px -10px rgba(0,0,0,.5))}
.board-canvas .dsg-cell:hover{border-color:var(--edge-hair,rgba(255,255,255,.055))}
.board-canvas .dsg-cell-head{display:none}
.board-canvas .dsg-cell-resize{display:none}
.board-canvas .dsg-cell-content{flex:1 1 auto;min-height:0;position:relative}
.board-canvas .dsg-stat{padding:14px 20px;gap:6px}
.board-canvas .dsg-stat-title{font-size:clamp(11px, 1.5vh, 13px);letter-spacing:.04em}
.board-canvas .dsg-stat-value{font-size:clamp(24px, 7vh, 32px)}
.board-canvas .dsg-stat-unit{font-size:12px}
.board-canvas .dsg-label{font-size:clamp(12px, 2vh, 13px);padding:0 16px}
.board-canvas .dsg-missing{padding:10px;font-size:12px;color:var(--warn,#fbbf24);text-align:center}
.board-empty{position:absolute;inset:0;display:flex;align-items:center;justify-content:center;color:var(--text-dim,#7d8896);font-size:13px}
.board-tip{position:absolute;left:50%;bottom:14px;transform:translateX(-50%);font-size:11px;color:var(--text-dim,#7d8896);
  background:var(--surf-2,rgba(30,37,45,.86));border:1px solid var(--edge-hair,rgba(255,255,255,.08));border-radius:999px;padding:4px 12px;
  opacity:0;transition:opacity .2s ease;pointer-events:none}
.board-mask[data-chrome="1"] .board-tip{opacity:1}
`;
    document.head.appendChild(style);
  }
  function loadSavedDoc() {
    try {
      return activeDoc();
    } catch {
      return null;
    }
  }
  function openBoard(options = {}) {
    if (document.querySelector(".board-mask")) return false;
    ensureStyles$1();
    const doc = options.doc || loadSavedDoc();
    if (!doc) return false;
    const mask = document.createElement("div");
    mask.className = "board-mask";
    mask.dataset.chrome = "0";
    const head = document.createElement("div");
    head.className = "board-head";
    const name = document.createElement("b");
    name.textContent = doc.name;
    const count = document.createElement("span");
    count.textContent = `${doc.root.children ? doc.root.children.length : 0} 个控件`;
    const spacer = document.createElement("div");
    spacer.className = "board-spacer";
    const fullscreen = document.createElement("button");
    fullscreen.textContent = "全屏";
    const closeBtn = document.createElement("button");
    closeBtn.textContent = "退出 (Esc)";
    head.append(name, count, spacer, fullscreen, closeBtn);
    const stage = document.createElement("div");
    stage.className = "board-stage";
    const canvas = document.createElement("div");
    canvas.className = "board-canvas";
    stage.appendChild(canvas);
    const tip = document.createElement("div");
    tip.className = "board-tip";
    tip.textContent = "Esc 退出 · F 全屏";
    mask.append(head, stage, tip);
    document.body.appendChild(mask);
    const runtime = new DocRuntime({ container: canvas, extraWidgets: options.widgets || [], tickMs: 250 });
    runtime.setInteractive(true);
    runtime.sync(doc);
    const usedRows = (doc.root.children || []).reduce((max, node) => Math.max(max, node.grid.y + node.grid.h), 0);
    const applyBoardGrid = () => {
      canvas.style.gridTemplateRows = `repeat(${Math.max(1, usedRows)}, minmax(0, 1fr))`;
      canvas.style.minHeight = "0";
    };
    applyBoardGrid();
    window.requestAnimationFrame(() => {
      runtime.refresh();
      applyBoardGrid();
    });
    mask.style.background = "var(--surf-0, #191411)";
    let idleTimer = null;
    const showChrome = () => {
      mask.dataset.chrome = "1";
      if (idleTimer != null) window.clearTimeout(idleTimer);
      idleTimer = window.setTimeout(() => {
        mask.dataset.chrome = "0";
      }, options.idleMs == null ? 2600 : options.idleMs);
    };
    showChrome();
    const resize = () => {
      runtime.refresh();
      applyBoardGrid();
    };
    const close = () => {
      if (document.fullscreenElement) document.exitFullscreen().catch(() => void 0);
      disposeOverlay();
      window.removeEventListener("keydown", onKey, true);
      window.removeEventListener("resize", resize);
      mask.removeEventListener("pointermove", showChrome);
      if (idleTimer != null) window.clearTimeout(idleTimer);
      runtime.dispose();
      mask.remove();
    };
    const toggleFullscreen = () => {
      if (document.fullscreenElement) {
        document.exitFullscreen().catch(() => void 0);
        return;
      }
      mask.requestFullscreen?.().catch(() => void 0);
    };
    let disposeOverlay = () => void 0;
    const onKey = (event) => {
      if (event.key === "f" || event.key === "F") {
        if (event.target?.tagName === "INPUT") return;
        event.preventDefault();
        toggleFullscreen();
      }
    };
    disposeOverlay = pushOverlay({ id: "board", kind: "modal", close });
    window.addEventListener("keydown", onKey, true);
    window.addEventListener("resize", resize);
    mask.addEventListener("pointermove", showChrome);
    closeBtn.addEventListener("click", close);
    fullscreen.addEventListener("click", toggleFullscreen);
    canvas.addEventListener("dblclick", (event) => {
      if (event.target === canvas) toggleFullscreen();
    });
    return true;
  }
  const STYLE_ID = "xhgcs-designer-style";
  let active = null;
  function ensureStyles() {
    if (document.getElementById(STYLE_ID)) return;
    const style = document.createElement("style");
    style.id = STYLE_ID;
    style.textContent = `
/* ---- 外壳 ---- */
.dsg-mask{position:fixed;inset:0;z-index:9700;background:radial-gradient(1200px 600px at 50% -10%,rgba(56,120,180,.10),transparent 60%),rgba(4,7,12,.66);
  backdrop-filter:blur(6px) saturate(1.05);display:flex;align-items:center;justify-content:center;animation:dsg-fade .16s ease;
  /* 窗口按钮已改为渲染层自绘，系统不再往页面上层画，这里只留一点呼吸边距 */
  padding:12px;box-sizing:border-box}
@keyframes dsg-fade{from{opacity:0}to{opacity:1}}
.dsg-shell{width:min(1520px,96vw);height:min(940px,calc(100vh - 24px));display:flex;flex-direction:column;overflow:hidden;
  background:var(--surf-3,#242c36);border:1px solid var(--edge-hair,rgba(255,255,255,.10));
  border-radius:var(--r-overlay,16px);box-shadow:var(--elev-3,0 30px 72px -16px rgba(0,0,0,.62));
  backdrop-filter:var(--surf-blur-top,blur(24px) saturate(150%))}
.dsg-head{display:flex;align-items:center;gap:8px;padding:11px 14px;border-bottom:1px solid var(--edge-soft,rgba(255,255,255,.035));
  background:linear-gradient(180deg,rgba(255,255,255,.035),transparent)}
.dsg-title{width:156px;height:28px;box-sizing:border-box;border:1px solid transparent!important;border-radius:8px;background:transparent!important;color:var(--text-dim,#7d8896)!important;
  font-size:12px!important;font-weight:500!important;line-height:1;font-family:inherit;padding:0 9px;outline:none;transition:background .14s,border-color .14s,color .14s}
.dsg-title:hover{border-color:var(--line,#2d333b)!important;background:var(--bg3,#1f2731)!important;color:var(--text,#c9d4e0)!important}
.dsg-title:focus{border-color:var(--acc,#6da8d2)!important;background:rgba(var(--acc-rgb), .08)!important;color:var(--heading,#e6f2ff)!important;box-shadow:0 0 0 3px rgba(var(--acc-rgb), .14)}
.dsg-board-select{height:30px;max-width:170px;border-radius:9px;border:1px solid var(--edge-hair,rgba(255,255,255,.10));
  background:var(--surf-2,rgba(255,255,255,.04));color:var(--heading,#e6f2ff)!important;font-size:12px!important;font-weight:600!important;line-height:1;font-family:inherit;padding:0 8px;outline:none;cursor:pointer;
  transition:border-color .13s,background .13s}
.dsg-board-select:hover{border-color:rgba(var(--acc-rgb), .5);background:rgba(var(--acc-rgb), .10)}
.dsg-board-select:focus{border-color:var(--acc,#6da8d2)}
.dsg-btn-icon{width:30px;padding:0;justify-content:center;font-size:14px;line-height:1}
.dsg-head .dsg-spacer{flex:1 1 auto}
.dsg-btn{height:30px;padding:0 12px;border-radius:9px;border:1px solid var(--edge-hair,rgba(255,255,255,.10));background:var(--surf-2,rgba(30,37,45,.86));
  color:var(--text,#c9d4e0);font:12px/1 inherit;cursor:pointer;display:inline-flex;align-items:center;gap:6px;
  transition:background .14s,border-color .14s,color .14s,transform .1s}
.dsg-btn:hover:not(:disabled){border-color:var(--edge-soft,var(--edge-hair,rgba(255,255,255,.14)));color:var(--heading,#e6f2ff);background:var(--surf-3,rgba(52,44,37,.93))}
.dsg-btn:active:not(:disabled){transform:translateY(1px)}
.dsg-btn:focus-visible{outline:2px solid var(--acc,#6da8d2);outline-offset:1px}
.dsg-btn:disabled{opacity:.38;cursor:not-allowed}
.dsg-btn[data-primary="1"]{background:var(--acc,#6da8d2);border-color:var(--acc-line,rgba(209,142,92,.42));color:var(--on-acc,#04141f);font-weight:600;
  box-shadow:none}
.dsg-btn[data-primary="1"]:hover{background:var(--acc-solid,var(--acc,#6da8d2));color:var(--on-acc,#04141f);filter:brightness(1.04)}
.dsg-btn[data-on="1"]{border-color:var(--acc,#6da8d2);color:var(--acc,#6da8d2);background:rgba(var(--acc-rgb), .16)}
.dsg-body{flex:1 1 auto;display:flex;min-height:0}

/* ---- 控件库 ---- */
.dsg-palette{width:208px;flex:0 0 208px;border-right:0;box-shadow:var(--seam-x,inset -1px 0 0 rgba(255,255,255,.055));overflow:auto;padding:8px 10px 24px;
  background:rgba(255,255,255,.012)}
.dsg-group-head{position:sticky;top:0;z-index:1;font-size:10px;letter-spacing:.12em;text-transform:uppercase;color:var(--text-dim,#7d8896);
  margin:10px -10px 4px;padding:8px 14px 4px;background:var(--bg2,#161b22)}
.dsg-pal-item{display:flex;align-items:center;gap:9px;padding:8px 9px;border-radius:9px;cursor:grab;color:var(--text,#c9d4e0);
  font-size:12px;border:1px solid transparent;user-select:none;transition:background .13s,border-color .13s,transform .1s}
.dsg-pal-item:hover{background:rgba(var(--acc-rgb), .12);border-color:rgba(var(--acc-rgb), .35);color:var(--heading,#e6f2ff)}
.dsg-pal-item:active{transform:scale(.985);cursor:grabbing}
.dsg-pal-ico{width:20px;height:20px;display:inline-flex;align-items:center;justify-content:center;border-radius:6px;
  background:rgba(var(--acc-rgb), .14);color:var(--acc,#6da8d2);font-size:12px;flex:0 0 auto}

/* ---- 画布 ---- */
.dsg-canvas-wrap{flex:1 1 auto;min-width:0;overflow:auto;padding:18px;background:
  linear-gradient(180deg,rgba(255,255,255,.014),transparent 120px),
  radial-gradient(circle at 1px 1px, rgba(255,255,255,.05) 1px, transparent 0) 0 0/24px 24px, var(--bg,#0d1117)}
.dsg-canvas{position:relative;display:grid;grid-template-columns:repeat(var(--dsg-cols,12),minmax(0,1fr));
  grid-auto-rows:var(--dsg-row,44px);gap:10px;min-height:640px;
  border:0;border-radius:var(--r-panel,12px);padding:12px;background:var(--surf-inset,rgba(2,5,9,.55));
  box-shadow:var(--elev-inset,inset 0 1px 3px rgba(0,0,0,.55));transition:background .15s}
.dsg-canvas:hover{background:var(--surf-inset,rgba(2,5,9,.55))}
.dsg-canvas[data-empty="1"]::after{content:'空画布';position:absolute;inset:0;
  display:flex;align-items:center;justify-content:center;color:var(--text-dim,#7d8896);font-size:13px;letter-spacing:.02em;pointer-events:none}

/* ---- 控件格 ---- */
.dsg-cell{position:relative;border:1px solid var(--edge-hair,rgba(255,255,255,.055));border-radius:var(--r-card,10px);overflow:hidden;
  background:var(--surf-2,rgba(30,37,45,.86));box-shadow:var(--elev-1,0 1px 2px rgba(0,0,0,.26));
  display:flex;flex-direction:column;min-width:0;min-height:0;transition:border-color .14s,box-shadow .14s,transform .14s}
.dsg-cell:hover{border-color:rgba(var(--acc-rgb), .42);box-shadow:var(--elev-2,0 10px 22px -10px rgba(0,0,0,.5))}
.dsg-cell.is-selected{border-color:transparent;box-shadow:0 0 0 1.5px var(--acc,#6da8d2),var(--elev-2,0 10px 22px -10px rgba(0,0,0,.5))}
.dsg-cell-head{display:flex;align-items:center;justify-content:space-between;gap:6px;padding:0 8px;height:22px;cursor:grab;
  background:rgba(255,255,255,.06);border-bottom:1px solid var(--edge-hair,rgba(255,255,255,.05));font-size:10px;color:var(--text-dim,#7d8896);
  opacity:0;transition:opacity .14s;flex:0 0 auto}
.dsg-cell:hover .dsg-cell-head,.dsg-cell.is-selected .dsg-cell-head{opacity:1}
.dsg-cell.is-selected .dsg-cell-head{background:rgba(var(--acc-rgb), .20);color:var(--acc,#6da8d2)}
.dsg-cell-label{white-space:nowrap;overflow:hidden;text-overflow:ellipsis}
.dsg-cell-actions button{border:0;background:transparent;color:inherit;cursor:pointer;font-size:11px;padding:0 3px;opacity:.65;
  border-radius:5px}
.dsg-cell-actions button:hover{opacity:1;color:var(--danger,#f87171);background:rgba(248,113,113,.14)}
.dsg-cell-content{flex:1 1 auto;min-height:0;position:relative}
.dsg-canvas[data-interactive="0"] .dsg-cell-content{pointer-events:none}
.dsg-cell-resize{position:absolute;right:0;bottom:0;width:18px;height:18px;cursor:nwse-resize;opacity:0;transition:opacity .14s;
  background:linear-gradient(135deg,transparent 42%,rgba(var(--acc-rgb), .75) 42%);border-bottom-right-radius:12px}
.dsg-cell:hover .dsg-cell-resize,.dsg-cell.is-selected .dsg-cell-resize{opacity:.9}
.dsg-missing{padding:12px;font-size:12px;color:var(--warn,#fbbf24);text-align:center;line-height:1.6}

/* ---- 属性面板 ---- */
.dsg-props{width:286px;flex:0 0 286px;border-left:0;box-shadow:var(--seam-x-r,inset 1px 0 0 rgba(255,255,255,.055));overflow:auto;padding:0 14px 28px;
  background:rgba(255,255,255,.012)}
.dsg-props-title{position:sticky;top:0;z-index:1;font-size:13px;font-weight:600;color:var(--heading,#e6f2ff);
  margin:0 -14px 10px;padding:13px 14px 9px;display:flex;align-items:center;gap:6px;
  background:var(--bg2,#161b22);backdrop-filter:blur(6px);
  border-bottom:1px solid rgba(255,255,255,.05)}
.dsg-props-title small{font-weight:400;color:var(--text-dim,#7d8896);font-size:10px}
.dsg-field{margin:0 0 12px}
.dsg-field label{display:block;font-size:11px;color:var(--text-dim,#7d8896);margin-bottom:5px;letter-spacing:.02em}
.dsg-field input[type="text"],.dsg-field input[type="number"],.dsg-field select{width:100%;height:30px;border-radius:8px;
  border:1px solid var(--edge-hair,rgba(255,255,255,.08));background:var(--bg2,#161b22);color:var(--text,#c9d4e0);font:12px/1 inherit;padding:0 9px;outline:none;
  transition:border-color .13s,background .13s,box-shadow .13s}
.dsg-field input:focus,.dsg-field select:focus{border-color:var(--acc,#6da8d2);background:rgba(var(--acc-rgb), .08);
  box-shadow:0 0 0 3px rgba(var(--acc-rgb), .14)}
.dsg-check{display:flex;align-items:center;gap:7px;font-size:12px;color:var(--text,#c9d4e0);cursor:pointer}
.dsg-chlist{max-height:196px;overflow:auto;border:1px solid var(--edge-hair,rgba(255,255,255,.08));border-radius:9px;padding:5px;
  background:var(--well,rgba(0,0,0,.16))}
.dsg-chrow{display:flex;align-items:center;gap:7px;font-size:11px;color:var(--text,#c9d4e0);padding:4px 5px;cursor:pointer;border-radius:6px}
.dsg-chrow:hover{background:var(--bg3,#1f2731)}
.dsg-chdot{width:7px;height:7px;border-radius:50%;flex:0 0 auto;box-shadow:0 0 6px currentColor}
.dsg-help{font-size:10px;color:var(--text-dim,#7d8896);margin-top:4px;line-height:1.5}
.dsg-grid-fields{display:grid;grid-template-columns:1fr 1fr;gap:8px}
.dsg-grid-fields .dsg-field{margin:0}
.dsg-ghost{position:fixed;z-index:9800;pointer-events:none;padding:7px 11px;border-radius:9px;font-size:12px;
  background:rgba(var(--acc-rgb), .24);border:1px solid var(--acc,#6da8d2);color:var(--heading,#e6f2ff);backdrop-filter:blur(6px);
  box-shadow:0 10px 28px rgba(0,0,0,.4)}
.dsg-empty-note{color:var(--text-dim,#7d8896);font-size:12px;line-height:1.7;margin-top:14px;padding:12px;
  border:1px dashed var(--edge-soft,var(--edge-hair,rgba(255,255,255,.08)));border-radius:10px;background:var(--bg3,#1f2731)}
.dsg-stat{height:100%;display:flex;flex-direction:column;justify-content:center;padding:10px 14px;gap:3px}
.dsg-stat-title{font-size:11px;color:var(--text-dim,#7d8896);letter-spacing:.03em}
.dsg-stat-value{font-size:16px;font-weight:600;color:var(--text,#c9d4e0);font-variant-numeric:tabular-nums;line-height:1.1;
  letter-spacing:-.01em}
.dsg-stat-unit{font-size:12px;font-weight:400;color:var(--text-dim,#7d8896);margin-left:2px}
.dsg-stat-value[data-tone="ok"]{color:var(--ok,#34d399)}
.dsg-stat-value[data-tone="warn"]{color:var(--warn,#fbbf24)}
.dsg-stat-value[data-tone="danger"]{color:var(--danger,#f87171)}
.dsg-label{height:100%;display:flex;align-items:center;padding:0 10px;color:var(--text,#c9d4e0);overflow:hidden;
  text-overflow:ellipsis;white-space:nowrap}
.dsg-toast{position:fixed;left:50%;bottom:64px;transform:translateX(-50%);z-index:9900;padding:9px 15px;border-radius:9px;
  background:var(--bg2,#161b22);border:1px solid var(--line,#2d333b);color:var(--heading,#e6f2ff);font-size:12px}
`;
    document.head.appendChild(style);
  }
  function loadDoc() {
    const hadStore = Boolean(localStorage.getItem(BOARD_STORAGE_KEYS.store));
    const doc = activeDoc();
    if (!hadStore) {
      const empty = !doc.root.children || doc.root.children.length === 0;
      if (empty) {
        const demo = demoDoc();
        saveDoc(demo);
        return demo;
      }
    }
    return doc;
  }
  function demoDoc() {
    const doc = createDoc("主看板");
    const channels = currentChannels().slice(0, 3).map((channel) => channel.id);
    const stats = [
      { type: "widget.stat", grid: { x: 0, y: 0, w: 3, h: 3 }, props: { title: "实时值" }, bind: channels.slice(0, 1) },
      { type: "widget.gauge", grid: { x: 3, y: 0, w: 3, h: 4 }, props: {}, bind: channels.slice(0, 1) },
      { type: "widget.scope", grid: { x: 6, y: 0, w: 6, h: 9 }, props: {}, bind: channels },
      { type: "widget.table", grid: { x: 0, y: 4, w: 6, h: 5 }, props: {}, bind: channels }
    ];
    for (const item of stats) {
      const def = widgetDef(item.type);
      const id = nextNodeId();
      const node = {
        id,
        type: item.type,
        props: { ...def ? def.defaults : {}, ...item.props },
        grid: item.grid
      };
      if (item.bind && item.bind.length) {
        const generated = bindingsForChannels(item.bind);
        node.bind = generated.bind.map((key) => `${id}:${key}`);
        node.bind.forEach((scoped, index) => {
          doc.bindings[scoped] = generated.bindings[generated.bind[index]];
        });
      }
      doc.root.children?.push(node);
    }
    return doc;
  }
  function persistDoc(doc) {
    try {
      if (!saveDoc(doc)) toast("保存失败：本机存储不可用或已满");
    } catch (err) {
      env.log("warn", "保存设计器文档失败", err);
      toast("保存失败：" + (err instanceof Error ? err.message : String(err)));
    }
  }
  function pluginWidgets() {
    const out = [];
    for (const entry of registry.all("designerWidgets")) {
      const contribution = entry.value;
      const runtime = host.runtime.widgets.get(`${entry.owner}:${contribution.id}`);
      const impl = runtime?.implementation;
      if (!impl) continue;
      const schema = [];
      for (const [key, spec] of Object.entries(contribution.propSchema || {})) {
        const type = String(spec.type || "string");
        if (type === "boolean") schema.push({ key, label: key, type: "boolean" });
        else if (type === "number" || type === "integer")
          schema.push({ key, label: key, type: "number", min: spec.minimum, max: spec.maximum, step: spec.step });
        else if (type === "enum" && Array.isArray(spec.enum))
          schema.push({ key, label: key, type: "select", options: spec.enum.map((value) => ({ value: String(value), label: String(value) })) });
        else schema.push({ key, label: key, type: "text", help: spec.description });
      }
      out.push({
        type: `plugin:${contribution.id}`,
        label: contribution.label || contribution.id,
        icon: contribution.icon || "◈",
        group: contribution.group || "插件控件",
        defaultSize: contribution.defaultSize || { w: 4, h: 3 },
        minSize: contribution.minSize || { w: 2, h: 2 },
        defaults: contribution.defaults || {},
        propSchema: schema,
        create({ el, props }) {
          const factory = typeof impl === "function" ? impl : impl.create;
          const instance = factory ? factory({ el, props }) : null;
          return {
            render: () => instance?.render?.(),
            resize: () => instance?.resize?.(),
            setProps: (next) => instance?.setProps?.(next),
            dispose: () => {
              instance?.dispose?.();
              el.replaceChildren();
            }
          };
        }
      });
    }
    return out;
  }
  function allWidgetDefs() {
    return BUILTIN_WIDGETS.concat(pluginWidgets());
  }
  function toast(message) {
    const el = document.createElement("div");
    el.className = "dsg-toast";
    el.textContent = message;
    document.body.appendChild(el);
    window.setTimeout(() => el.remove(), 2200);
  }
  function openDesigner() {
    if (active) return;
    ensureStyles();
    const doc = loadDoc();
    const history = new UiHistory();
    const extra = pluginWidgets();
    const mask = document.createElement("div");
    mask.className = "dsg-mask";
    const shell = document.createElement("div");
    shell.className = "dsg-shell";
    const head = document.createElement("div");
    head.className = "dsg-head";
    const titleInput = document.createElement("input");
    titleInput.className = "dsg-title";
    titleInput.value = doc.name;
    titleInput.title = "看板名称";
    const boardSelect = document.createElement("select");
    boardSelect.className = "dsg-board-select";
    boardSelect.title = "切换看板";
    const fillBoardSelect = () => {
      boardSelect.replaceChildren();
      for (const board of listBoards()) {
        const option = document.createElement("option");
        option.value = board.id;
        option.textContent = board.name;
        option.selected = board.active;
        boardSelect.appendChild(option);
      }
    };
    fillBoardSelect();
    const btnNewBoard = document.createElement("button");
    btnNewBoard.className = "dsg-btn dsg-btn-icon";
    btnNewBoard.textContent = "＋";
    btnNewBoard.title = "新建看板";
    const btnDupBoard = document.createElement("button");
    btnDupBoard.className = "dsg-btn dsg-btn-icon";
    btnDupBoard.textContent = "⧉";
    btnDupBoard.title = "复制当前看板";
    const btnDelBoard = document.createElement("button");
    btnDelBoard.className = "dsg-btn dsg-btn-icon";
    btnDelBoard.textContent = "🗑";
    btnDelBoard.title = "删除当前看板";
    const spacer = document.createElement("div");
    spacer.className = "dsg-spacer";
    const btnUndo = document.createElement("button");
    btnUndo.className = "dsg-btn";
    btnUndo.textContent = "↶ 撤销";
    btnUndo.title = "Ctrl+Z";
    const btnRedo = document.createElement("button");
    btnRedo.className = "dsg-btn";
    btnRedo.textContent = "↷ 重做";
    btnRedo.title = "Ctrl+Shift+Z / Ctrl+Y";
    const btnPreview = document.createElement("button");
    btnPreview.className = "dsg-btn";
    btnPreview.textContent = "▶ 预览";
    btnPreview.title = "切换到可交互预览，控件可以响应鼠标";
    const btnRun = document.createElement("button");
    btnRun.className = "dsg-btn";
    btnRun.textContent = "⤢ 运行看板";
    btnRun.title = "用同一份文档进入全屏看板（Esc 退出）";
    const btnSave = document.createElement("button");
    btnSave.className = "dsg-btn";
    btnSave.dataset.primary = "1";
    btnSave.textContent = "保存";
    const btnExport = document.createElement("button");
    btnExport.className = "dsg-btn";
    btnExport.textContent = "导出";
    const btnImport = document.createElement("button");
    btnImport.className = "dsg-btn";
    btnImport.textContent = "导入";
    const btnClose = document.createElement("button");
    btnClose.className = "dsg-btn";
    btnClose.textContent = "✕";
    btnClose.title = "关闭（Esc）";
    head.append(titleInput, boardSelect, btnNewBoard, btnDupBoard, btnDelBoard, spacer, btnUndo, btnRedo, btnPreview, btnRun, btnSave, btnExport, btnImport, btnClose);
    const body = document.createElement("div");
    body.className = "dsg-body";
    const palette = document.createElement("div");
    palette.className = "dsg-palette";
    const canvasWrap = document.createElement("div");
    canvasWrap.className = "dsg-canvas-wrap";
    const canvas = document.createElement("div");
    canvas.className = "dsg-canvas";
    canvas.dataset.interactive = "0";
    canvasWrap.appendChild(canvas);
    const props = document.createElement("div");
    props.className = "dsg-props";
    body.append(palette, canvasWrap, props);
    shell.append(head, body);
    mask.appendChild(shell);
    document.body.appendChild(mask);
    const runtime = new DocRuntime({
      container: canvas,
      extraWidgets: extra,
      tickMs: 250,
      onSelect: (id) => select(id)
    });
    const state = {
      mask,
      doc,
      runtime,
      history,
      selected: "",
      preview: false,
      canvas,
      props,
      palette,
      close: () => void 0
    };
    active = state;
    const refreshToolbar = () => {
      btnUndo.disabled = !history.canUndo;
      btnRedo.disabled = !history.canRedo;
      btnUndo.title = history.canUndo ? "撤销：" + history.undoLabel : "没有可撤销的操作";
    };
    const redraw = () => {
      doc.updatedAt = Date.now();
      runtime.sync(doc);
      refreshToolbar();
    };
    const commit = (command) => {
      command.do(doc);
      history.push(command);
      redraw();
    };
    let detachBoardListener = () => void 0;
    let disposeOverlayRef = () => void 0;
    const close = (options = {}) => {
      if (options.save !== false) {
        try {
          if (!saveDoc(doc)) toast("关闭前保存失败：本机存储不可用或已满");
        } catch (err) {
          env.log("warn", "关闭前保存失败", err);
        }
      }
      window.removeEventListener("pagehide", onPageHide);
      detachBoardListener();
      disposeOverlayRef();
      window.removeEventListener("keydown", onKey, true);
      runtime.dispose();
      mask.remove();
      active = null;
    };
    state.close = close;
    const onPageHide = () => {
      try {
        saveDoc(doc);
      } catch (err) {
      }
    };
    window.addEventListener("pagehide", onPageHide);
    const onBoardChanged = (event) => {
      const detail = event.detail || {};
      const current = activeBoard();
      if (detail.id && detail.id !== current.id) return;
      close({ save: false });
      openDesigner();
    };
    document.addEventListener("xhgcs:board-changed", onBoardChanged);
    detachBoardListener = () => document.removeEventListener("xhgcs:board-changed", onBoardChanged);
    disposeOverlayRef = pushOverlay({
      id: "designer",
      kind: "modal",
      onEscape: () => {
        const activeEl = document.activeElement;
        const tag = activeEl ? activeEl.tagName : "";
        if (tag === "INPUT" || tag === "TEXTAREA" || tag === "SELECT") {
          activeEl?.blur();
          return true;
        }
        if (state.selected) {
          select("");
          return true;
        }
        return false;
      },
      close
    });
    const buildPalette = () => {
      palette.replaceChildren();
      const defs = allWidgetDefs();
      const groups = /* @__PURE__ */ new Map();
      for (const def of defs) {
        const list = groups.get(def.group) || [];
        list.push(def);
        groups.set(def.group, list);
      }
      for (const [group, list] of groups) {
        const headEl = document.createElement("div");
        headEl.className = "dsg-group-head";
        headEl.textContent = group;
        palette.appendChild(headEl);
        for (const def of list) {
          const item = document.createElement("div");
          item.className = "dsg-pal-item";
          item.dataset.widgetType = def.type;
          const icon = document.createElement("span");
          icon.className = "dsg-pal-ico";
          icon.textContent = def.icon;
          const label = document.createElement("span");
          label.textContent = def.label;
          item.append(icon, label);
          item.addEventListener("pointerdown", (event) => beginPaletteDrag(event, def));
          palette.appendChild(item);
        }
      }
    };
    const addWidget = (def, rect) => {
      const slot = rect || findFreeSlot(doc.root, def.defaultSize.w, def.defaultSize.h, doc.cols);
      const node = {
        id: nextNodeId(),
        type: def.type,
        props: { ...def.defaults },
        grid: { x: slot.x, y: slot.y, w: Math.max(def.minSize.w, def.defaultSize.w), h: Math.max(def.minSize.h, def.defaultSize.h) }
      };
      commit(insertNodeCommand(doc.root.id, node));
      select(node.id);
    };
    let ghost = null;
    const beginPaletteDrag = (event, def) => {
      event.preventDefault();
      ghost = document.createElement("div");
      ghost.className = "dsg-ghost";
      ghost.textContent = def.icon + " " + def.label;
      document.body.appendChild(ghost);
      ghost.style.left = event.clientX + 12 + "px";
      ghost.style.top = event.clientY + 10 + "px";
      const move = (e) => {
        if (!ghost) return;
        ghost.style.left = e.clientX + 12 + "px";
        ghost.style.top = e.clientY + 10 + "px";
      };
      const up = (e) => {
        document.removeEventListener("pointermove", move);
        document.removeEventListener("pointerup", up);
        ghost?.remove();
        ghost = null;
        const rect = canvas.getBoundingClientRect();
        const inside = e.clientX >= rect.left && e.clientX <= rect.right && e.clientY >= rect.top && e.clientY <= rect.bottom;
        if (inside) {
          const cell = cellFromPoint(e.clientX, e.clientY);
          addWidget(def, { x: cell.x, y: cell.y, w: def.defaultSize.w, h: def.defaultSize.h });
        }
      };
      document.addEventListener("pointermove", move);
      document.addEventListener("pointerup", up);
    };
    const metrics = () => {
      const rect = canvas.getBoundingClientRect();
      const gap = 10;
      const cellW = (rect.width - gap * (doc.cols - 1) - 20) / doc.cols;
      return { rect, gap, cellW, cellH: doc.rowHeight, stepX: cellW + gap, stepY: doc.rowHeight + gap };
    };
    const cellFromPoint = (clientX, clientY) => {
      const m = metrics();
      const x = clientX - m.rect.left - 10;
      const y = clientY - m.rect.top - 10;
      return {
        x: Math.max(0, Math.min(doc.cols - 1, Math.floor(x / m.stepX))),
        y: Math.max(0, Math.floor(y / m.stepY))
      };
    };
    const beginMove = (event, node, cellEl) => {
      if (event.button !== 0) return;
      event.preventDefault();
      event.stopPropagation();
      const m = metrics();
      const startX = event.clientX;
      const startY = event.clientY;
      const origin = { ...node.grid };
      let next = { ...origin };
      let moved = false;
      select(node.id);
      const move = (e) => {
        const dx = Math.round((e.clientX - startX) / m.stepX);
        const dy = Math.round((e.clientY - startY) / m.stepY);
        next = {
          x: Math.max(0, Math.min(doc.cols - origin.w, origin.x + dx)),
          y: Math.max(0, origin.y + dy),
          w: origin.w,
          h: origin.h
        };
        if (next.x !== origin.x || next.y !== origin.y) moved = true;
        cellEl.style.gridArea = gridAreaOf(next);
      };
      const up = () => {
        document.removeEventListener("pointermove", move);
        document.removeEventListener("pointerup", up);
        if (!moved) return;
        commit(moveNodeCommand(node.id, next, "移动控件"));
      };
      document.addEventListener("pointermove", move);
      document.addEventListener("pointerup", up);
    };
    const beginResize = (event, node, cellEl) => {
      if (event.button !== 0) return;
      event.preventDefault();
      event.stopPropagation();
      const def = widgetDef(node.type, extra);
      const min = def ? def.minSize : { w: 1, h: 1 };
      const m = metrics();
      const startX = event.clientX;
      const startY = event.clientY;
      const origin = { ...node.grid };
      let next = { ...origin };
      let resized = false;
      const move = (e) => {
        const dw = Math.round((e.clientX - startX) / m.stepX);
        const dh = Math.round((e.clientY - startY) / m.stepY);
        next = {
          x: origin.x,
          y: origin.y,
          w: Math.max(min.w, Math.min(doc.cols - origin.x, origin.w + dw)),
          h: Math.max(min.h, origin.h + dh)
        };
        if (next.w !== origin.w || next.h !== origin.h) resized = true;
        cellEl.style.gridArea = gridAreaOf(next);
      };
      const up = () => {
        document.removeEventListener("pointermove", move);
        document.removeEventListener("pointerup", up);
        if (!resized) return;
        commit(moveNodeCommand(node.id, next, "调整控件大小"));
      };
      document.addEventListener("pointermove", move);
      document.addEventListener("pointerup", up);
    };
    canvas.addEventListener("pointerdown", (event) => {
      const target = event.target;
      const cellEl = target.closest(".dsg-cell");
      if (!cellEl) return;
      const nodeId = cellEl.dataset.nodeId || "";
      const node = findNode(doc.root, nodeId);
      if (!node) return;
      if (target.dataset.role === "delete") {
        event.stopPropagation();
        commit(removeNodeCommand(nodeId));
        select("");
        return;
      }
      if (state.preview) return;
      select(nodeId);
      if (target.dataset.role === "resize") beginResize(event, node, cellEl);
      else if (target.dataset.role === "drag" || target === cellEl) beginMove(event, node, cellEl);
    });
    const select = (nodeId) => {
      state.selected = nodeId;
      runtime.setSelected(nodeId);
      renderProps();
    };
    const updateNodeProps = (nodeId, patch, coalesceKey = "") => {
      const node = findNode(doc.root, nodeId);
      if (!node) return;
      if (coalesceKey) {
        const merges = coalescer.shouldMerge(nodeId + ":" + coalesceKey);
        if (merges) {
          node.props = { ...node.props, ...patch };
          runtime.sync(doc);
          return;
        }
      }
      commit(propsCommand(nodeId, patch));
    };
    const coalescer = new Coalescer(500);
    const field = (labelText, control, help) => {
      const wrap = document.createElement("div");
      wrap.className = "dsg-field";
      const label = document.createElement("label");
      label.textContent = labelText;
      wrap.append(label, control);
      if (help) {
        const hint = document.createElement("div");
        hint.className = "dsg-help";
        hint.textContent = help;
        wrap.appendChild(hint);
      }
      return wrap;
    };
    const renderProps = () => {
      props.replaceChildren();
      const title = document.createElement("div");
      title.className = "dsg-props-title";
      const node = state.selected ? findNode(doc.root, state.selected) : null;
      if (!node) {
        title.append(document.createTextNode("看板设置"));
        props.appendChild(title);
        const nameInput = document.createElement("input");
        nameInput.type = "text";
        nameInput.value = doc.name;
        nameInput.addEventListener("change", () => {
          doc.name = nameInput.value.trim() || doc.name;
          titleInput.value = doc.name;
          redraw();
        });
        props.appendChild(field("名称", nameInput));
        const colsInput = document.createElement("input");
        colsInput.type = "number";
        colsInput.min = "4";
        colsInput.max = "24";
        colsInput.value = String(doc.cols);
        colsInput.addEventListener("change", () => {
          doc.cols = Math.max(4, Math.min(24, Number(colsInput.value) || GRID_COLS));
          redraw();
        });
        props.appendChild(field("栅格列数", colsInput));
        const rowInput = document.createElement("input");
        rowInput.type = "number";
        rowInput.min = "24";
        rowInput.max = "120";
        rowInput.step = "4";
        rowInput.value = String(doc.rowHeight);
        rowInput.addEventListener("change", () => {
          doc.rowHeight = Math.max(24, Math.min(120, Number(rowInput.value) || ROW_HEIGHT));
          redraw();
        });
        props.appendChild(field("行高（px）", rowInput));
        const note = document.createElement("div");
        note.className = "dsg-empty-note";
        note.textContent = "未选中控件";
        props.appendChild(note);
        return;
      }
      const def = widgetDef(node.type, extra);
      title.append(
        document.createTextNode((def ? def.label : node.type) + " "),
        Object.assign(document.createElement("small"), { textContent: node.id })
      );
      props.appendChild(title);
      if (!def) {
        const note = document.createElement("div");
        note.className = "dsg-empty-note";
        note.textContent = "未知控件类型，节点已保留但无法编辑属性。";
        props.appendChild(note);
        return;
      }
      for (const spec of def.propSchema) {
        props.appendChild(buildPropField(node, spec));
      }
      props.appendChild(buildBindingEditor(node));
      const gridTitle = document.createElement("div");
      gridTitle.className = "dsg-group-head";
      gridTitle.textContent = "位置与尺寸";
      props.appendChild(gridTitle);
      const gridWrap = document.createElement("div");
      gridWrap.className = "dsg-grid-fields";
      ["x", "y", "w", "h"].forEach((key) => {
        const input = document.createElement("input");
        input.type = "number";
        input.min = key === "w" || key === "h" ? "1" : "0";
        input.value = String(node.grid[key]);
        const wrap = document.createElement("div");
        wrap.className = "dsg-field";
        const label = document.createElement("label");
        label.textContent = { x: "列", y: "行", w: "宽", h: "高" }[key];
        wrap.append(label, input);
        input.addEventListener("change", () => {
          const next = { ...node.grid, [key]: Number(input.value) || 0 };
          commit(moveNodeCommand(node.id, next, "修改位置"));
        });
        gridWrap.appendChild(wrap);
      });
      props.appendChild(gridWrap);
    };
    const applyBindings = (node, next) => {
      const scopedBindings = {};
      const scopedBind = next.bind.map((key) => {
        const scoped = `${node.id}:${key}`;
        scopedBindings[scoped] = next.bindings[key];
        return scoped;
      });
      commit(bindingsCommand(node.id, scopedBind, scopedBindings));
    };
    const transformFromInputs = (fn, amount) => {
      if (!fn) return void 0;
      if (fn === "window") return { fn: "window", args: { limit: Math.max(10, Math.min(2e3, amount || 120)) } };
      if (fn === "normalize") return { fn: "normalize" };
      if (fn === "scale") return { fn: "scale", args: { factor: Number.isFinite(amount) ? amount : 1 } };
      return void 0;
    };
    const buildBindingEditor = (node) => {
      const wrap = document.createElement("div");
      const head2 = document.createElement("div");
      head2.className = "dsg-group-head";
      head2.textContent = "数据绑定";
      wrap.appendChild(head2);
      const current = bindingsOf(doc, node);
      const summary = document.createElement("div");
      summary.className = "dsg-help";
      summary.style.whiteSpace = "pre-line";
      summary.textContent = current.length ? current.map(describeBinding).join("\n") : "未绑定 · 默认取前三条通道";
      wrap.appendChild(summary);
      const currentTransform = bindingTransformOf(doc, node);
      const transformFn = currentTransform ? currentTransform.fn : "";
      const transformAmount = currentTransform && currentTransform.args ? Number(currentTransform.fn === "scale" ? currentTransform.args.factor : currentTransform.args.limit) || 0 : 0;
      const transformSelect = document.createElement("select");
      [
        { value: "", label: "原始值" },
        { value: "window", label: "最近 N 点" },
        { value: "normalize", label: "归一化 0-1" },
        { value: "scale", label: "线性缩放" }
      ].forEach((option) => {
        const el = document.createElement("option");
        el.value = option.value;
        el.textContent = option.label;
        transformSelect.appendChild(el);
      });
      transformSelect.value = transformFn;
      wrap.appendChild(field("变换", transformSelect));
      const amountInput = document.createElement("input");
      amountInput.type = "number";
      amountInput.value = String(transformAmount || (transformFn === "scale" ? 1 : 120));
      const amountField = field(transformFn === "scale" ? "缩放系数" : "点数", amountInput);
      amountField.hidden = transformFn !== "window" && transformFn !== "scale";
      wrap.appendChild(amountField);
      const readTransform = () => transformFromInputs(transformSelect.value, Number(amountInput.value));
      transformSelect.addEventListener("change", () => {
        amountField.hidden = transformSelect.value !== "window" && transformSelect.value !== "scale";
        const transform = readTransform();
        const existing = bindingsOf(doc, node);
        const channelIds = existing.filter((item) => item.source === "channel" && typeof item.ref === "string").map((item) => String(item.ref));
        if (channelIds.length) applyBindings(node, bindingsForChannels(channelIds, transform));
        else renderProps();
      });
      amountInput.addEventListener("change", () => {
        const transform = readTransform();
        const existing = bindingsOf(doc, node);
        const channelIds = existing.filter((item) => item.source === "channel" && typeof item.ref === "string").map((item) => String(item.ref));
        if (channelIds.length) applyBindings(node, bindingsForChannels(channelIds, transform));
      });
      const sourceSelect = document.createElement("select");
      [
        { value: "channel", label: "按通道选择" },
        { value: "query", label: "按名字匹配" }
      ].forEach((option) => {
        const el = document.createElement("option");
        el.value = option.value;
        el.textContent = option.label;
        sourceSelect.appendChild(el);
      });
      const usingQuery = current.length > 0 && current.every((item) => item.source === "query");
      sourceSelect.value = usingQuery ? "query" : "channel";
      wrap.appendChild(field("来源", sourceSelect));
      const channelBox = document.createElement("div");
      channelBox.className = "dsg-field";
      const channelLabel = document.createElement("label");
      channelLabel.textContent = "绑定通道";
      const list = document.createElement("div");
      list.className = "dsg-chlist";
      channelBox.append(channelLabel, list);
      wrap.appendChild(channelBox);
      const queryBox = document.createElement("div");
      queryBox.className = "dsg-field";
      const queryInput = document.createElement("input");
      queryInput.type = "text";
      queryInput.placeholder = "名字/ID 子串，* 表示全部";
      queryInput.value = usingQuery && current[0] ? String(current[0].ref) : "";
      const applyQuery = document.createElement("button");
      applyQuery.className = "dsg-btn";
      applyQuery.textContent = "应用匹配";
      applyQuery.style.marginTop = "6px";
      applyQuery.addEventListener("click", () => {
        const text = queryInput.value.trim();
        if (!text) return;
        applyBindings(node, bindingsForQuery(text, readTransform()));
      });
      queryBox.append(field("匹配规则", queryInput), applyQuery);
      queryBox.hidden = sourceSelect.value !== "query";
      wrap.appendChild(queryBox);
      const selectedIds = new Set(
        current.filter((item) => item.source === "channel" && typeof item.ref === "string").map((item) => String(item.ref))
      );
      const channels = currentChannels();
      if (!channels.length) {
        const empty = document.createElement("div");
        empty.className = "dsg-help";
        empty.textContent = "当前没有通道";
        list.appendChild(empty);
      }
      channels.forEach((channel) => {
        const row = document.createElement("label");
        row.className = "dsg-chrow";
        const box = document.createElement("input");
        box.type = "checkbox";
        box.checked = selectedIds.has(channel.id);
        const dot = document.createElement("span");
        dot.className = "dsg-chdot";
        dot.style.background = channel.color || "#6da8d2";
        const text = document.createElement("span");
        text.textContent = (channel.name || channel.id) + (channel.unit ? " (" + channel.unit + ")" : "");
        box.addEventListener("change", () => {
          if (box.checked) selectedIds.add(channel.id);
          else selectedIds.delete(channel.id);
          applyBindings(node, bindingsForChannels(Array.from(selectedIds), readTransform()));
        });
        row.append(box, dot, text);
        list.appendChild(row);
      });
      sourceSelect.addEventListener("change", () => {
        const queryMode = sourceSelect.value === "query";
        channelBox.hidden = queryMode;
        queryBox.hidden = !queryMode;
      });
      channelBox.hidden = sourceSelect.value === "query";
      const clear = document.createElement("button");
      clear.className = "dsg-btn";
      clear.textContent = "清除绑定";
      clear.style.marginTop = "8px";
      clear.addEventListener("click", () => {
        commit(bindingsCommand(node.id, [], {}));
      });
      wrap.appendChild(clear);
      const issues = doc ? resolveIssues(node) : [];
      if (issues.length) {
        const warn = document.createElement("div");
        warn.className = "dsg-help";
        warn.style.color = "var(--warn, #fbbf24)";
        warn.textContent = issues.join("\n");
        warn.style.whiteSpace = "pre-line";
        wrap.appendChild(warn);
      }
      return wrap;
    };
    const resolveIssues = (node) => {
      try {
        return resolveNode(doc, node).issues.map((issue2) => issue2.message);
      } catch {
        return [];
      }
    };
    const buildPropField = (node, spec) => {
      const value = node.props[spec.key];
      if (spec.type === "boolean") {
        const wrap = document.createElement("div");
        wrap.className = "dsg-field";
        const label = document.createElement("label");
        label.className = "dsg-check";
        const input2 = document.createElement("input");
        input2.type = "checkbox";
        input2.checked = value !== false && value !== void 0 ? Boolean(value) : Boolean(value);
        input2.checked = Boolean(value);
        input2.addEventListener("change", () => updateNodeProps(node.id, { [spec.key]: input2.checked }));
        const text = document.createElement("span");
        text.textContent = spec.label;
        label.append(input2, text);
        wrap.appendChild(label);
        if (spec.help) {
          const hint = document.createElement("div");
          hint.className = "dsg-help";
          hint.textContent = spec.help;
          wrap.appendChild(hint);
        }
        return wrap;
      }
      if (spec.type === "select") {
        const selectEl = document.createElement("select");
        for (const option of spec.options || []) {
          const optionEl = document.createElement("option");
          optionEl.value = option.value;
          optionEl.textContent = option.label;
          selectEl.appendChild(optionEl);
        }
        selectEl.value = String(value ?? "");
        selectEl.addEventListener("change", () => updateNodeProps(node.id, { [spec.key]: selectEl.value }));
        return field(spec.label, selectEl, spec.help);
      }
      if (spec.type === "number") {
        const input2 = document.createElement("input");
        input2.type = "number";
        if (spec.min != null) input2.min = String(spec.min);
        if (spec.max != null) input2.max = String(spec.max);
        if (spec.step != null) input2.step = String(spec.step);
        input2.value = value == null ? "" : String(value);
        input2.addEventListener("input", () => updateNodeProps(node.id, { [spec.key]: Number(input2.value) || 0 }, spec.key));
        return field(spec.label, input2, spec.help);
      }
      const input = document.createElement("input");
      input.type = "text";
      input.value = value == null ? "" : String(value);
      input.addEventListener("change", () => updateNodeProps(node.id, { [spec.key]: input.value }));
      return field(spec.label, input, spec.help);
    };
    titleInput.addEventListener("change", () => {
      doc.name = titleInput.value.trim() || doc.name;
      titleInput.value = doc.name;
    });
    btnUndo.addEventListener("click", () => {
      if (history.undo(doc)) redraw();
    });
    btnRedo.addEventListener("click", () => {
      if (history.redo(doc)) redraw();
    });
    btnPreview.addEventListener("click", () => {
      state.preview = !state.preview;
      runtime.setInteractive(state.preview);
      canvas.dataset.interactive = state.preview ? "1" : "0";
      btnPreview.dataset.on = state.preview ? "1" : "0";
      btnPreview.textContent = state.preview ? "✎ 编辑" : "▶ 预览";
      canvas.classList.toggle("is-preview", state.preview);
    });
    btnSave.addEventListener("click", () => {
      persistDoc(doc);
      toast("已保存到本机：" + doc.name);
    });
    btnRun.addEventListener("click", () => {
      persistDoc(doc);
      close();
      if (!openBoard({ doc, widgets: extra })) toast("看板启动失败：没有文档");
    });
    btnExport.addEventListener("click", () => {
      const blob = new Blob([serializeDoc(doc)], { type: "application/json" });
      const url = URL.createObjectURL(blob);
      const link = document.createElement("a");
      link.href = url;
      link.download = doc.name.replace(/[\\/:*?"<>|]/g, "_") + ".xhgcs.ui.json";
      link.click();
      window.setTimeout(() => URL.revokeObjectURL(url), 2e3);
    });
    btnImport.addEventListener("click", () => {
      const input = document.createElement("input");
      input.type = "file";
      input.accept = ".json,application/json";
      input.addEventListener("change", async () => {
        const file = input.files && input.files[0];
        if (!file) return;
        const text = await file.text();
        const result = importDoc(text);
        if (!result.ok) {
          toast("导入失败：" + (result.error || "不是合法的 XHGCS UI 文档"));
          return;
        }
        close();
        openDesigner();
      });
      input.click();
    });
    boardSelect.addEventListener("change", () => {
      persistDoc(doc);
      const next = switchTo(boardSelect.value);
      if (!next) {
        toast("切换失败：看板不存在");
        fillBoardSelect();
        return;
      }
      close();
      openDesigner();
    });
    btnNewBoard.addEventListener("click", () => {
      persistDoc(doc);
      try {
        createBoard("看板 " + (listBoards().length + 1));
      } catch (err) {
        toast(err instanceof Error ? err.message : String(err));
        return;
      }
      close();
      openDesigner();
    });
    btnDupBoard.addEventListener("click", () => {
      persistDoc(doc);
      try {
        duplicateBoard(activeBoard().id);
      } catch (err) {
        toast(err instanceof Error ? err.message : String(err));
        return;
      }
      close();
      openDesigner();
    });
    btnDelBoard.addEventListener("click", () => {
      const current = activeBoard();
      if (!window.confirm(`删除看板「${current.name}」？此操作不可撤销。`)) return;
      const result = deleteBoard(current.id);
      if (!result.ok) {
        toast(result.error || "删除失败");
        return;
      }
      close();
      openDesigner();
    });
    btnClose.addEventListener("click", () => close());
    const onKey = (event) => {
      const target = event.target;
      const inputType = target instanceof HTMLInputElement ? String(target.type || "text") : "";
      const textEditing = Boolean(
        target && (target.tagName === "TEXTAREA" || target.tagName === "INPUT" && !["checkbox", "radio", "button", "submit", "range", "color", "file"].includes(inputType))
      );
      if (textEditing) return;
      const mod = event.ctrlKey || event.metaKey;
      if (mod && event.key.toLowerCase() === "z") {
        event.preventDefault();
        if (event.shiftKey) history.redo(doc) && redraw();
        else history.undo(doc) && redraw();
        return;
      }
      if (mod && event.key.toLowerCase() === "y") {
        event.preventDefault();
        if (history.redo(doc)) redraw();
        return;
      }
      if (mod && event.key.toLowerCase() === "s") {
        event.preventDefault();
        persistDoc(doc);
        toast("已保存");
        return;
      }
      if (mod && event.key.toLowerCase() === "d" && state.selected) {
        event.preventDefault();
        const node = findNode(doc.root, state.selected);
        const parent = findParent(doc.root, state.selected);
        if (node && parent) {
          const copy = duplicateNode(node);
          copy.grid = { ...node.grid, y: node.grid.y + node.grid.h };
          commit(insertNodeCommand(parent.id, copy, "复制控件"));
          select(copy.id);
        }
        return;
      }
      if ((event.key === "Delete" || event.key === "Backspace") && state.selected) {
        event.preventDefault();
        commit(removeNodeCommand(state.selected));
        select("");
        return;
      }
      const arrows = {
        ArrowLeft: [-1, 0],
        ArrowRight: [1, 0],
        ArrowUp: [0, -1],
        ArrowDown: [0, 1]
      };
      const delta = arrows[event.key];
      if (delta && state.selected && !mod && !textEditing) {
        const node = findNode(doc.root, state.selected);
        if (node) {
          event.preventDefault();
          if (event.shiftKey) {
            const next = {
              ...node.grid,
              w: Math.max(1, Math.min(doc.cols - node.grid.x, node.grid.w + delta[0])),
              h: Math.max(1, node.grid.h + delta[1])
            };
            commit(moveNodeCommand(node.id, next, "调整控件大小"));
          } else {
            const next = {
              ...node.grid,
              x: Math.max(0, Math.min(doc.cols - node.grid.w, node.grid.x + delta[0])),
              y: Math.max(0, node.grid.y + delta[1])
            };
            commit(moveNodeCommand(node.id, next, "移动控件"));
          }
          return;
        }
      }
    };
    window.addEventListener("keydown", onKey, true);
    history.onChange(refreshToolbar);
    buildPalette();
    runtime.setInteractive(false);
    runtime.sync(doc);
    refreshToolbar();
    renderProps();
    const shellEl = mask.querySelector(".dsg-shell");
    if (shellEl) {
      shellEl.tabIndex = -1;
      shellEl.focus({ preventScroll: true });
    }
  }
  function attachStatusBar() {
    const target = document.querySelector(".top-right");
    if (!target) return;
    const holder = document.createElement("div");
    holder.className = "xhgcs-status-slot";
    holder.style.cssText = "display:flex;align-items:center;gap:6px;max-width:46vw;overflow:hidden;";
    const clock = document.getElementById("clockText");
    if (clock && clock.parentElement === target) target.insertBefore(holder, clock);
    else target.appendChild(holder);
    statusBar.attach(holder);
  }
  function syncStatusBarWithRegistry() {
    registry.onDidChange((change) => {
      if (change.point !== "statusBar") return;
      if (change.kind === "register") {
        const item = registry.get("statusBar", change.id);
        if (item) statusBar.add(change.owner, item);
      } else if (change.kind === "unregister") {
        statusBar.remove(change.owner, change.id);
      }
    });
  }
  const CORE_MANIFEST = {
    id: "xihe.core",
    name: "内核基础能力",
    version: CORE_VERSION,
    publisher: "xihe",
    description: "命令面板、扩展管理面板等内核级入口，同时也是贡献点机制的示范。",
    apiVersion: CORE_API_VERSION,
    engines: { xhgcs: ">=0.10.0 <1.0.0" },
    main: "inline",
    inlineScript: `
    function activate(ctx) {
      const api = ctx.api;
      api.commands.register('xhgcs.commandPalette', function () {
        if (window.XHGCS_CORE) window.XHGCS_CORE.ui.openPalette();
      });
      api.commands.register('xhgcs.extensions', function () {
        if (window.XHGCS_CORE) window.XHGCS_CORE.ui.openExtensions();
      });
      api.commands.register('xhgcs.about', function () {
        var total = window.XHGCS_CORE ? window.XHGCS_CORE.host.list().length : 0;
        api.toast('XiHe_GCS 内核 ' + api.version + ' · 已发现扩展 ' + total + ' 个');
      });
      api.commands.register('xhgcs.designer', function () {
        if (window.XHGCS_CORE) window.XHGCS_CORE.ui.openDesigner();
      });
      api.commands.register('xhgcs.config', function () {
        if (window.XHGCS_CORE) window.XHGCS_CORE.ui.openExtensionSettings();
      });
      api.commands.register('xhgcs.pipeline', function () {
        if (window.XHGCS_CORE) window.XHGCS_CORE.ui.openPipeline();
      });
      api.commands.register('xhgcs.views', function () {
        if (window.XHGCS_CORE) window.XHGCS_CORE.ui.openViews();
      });
      api.commands.register('xhgcs.board', function () {
        if (window.XHGCS_CORE) window.XHGCS_CORE.ui.openBoard();
      });
    }
  `,
    activationEvents: ["onStartup"],
    dependencies: [],
    permissions: ["ui:toast", "ui:statusBar", "commands:execute"],
    contributes: {
      commands: [
        { id: "xhgcs.commandPalette", title: "命令面板", category: "内核" },
        { id: "xhgcs.extensions", title: "扩展管理", category: "内核" },
        { id: "xhgcs.designer", title: "可视化设计器", category: "内核" },
        { id: "xhgcs.board", title: "运行看板", category: "内核" },
        { id: "xhgcs.config", title: "扩展配置", category: "内核" },
        { id: "xhgcs.pipeline", title: "数据管线监视", category: "内核" },
        { id: "xhgcs.views", title: "插件视图", category: "内核" },
        { id: "xhgcs.about", title: "关于内核", category: "内核" }
      ],
      menus: [
        { location: "rail", command: "xhgcs.designer", icon: "⊞", label: "设计器", order: 55 },
        { location: "rail", command: "xhgcs.views", icon: "◫", label: "视图", order: 56 },
        { location: "rail", command: "xhgcs.board", icon: "⤢", label: "看板", order: 57 }
      ],
      keybindings: [
        { key: "ctrl+shift+p", command: "xhgcs.commandPalette" },
        { key: "ctrl+shift+x", command: "xhgcs.extensions" },
        { key: "ctrl+shift+d", command: "xhgcs.designer" },
        { key: "ctrl+shift+b", command: "xhgcs.board" },
        { key: "ctrl+shift+v", command: "xhgcs.views" },
        { key: "ctrl+shift+,", command: "xhgcs.config" },
        { key: "ctrl+shift+e", command: "xhgcs.pipeline" }
      ],
      statusBar: [
        {
          id: "core.extensions",
          text: "扩展 0",
          alignment: "right",
          priority: 60,
          command: "xhgcs.extensions",
          tooltip: "打开扩展管理"
        },
        {
          id: "core.pipeline",
          text: "管线 0",
          alignment: "right",
          priority: 55,
          command: "xhgcs.pipeline",
          tooltip: "数据管线：已处理帧 / 积压 / 丢弃"
        }
      ]
    }
  };
  function bridgeLegacyEvents() {
    const navMap = {
      visual: "visual",
      wave: "visual",
      analysis: "analysis",
      engine: "engine",
      serial: "serial",
      alarm: "alarm",
      sim: "sim"
    };
    document.addEventListener(
      "click",
      (event) => {
        const target = event.target?.closest?.('[data-nav], [data-settings-nav], [data-action="settings"]');
        if (!target) return;
        const nav = target.dataset.nav;
        const settingsNav = target.dataset.settingsNav;
        if (nav) {
          const panel = navMap[nav] || nav;
          host.fireEvent("onPanel", panel).catch((err) => env.log("warn", `激活 onPanel:${panel} 失败`, err));
        }
        if (settingsNav) {
          host.fireEvent("onConfig", `settings.${settingsNav}`).catch(() => void 0);
        }
        if (target.dataset.action === "settings") {
          host.fireEvent("onPanel", "settings").catch((err) => env.log("warn", "激活 onPanel:settings 失败", err));
        }
      },
      true
    );
  }
  function refreshExtensionBadge() {
    const count = host.list().length;
    statusBar.update("xihe.core", "core.extensions", { text: `扩展 ${count}` });
  }
  function renderRailMenus() {
    const nav = document.getElementById("sideNav");
    if (!nav) return;
    const anchor = nav.querySelector(".nav-gap");
    nav.querySelectorAll("[data-xhgcs-menu]").forEach((node) => node.remove());
    const items = registry.all("menus").filter((entry) => entry.value.location === "rail").filter((entry) => evaluateWhen(entry.value.when, buildWhenContext())).sort((a, b) => (a.value.order ?? 100) - (b.value.order ?? 100));
    for (const entry of items) {
      const command = entry.value.command;
      const contribution = registry.get("commands", command);
      const button = document.createElement("button");
      button.className = "tool";
      button.dataset.xhgcsMenu = command;
      button.title = entry.value.label || contribution?.title || command;
      const box = document.createElement("div");
      const icon = document.createElement("div");
      icon.className = "ico";
      icon.textContent = entry.value.icon || contribution?.icon || "▣";
      const label = document.createElement("div");
      label.className = "lbl";
      label.textContent = (entry.value.label || contribution?.title || command).slice(0, 3);
      box.append(icon, label);
      button.appendChild(box);
      button.addEventListener("click", () => {
        executeCommand(command).catch((err) => env.log("warn", `菜单命令 ${command} 失败`, err));
      });
      if (anchor && anchor.parentElement === nav) nav.insertBefore(button, anchor);
      else nav.appendChild(button);
    }
  }
  function bootstrapPipeline() {
    const { pipeline: pipeline2 } = engine;
    pipeline2.registerOperator("xihe.core", engine.stages.passthrough());
    for (const factory of [engine.stages.scale, engine.stages.lowpass, engine.stages.windowMean, engine.stages.threshold]) {
      const operator = factory();
      pipeline2.registerOperator("xihe.core", operator);
      pipeline2.setOperatorEnabled(operator.id, false);
    }
    bindPipelineParamPersistence();
    pipeline2.registerSink("xihe.core", engine.stages.metricsSink());
    const channels = engine.stages.channelSink();
    pipeline2.registerSink("xihe.core", channels);
    pipeline2.setSinkEnabled(channels.id, false);
    const recorderSink = engine.recorder.sink();
    pipeline2.registerSink("xihe.core", recorderSink);
    pipeline2.setSinkEnabled(recorderSink.id, false);
    pipeline2.registerSource("xihe.core", engine.sources.legacySample());
    pipeline2.registerSource("xihe.core", engine.sources.replay());
    pipeline2.startSource("builtin.legacy-sample");
    pipeline2.start();
    let lastUpdate = 0;
    pipeline2.onMetricsChange((metrics) => {
      const now = Date.now();
      if (now - lastUpdate < 900) return;
      lastUpdate = now;
      const text = metrics.dropped ? `管线 ${metrics.processed} · 丢 ${metrics.dropped}` : `管线 ${metrics.processed}`;
      statusBar.update("xihe.core", "core.pipeline", {
        text,
        tone: metrics.dropped || metrics.errors ? "warn" : "default",
        tooltip: `队列 ${metrics.queued}/${metrics.capacity} · 平均 ${metrics.avgLatencyMs.toFixed(2)}ms · 错误 ${metrics.errors}`
      });
    });
  }
  async function startup() {
    try {
      attachStatusBar();
    } catch (err) {
      env.log("warn", "状态栏挂载失败", err);
    }
    syncStatusBarWithRegistry();
    registry.onDidChange(() => renderRailMenus());
    setCommandActivationHook((id) => host.fireEvent("onCommand", id));
    host.add(CORE_MANIFEST);
    renderRailMenus();
    bridgeLegacyEvents();
    try {
      installSettingsSection();
    } catch (err) {
      env.log("warn", "扩展设置分区挂载失败", err);
    }
    host.onDidChange(() => {
      refreshExtensionBadge();
      document.dispatchEvent(new CustomEvent("xhgcs:extensions-changed"));
    });
    refreshExtensionBadge();
    try {
      const found = await host.discover("plugins/index.json");
      if (found.length) env.log("info", `发现 ${found.length} 个外部扩展`);
    } catch (err) {
      env.log("warn", "扫描插件目录失败", err);
    }
    try {
      const userFound = await host.discoverUserExtensions();
      if (userFound.length) env.log("info", `发现 ${userFound.length} 个用户扩展`);
    } catch (err) {
      env.log("warn", "扫描用户扩展目录失败", err);
    }
    await host.start();
    refreshExtensionBadge();
    try {
      bootstrapPipeline();
    } catch (err) {
      env.log("error", "数据引擎启动失败", err);
    }
  }
  const core = {
    version: CORE_VERSION,
    apiVersion: CORE_API_VERSION,
    host,
    registry,
    statusBar,
    config: configuration,
    storage: createStorage("core"),
    commands: {
      execute: executeCommand,
      list: listCommands
    },
    when: evaluateWhen,
    context: buildWhenContext,
    validate: validateManifest,
    engine,
    /** 看板库：AI / MCP / 外部脚本都从这一组入口读写看板，不要直接碰 localStorage */
    boards: {
      list: () => listBoards(),
      activeId: () => activeBoardId(),
      active: () => {
        const board = activeBoard();
        return {
          id: board.id,
          name: board.name,
          updatedAt: board.updatedAt,
          widgets: Array.isArray(board.doc.root.children) ? board.doc.root.children.length : 0
        };
      },
      get: (id) => getBoard(id),
      activeDoc: () => activeDoc(),
      create: (name) => createBoard(name).id,
      duplicate: (id) => duplicateBoard(id) ? activeBoardId() : "",
      rename: (id, name) => renameBoard(id, name),
      remove: (id) => deleteBoard(id),
      switchTo: (id) => Boolean(switchTo(id)),
      importDoc: (text) => importDoc(text),
      /** 增量补丁：先校验后原子应用，失败不改文档；备份槽支持一次回退 */
      applyPatch: (patch) => {
        const result = applyPatchToActive(patch);
        return {
          ok: result.ok,
          error: result.error,
          errors: result.errors,
          summary: result.summary,
          diff: result.diff,
          active: (() => {
            const board = activeBoard();
            return { id: board.id, name: board.name, widgets: Array.isArray(board.doc.root.children) ? board.doc.root.children.length : 0 };
          })()
        };
      },
      revertPatch: () => revertLastPatch(),
      /** 只校验不落库（MCP update_board 的 dry-run） */
      previewPatch: (patch) => previewPatch(patch),
      resetCache: () => resetBoardCache(),
      storageKeys: BOARD_STORAGE_KEYS
    },
    /** 纯函数暴露给自动化测试与 AI 工具，避免为了测一个表达式去起浏览器 */
    internals: {
      semver: { satisfies, parseVersion },
      when: { evaluate: evaluateWhen, validate: validateWhen }
    },
    activate: (event, arg) => host.fireEvent(event, arg),
    ui: {
      openPalette,
      openExtensions,
      openExtensionSettings,
      openPipeline: openPipelinePanel,
      openViews: openViewContainer,
      openBoard: () => {
        if (!openBoard()) env.toast("还没有看板文档：先在设计器里搭一个并保存");
      },
      /** AI/外部工具入口：把“意图规格”变成 UiDoc（不落库，先让用户看到预览） */
      composeBoard,
      /** 预览通过后真正落库并打开看板 */
      applyBoard: (spec, options) => {
        const result = composeBoard(spec);
        if (!result.ok || !result.doc) return { ok: false, error: result.error || "生成失败", warnings: result.warnings };
        try {
          replaceActive(result.doc);
        } catch (err) {
          return { ok: false, error: "写入本机失败：" + (err instanceof Error ? err.message : String(err)), warnings: result.warnings };
        }
        if (!options || options.open !== false) openBoard({ doc: activeDoc() });
        const count = result.doc.root.children ? result.doc.root.children.length : 0;
        return { ok: true, id: result.doc.id, name: result.doc.name, widgets: count, warnings: result.warnings };
      },
      openDesigner
    },
    startup
  };
  if (typeof window !== "undefined") {
    window.XHGCS_CORE = core;
    window.XHGCS_EXTENSIONS = window.XHGCS_EXTENSIONS || {};
    const boot = () => {
      startup().catch((err) => env.log("error", "内核启动失败", err));
    };
    if (document.readyState === "loading") document.addEventListener("DOMContentLoaded", boot, { once: true });
    else boot();
  }
  exports.core = core;
  exports.startup = startup;
  Object.defineProperty(exports, Symbol.toStringTag, { value: "Module" });
})(this.XHGCS_CORE_BUNDLE = this.XHGCS_CORE_BUNDLE || {});

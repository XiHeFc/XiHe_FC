/**
 * `when` 表达式求值器（贡献点的可用性条件）。
 *
 * 语法刻意做得比 JS 窄：只允许 && || ! 括号、比较运算，以及标识符/字符串/数字/布尔。
 * 绝不 eval —— 插件清单来自磁盘，清单里的一行字符串不应该拥有执行任意代码的能力。
 *
 *   view == wave
 *   resource == channel && channelTab == raw
 *   !mcp.enabled
 *   protocol in [json, ascii, hex, wed]
 */

export type WhenContext = Record<string, unknown>;

type Token =
  | { kind: 'ident'; value: string }
  | { kind: 'string'; value: string }
  | { kind: 'number'; value: number }
  | { kind: 'op'; value: string }
  | { kind: 'eof'; value: '' };

const OPERATORS = ['&&', '||', '==', '!=', '>=', '<=', '>', '<', '!', '(', ')', '[', ']', ',', 'in'];

function tokenize(source: string): Token[] {
  const tokens: Token[] = [];
  let index = 0;
  const text = String(source || '');
  while (index < text.length) {
    const char = text[index];
    if (/\s/.test(char)) {
      index += 1;
      continue;
    }
    if (char === '"' || char === "'") {
      const quote = char;
      let value = '';
      index += 1;
      while (index < text.length && text[index] !== quote) {
        if (text[index] === '\\' && index + 1 < text.length) {
          value += text[index + 1];
          index += 2;
          continue;
        }
        value += text[index];
        index += 1;
      }
      index += 1;
      tokens.push({ kind: 'string', value });
      continue;
    }
    if (/[0-9]/.test(char)) {
      let value = '';
      while (index < text.length && /[0-9.]/.test(text[index])) {
        value += text[index];
        index += 1;
      }
      tokens.push({ kind: 'number', value: Number(value) });
      continue;
    }
    if (/[A-Za-z_$]/.test(char)) {
      let value = '';
      while (index < text.length && /[A-Za-z0-9_$.\-]/.test(text[index])) {
        value += text[index];
        index += 1;
      }
      if (value === 'true' || value === 'false') {
        tokens.push({ kind: 'string', value });
      } else if (value === 'in') {
        tokens.push({ kind: 'op', value: 'in' });
      } else {
        tokens.push({ kind: 'ident', value });
      }
      continue;
    }
    const op = OPERATORS.find((candidate) => text.startsWith(candidate, index));
    if (op) {
      // '=' 单写视同 '=='，兼容手写清单
      tokens.push({ kind: 'op', value: op });
      index += op.length;
      continue;
    }
    if (char === '=') {
      tokens.push({ kind: 'op', value: '==' });
      index += 1;
      continue;
    }
    // 未知字符直接判为语法错误，交给调用方降级处理
    throw new Error(`when 表达式含非法字符 "${char}"`);
  }
  tokens.push({ kind: 'eof', value: '' });
  return tokens;
}

class Parser {
  private pos = 0;

  constructor(private readonly tokens: Token[], private readonly context: WhenContext) {}

  private peek(): Token {
    return this.tokens[this.pos];
  }

  private next(): Token {
    return this.tokens[this.pos++];
  }

  private eatOp(value: string): boolean {
    const token = this.peek();
    if (token.kind === 'op' && token.value === value) {
      this.pos += 1;
      return true;
    }
    return false;
  }

  private expectOp(value: string): void {
    if (!this.eatOp(value)) throw new Error(`when 表达式缺少 "${value}"`);
  }

  parse(): boolean {
    const value = this.parseOr();
    if (this.peek().kind !== 'eof') throw new Error('when 表达式存在多余内容');
    return truthy(value);
  }

  private parseOr(): unknown {
    let left = this.parseAnd();
    while (this.eatOp('||')) {
      const right = this.parseAnd();
      left = truthy(left) || truthy(right);
    }
    return left;
  }

  private parseAnd(): unknown {
    let left = this.parseUnary();
    while (this.eatOp('&&')) {
      const right = this.parseUnary();
      left = truthy(left) && truthy(right);
    }
    return left;
  }

  private parseUnary(): unknown {
    if (this.eatOp('!')) return !truthy(this.parseUnary());
    return this.parseComparison();
  }

  private parseComparison(): unknown {
    const left = this.parseValue();
    const token = this.peek();
    if (token.kind === 'op' && ['==', '!=', '>', '<', '>=', '<=', 'in'].includes(token.value)) {
      this.next();
      const right = this.parseValue();
      return compare(token.value, left, right);
    }
    return left;
  }

  private parseValue(literalIdent = false): unknown {
    const token = this.peek();
    if (token.kind === 'op' && token.value === '(') {
      this.next();
      const value = this.parseOr();
      this.expectOp(')');
      return value;
    }
    if (token.kind === 'op' && token.value === '[') {
      this.next();
      const items: unknown[] = [];
      // 数组字面量里的裸标识符按字符串处理：`view in [visual, wave]` 比逼用户背引号更顺手
      while (!(this.peek().kind === 'op' && this.peek().value === ']')) {
        items.push(this.parseValue(true));
        if (!this.eatOp(',')) break;
      }
      this.expectOp(']');
      return items;
    }
    if (token.kind === 'ident') {
      this.next();
      const resolved = resolve(token.value, this.context);
      return literalIdent && resolved === undefined ? token.value : resolved;
    }
    if (token.kind === 'string') {
      this.next();
      return token.value === 'true' ? true : token.value === 'false' ? false : token.value;
    }
    if (token.kind === 'number') {
      this.next();
      return token.value;
    }
    throw new Error('when 表达式缺少数值或标识符');
  }
}

function resolve(path: string, context: WhenContext): unknown {
  const trimmed = path.replace(/^context\./, '');
  if (!trimmed) return undefined;
  const segments = trimmed.split('.');
  let cursor: unknown = context;
  for (const segment of segments) {
    if (cursor == null || typeof cursor !== 'object') return undefined;
    cursor = (cursor as Record<string, unknown>)[segment];
  }
  return cursor;
}

function truthy(value: unknown): boolean {
  if (Array.isArray(value)) return value.length > 0;
  if (value == null) return false;
  if (typeof value === 'string') return value.length > 0 && value !== 'false' && value !== '0';
  return Boolean(value);
}

function compare(op: string, left: unknown, right: unknown): boolean {
  switch (op) {
    case '==':
      return looseEqual(left, right);
    case '!=':
      return !looseEqual(left, right);
    case 'in': {
      if (Array.isArray(right)) return right.some((item) => looseEqual(item, left));
      if (typeof right === 'string') return right.split(',').map((s) => s.trim()).includes(String(left));
      return false;
    }
    case '>':
      return Number(left) > Number(right);
    case '<':
      return Number(left) < Number(right);
    case '>=':
      return Number(left) >= Number(right);
    case '<=':
      return Number(left) <= Number(right);
    default:
      return false;
  }
}

function looseEqual(left: unknown, right: unknown): boolean {
  if (left === right) return true;
  if (left == null && right == null) return true;
  return String(left) === String(right);
}

/**
 * 求值。语法错误或运行错误一律返回 false —— 条件求不出来时“不可用”比“误显示”安全。
 * 但错误必须能显式取到，扩展面板要能指着某一行清单说它写错了。
 */
export function evaluateWhen(source: string | undefined | null, context: WhenContext): boolean {
  const text = String(source == null ? '' : source).trim();
  if (!text) return true;
  try {
    const parser = new Parser(tokenize(text), context);
    return parser.parse();
  } catch {
    return false;
  }
}

export interface WhenCheck {
  ok: boolean;
  error: string;
}

/** 严格求值：给清单校验器用，写错的 when 要在发现阶段就报出来。 */
export function validateWhen(source: string | undefined | null): WhenCheck {
  const text = String(source == null ? '' : source).trim();
  if (!text) return { ok: true, error: '' };
  try {
    new Parser(tokenize(text), {}).parse();
    return { ok: true, error: '' };
  } catch (err) {
    return { ok: false, error: err instanceof Error ? err.message : String(err) };
  }
}

/**
 * 本浏览器会话的协作身份 —— 一次生成、整个会话不变。
 *
 * `clientId` 用于：操作级同步的回声过滤（M4 增量2）、在场光标的身份标识。
 * `name` / `color` 用于拟人化光标的名牌与配色。多端各自随机一套，便于区分。
 */

/** 名字 + 配色预设池 —— 按 clientId 散列取一套，多端大概率不同。 */
const IDENTITIES: ReadonlyArray<{ name: string; color: string }> = [
  { name: '青松', color: '#1971c2' },
  { name: '远山', color: '#2f9e44' },
  { name: '晚枫', color: '#e8590c' },
  { name: '晴野', color: '#9c36b5' },
  { name: '溪流', color: '#0c8599' },
  { name: '沙鸥', color: '#e03131' },
  { name: '暖阳', color: '#f08c00' },
  { name: '夜航', color: '#3b5bdb' },
];

/** 字符串散列（djb2 变体）—— 把 clientId 映射到身份池下标。 */
function hashIndex(seed: string, mod: number): number {
  let h = 0;
  for (let i = 0; i < seed.length; i++) {
    h = (h * 31 + seed.charCodeAt(i)) | 0;
  }
  return Math.abs(h) % mod;
}

/**
 * 生成本会话 clientId。
 *
 * `crypto.randomUUID()` **仅安全上下文（https / localhost）可用** —— 别人用
 * `http://<局域网IP>:4511` 打开时它是 undefined，会直接抛错让整页崩。故回退：
 *  ① 有 randomUUID 就用（localhost / https 保持原行为）；
 *  ② 否则用 `crypto.getRandomValues`（非安全上下文亦可用）拼一个 UUIDv4；
 *  ③ 再兜底 `Math.random`。这样局域网明文 HTTP 分享也能正常协作。
 */
function randomClientId(): string {
  const c: Crypto | undefined = globalThis.crypto;
  if (c && typeof c.randomUUID === 'function') {
    try {
      return c.randomUUID();
    } catch {
      /* 落到下面的回退 */
    }
  }
  if (c && typeof c.getRandomValues === 'function') {
    const b = new Uint8Array(16);
    c.getRandomValues(b);
    b[6] = (b[6]! & 0x0f) | 0x40; // version 4
    b[8] = (b[8]! & 0x3f) | 0x80; // variant 10
    const h = Array.from(b, (x) => x.toString(16).padStart(2, '0'));
    return (
      `${h.slice(0, 4).join('')}-${h.slice(4, 6).join('')}-` +
      `${h.slice(6, 8).join('')}-${h.slice(8, 10).join('')}-${h.slice(10, 16).join('')}`
    );
  }
  return `c-${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 10)}`;
}

const clientId = randomClientId();
const identity = IDENTITIES[hashIndex(clientId, IDENTITIES.length)]!;

/** 本会话身份。 */
export const SESSION = {
  clientId,
  name: identity.name,
  color: identity.color,
} as const;

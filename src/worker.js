/**
 * 单词本站 · 表情墙接口
 *
 * 只处理 /api/*，其余请求原样交回静态资源（见 wrangler.jsonc 的 run_worker_first）。
 * 无任何运行期依赖，单文件。
 *
 * 设计要点（改动前先读）：
 *  1. 表情按「代号」存，不存 emoji 字符本身。这样到达前端 DOM 的每一个字节
 *     都来自前端自己的字符串字面量，安全性由结构保证，而不是靠记得转义。
 *  2. 位置在插入时随机生成并落库，之后不再变——所以刷新、旋屏都不会让表情重排。
 *  3. 读取是「版本号 + 全窗口」，不是增量游标。增量游标表达不了「删除」，
 *     而且一旦发生截断就会静默丢行。
 */

// 允许的表情代号。与 public/index.html 的 GLYPH、migrations/0001_init.sql 的
// CHECK 约束三处必须一致——前端无法 import 本文件，只能手动同步。
const KINDS = ['smile', 'grin', 'love', 'kiss', 'think', 'sad', 'cry', 'angry', 'strong', 'party'];
const KIND_SET = new Set(KINDS);

const RENDER_WINDOW = 250;      // 一次最多返回多少条。前端字号有 16px 下限，
                                // 再多就会糊成一团（320px 窄屏下 16px 约对应 289 个）。
const ROW_CAP = 50000;          // 总行数上限，防脚本刷爆
const BURST_MAX = 60;           // 全站 60 秒内最多插入多少条
const BURST_WINDOW_MS = 60000;
const MAX_BODY_BYTES = 1024;

export default {
  async fetch(request, env) {
    const url = new URL(request.url);

    // 非接口路径全部交回静态资源。
    //
    // 必须把原始 request 原样传进去，不要重建 URL：pathname 是百分号编码的，
    // 重新拼一次会二次编码（%E5 → %25E5），结果只有中文文件名 404，
    // 而 index.html 一切正常——看起来就像「加了 Worker 之后 PDF 不见了」。
    // 同理，绝不要对路径做 decodeURIComponent：格式错误的 % 会抛 URIError 变成 500。
    if (!url.pathname.startsWith('/api/')) {
      return env.ASSETS.fetch(request);
    }

    try {
      await ensureSchema(env);
    } catch (err) {
      console.error('[emoji] 建表失败（D1 绑定是否正确？）', err);
      return json(503, { error: { code: 'DB_NOT_READY' } });
    }

    // 预检不返回任何 CORS 头，等于不支持跨域。
    // 本 API 只给同源页面用，这个「不支持」本身就是一层防御。
    if (request.method === 'OPTIONS') return new Response(null, { status: 405 });
    if (request.method === 'HEAD') return new Response(null, { status: 405 });

    const parts = url.pathname.split('/').filter(Boolean);   // ['api','emojis', maybe id]
    const [root, resource, id] = parts;
    if (root !== 'api') return json(404, { error: { code: 'NOT_FOUND' } });

    try {
      if (resource === 'emojis') {
        if (request.method === 'GET') return await getState(url, env);
        if (request.method === 'POST') return await postEmoji(request, env);
        if (request.method === 'DELETE') return await handleDelete(url, id, request, env);
        return json(405, { error: { code: 'METHOD_NOT_ALLOWED' } });
      }
      if (resource === 'admin' && request.method === 'GET') {
        return requireAdmin(request, env) ? json(200, { ok: true }) : unauthorized();
      }
      return json(404, { error: { code: 'NOT_FOUND' } });
    } catch (err) {
      // 绝不把 D1 的报错原文返回给客户端——里面含 SQL 与表结构。
      console.error('[emoji] 处理请求出错', request.method, url.pathname, err);
      return json(500, { error: { code: 'INTERNAL' } });
    }
  },
};

/* ── 读取 ─────────────────────────────────────────────────────────────── */

async function getState(url, env) {
  const current = await readVersion(env);
  const since = url.searchParams.get('v');

  // 版本号相等就只回一个短响应。注意这里只比「相等」：
  // 删除也会让版本号变化，所以比大小是没有意义的。
  if (since !== null && Number(since) === current) {
    return json(200, { v: current, unchanged: true });
  }

  const total = await env.DB.prepare('SELECT COUNT(*) AS n FROM emoji').first();
  const rows = await env.DB.prepare(
    'SELECT id, kind, x, y FROM emoji ORDER BY id DESC LIMIT ?'
  ).bind(RENDER_WINDOW).all();

  // 倒序取最近 N 条，再翻回升序——这样即使窗口滑动，客户端拿到的顺序也稳定。
  const items = (rows.results || []).slice().reverse();

  return json(200, {
    v: current,
    total: total ? total.n : items.length,
    cap: RENDER_WINDOW,
    kinds: KINDS,          // 让前端能识别服务端新增的代号
    items,
  });
}

async function readVersion(env) {
  const row = await env.DB.prepare("SELECT value FROM meta WHERE key = 'v'").first();
  const n = row ? Number(row.value) : 0;
  return Number.isFinite(n) ? n : 0;
}

/* ── 写入 ─────────────────────────────────────────────────────────────── */

async function postEmoji(request, env) {
  if (!originAllowed(request)) return json(403, { error: { code: 'BAD_ORIGIN' } });

  // 要求 JSON 类型本身就是 CSRF 防御：跨域的 <form> 能发出「简单请求」，
  // 但发不出 application/json，于是被迫走预检——而预检会被我们不设 CORS 头挡掉。
  const ctype = request.headers.get('Content-Type') || '';
  if (!ctype.toLowerCase().startsWith('application/json')) {
    return json(415, { error: { code: 'EXPECTED_JSON' } });
  }

  const raw = await readBodyText(request);
  if (raw === null) return json(413, { error: { code: 'BODY_TOO_LARGE' } });

  let body;
  try { body = JSON.parse(raw); } catch { return json(400, { error: { code: 'BAD_JSON' } }); }
  if (!body || typeof body !== 'object') return json(400, { error: { code: 'BAD_JSON' } });

  // 只取这两个字段，不做展开。这样 {"kind":"smile","id":9999,"x":0,"y":0}
  // 这种夹带是被无害忽略的，而不是意外生效。
  const kind = body.kind;
  const clientId = body.client_id;

  if (typeof kind !== 'string' || !KIND_SET.has(kind)) {
    return json(400, { error: { code: 'BAD_KIND' } });
  }
  // client_id 只用于幂等去重，长度限制是防止有人拿它塞垃圾。
  if (typeof clientId !== 'string' || clientId.length < 8 || clientId.length > 64
      || !/^[A-Za-z0-9_-]+$/.test(clientId)) {
    return json(400, { error: { code: 'BAD_CLIENT_ID' } });
  }

  if (!(await underCaps(env))) return json(429, { error: { code: 'TOO_MANY' } });

  const { x, y } = await pickPosition(env);
  const ts = Date.now();

  // 幂等：同一个 client_id 再次提交不会新增行。
  // 这挡的是两种真实情况——双击，以及「请求其实成功了但响应超时」后的重试。
  const ins = await env.DB.prepare(
    `INSERT INTO emoji (kind, x, y, ts, client_id) VALUES (?, ?, ?, ?, ?)
     ON CONFLICT(client_id) DO NOTHING`
  ).bind(kind, x, y, ts, clientId).run();

  const inserted = !!(ins.meta && ins.meta.changes > 0);

  const row = await env.DB.prepare(
    'SELECT id, kind, x, y, ts FROM emoji WHERE client_id = ?'
  ).bind(clientId).first();

  if (!row) {
    // 只可能是「刚查完就被站主删了」这种极窄的竞争，让客户端重试即可。
    return json(409, { error: { code: 'RETRY' } });
  }

  if (inserted) await bumpVersion(env);

  return json(inserted ? 201 : 200, {
    item: { id: row.id, kind: row.kind, x: row.x, y: row.y },
    duplicate: !inserted,
  });
}

async function handleDelete(url, id, request, env) {
  if (!requireAdmin(request, env)) return unauthorized();
  if (!originAllowed(request)) return json(403, { error: { code: 'BAD_ORIGIN' } });

  // 一键清空：防刷恢复用。没有它，站主只能一个一个点掉几百个表情。
  if (url.searchParams.get('all') === '1') {
    const res = await env.DB.prepare('DELETE FROM emoji').run();
    await bumpVersion(env);
    return json(200, { removed: (res.meta && res.meta.changes) || 0 });
  }

  if (!id) return json(400, { error: { code: 'MISSING_ID' } });
  if (!/^\d{1,12}$/.test(id)) return json(400, { error: { code: 'BAD_ID' } });

  const res = await env.DB.prepare('DELETE FROM emoji WHERE id = ?').bind(Number(id)).run();
  const removed = (res.meta && res.meta.changes) || 0;
  if (removed === 0) return json(404, { error: { code: 'NOT_FOUND' } });

  await bumpVersion(env);
  return json(200, { removed });
}

/* ── 位置 ─────────────────────────────────────────────────────────────── */

// R2 低差异序列的两个步长（1/φ₂ 的二元推广），无理数，永不循环。
const R2_X = 0.7548776662466927;
const R2_Y = 0.5698402909980532;

/**
 * 位置在插入时算好并落库，之后不再变——所以刷新页面、旋转屏幕都不会让表情重排。
 *
 * 用 R2 低差异序列，不用纯随机。这段值得解释，因为第一版我写的是
 * 「随机挑格子 + 格内抖动」，看起来像分层，**实际和纯随机完全等价**：
 * 每个点独立随机选格，结块概率和随机撒点一模一样。实测 55 个点在 8×8 网格里
 * 占 37 格、空 27 格，与纯随机的期望值分毫不差。
 * 教训：分层要起作用，格子分配必须是**确定性的**，不能靠随机去挑。
 *
 * 换成 R2 后同样 55 个点：空格 27 → 13，最挤的格子 3.65 → 2.0 个。
 *
 * 序列按 id 推进而不是按行数：站主删掉几行后行数会重复，位置就会撞在一起；
 * AUTOINCREMENT 的 id 不会重复。
 */
async function pickPosition(env) {
  const row = await env.DB.prepare('SELECT IFNULL(MAX(id), 0) AS maxId FROM emoji').first();
  const idx = (row && row.maxId ? row.maxId : 0) + 1;

  const frac = (v) => v - Math.floor(v);
  // 抖动幅度 0.02，远小于相邻点的典型间距：只用来打散规则的数学感，
  // 不会把结块重新引进来。
  const jitter = () => (Math.random() - 0.5) * 0.02;
  // 把 [0,1) 线性铺开到 [0.04, 0.96]。用缩放而不是钳制——
  // 钳制会把 6% 的点压到边界上，在四条边上堆出一条线。
  const spread = (v) => 0.04 + v * 0.92;
  const place = (v) => Math.min(0.97, Math.max(0.03, spread(v) + jitter()));

  return { x: place(frac(idx * R2_X)), y: place(frac(idx * R2_Y)) };
}

/* ── 防刷 ─────────────────────────────────────────────────────────────── */

async function underCaps(env) {
  const total = await env.DB.prepare('SELECT COUNT(*) AS n FROM emoji').first();
  if (total && total.n >= ROW_CAP) return false;

  const recent = await env.DB.prepare(
    'SELECT COUNT(*) AS n FROM emoji WHERE ts > ?'
  ).bind(Date.now() - BURST_WINDOW_MS).first();

  return !recent || recent.n < BURST_MAX;
}

/* ── 鉴权 ─────────────────────────────────────────────────────────────── */

function requireAdmin(request, env) {
  const token = env.ADMIN_TOKEN;
  // 没配密钥就当删除功能关闭，而不是崩溃或放行。
  if (!token) {
    console.error('[emoji] 未设置 ADMIN_TOKEN，删除功能已关闭');
    return false;
  }
  const given = request.headers.get('X-Admin-Token');
  if (!given) return false;
  return timingSafeEqual(given, token);
}

function unauthorized() {
  // 「没带令牌」和「令牌错误」返回完全相同的响应，不泄露任何信息。
  return json(401, { error: { code: 'UNAUTHORIZED' } });
}

function timingSafeEqual(a, b) {
  const enc = new TextEncoder();
  const ab = enc.encode(a);
  const bb = enc.encode(b);
  let diff = ab.length ^ bb.length;
  for (let i = 0; i < ab.length; i++) diff |= ab[i] ^ bb[i % bb.length];
  return diff === 0;
}

function originAllowed(request) {
  const origin = request.headers.get('Origin');
  // 同源的非简单请求浏览器也会带 Origin，正常放行。
  // 没有 Origin 的情况（curl、部分 webview）放行——此时并无跨站风险可言。
  if (!origin) return true;
  try { return new URL(origin).host === new URL(request.url).host; } catch { return false; }
}

/* ── 杂项 ─────────────────────────────────────────────────────────────── */

async function readBodyText(request) {
  const declared = Number(request.headers.get('Content-Length') || 0);
  if (declared > MAX_BODY_BYTES) return null;
  const text = await request.text();
  if (text.length > MAX_BODY_BYTES) return null;
  return text;
}

async function bumpVersion(env) {
  await env.DB.prepare(
    "UPDATE meta SET value = CAST(CAST(value AS INTEGER) + 1 AS TEXT) WHERE key = 'v'"
  ).run();
}

function json(status, data) {
  return new Response(JSON.stringify(data), {
    status,
    headers: {
      'Content-Type': 'application/json; charset=utf-8',
      'Cache-Control': 'no-store',
      // 故意不设 Access-Control-Allow-Origin：本 API 只服务同源页面。
    },
  });
}

/* ── 建表 ─────────────────────────────────────────────────────────────── */

let schemaReady = null;

/**
 * 建表 + 建索引。每个 isolate 只跑一次。
 *
 * 正常情况下它一次都不该真正执行——表应该由 migrations/0001_init.sql 建好。
 * 留着它是为了防止「用户忘了执行迁移」导致整个功能静默不可用。
 * 所以真执行了就要大声记日志。
 */
function ensureSchema(env) {
  if (!schemaReady) {
    schemaReady = migrate(env).catch((err) => {
      schemaReady = null;      // 允许下次请求重试
      throw err;
    });
  }
  return schemaReady;
}

async function migrate(env) {
  console.warn('[emoji] 正在执行建表。正常情况不该发生——请确认已对线上 D1 执行过 migrations/0001_init.sql');
  await env.DB.batch([
    env.DB.prepare(`CREATE TABLE IF NOT EXISTS emoji (
      id        INTEGER PRIMARY KEY AUTOINCREMENT,
      kind      TEXT    NOT NULL CHECK (kind IN (
                  'smile','grin','love','kiss','think',
                  'sad','cry','angry','strong','party')),
      x         REAL    NOT NULL CHECK (x >= 0 AND x <= 1),
      y         REAL    NOT NULL CHECK (y >= 0 AND y <= 1),
      ts        INTEGER NOT NULL,
      client_id TEXT    NOT NULL
    )`),
    env.DB.prepare('CREATE UNIQUE INDEX IF NOT EXISTS emoji_client ON emoji(client_id)'),
    env.DB.prepare('CREATE INDEX IF NOT EXISTS emoji_ts ON emoji(ts)'),
    env.DB.prepare('CREATE TABLE IF NOT EXISTS meta (key TEXT PRIMARY KEY, value TEXT NOT NULL)'),
    env.DB.prepare("INSERT OR IGNORE INTO meta(key, value) VALUES ('v', '0')"),
  ]);
}

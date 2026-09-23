/**
 * 表情墙接口 + 静态资源回归测试。
 *
 * 用法：先 `npx wrangler dev --port 8787`，再 `node tools/test-api.mjs`。
 * 只打本地服务，绝不碰线上。
 */

import { readFileSync } from 'node:fs';

const BASE = process.env.BASE || 'http://127.0.0.1:8787';

/**
 * 没有环境变量时自己读 .dev.vars。
 *
 * 为什么要自己读、而不是让调用方在 shell 里取：两边必须对**同一套**解析规则
 * 达成一致，而这里有个真的坑——.dev.vars 的值允许加引号：
 *
 *     ADMIN_TOKEN="abc123"
 *
 * wrangler 会把引号剥掉，而 shell 的 `cut -d= -f2-` 会把引号一起带走。
 * 结果就是令牌看起来完全正确，请求却一直 401，让人往 Worker 的鉴权代码里查。
 * （实测踩到过，花了十几分钟。）
 *
 * 只处理最外层成对的引号，不做转义——令牌是随机串，够用了。
 */
function readDevVars() {
  try {
    const txt = readFileSync(new URL('../.dev.vars', import.meta.url), 'utf8');
    const vars = {};
    for (const line of txt.split(/\r?\n/)) {
      if (/^\s*#/.test(line)) continue;
      const m = /^\s*([A-Za-z_][A-Za-z0-9_]*)\s*=\s*(.*)$/.exec(line);
      if (!m) continue;
      let v = m[2].trim();
      const q = v[0];
      if ((q === '"' || q === "'") && v.endsWith(q)) v = v.slice(1, -1);
      vars[m[1]] = v;
    }
    return vars;
  } catch {
    return {};
  }
}

const TOKEN = process.env.TOKEN || process.env.ADMIN_TOKEN || readDevVars().ADMIN_TOKEN || '';

let pass = 0, fail = 0;
const failures = [];

function check(name, cond, detail) {
  if (cond) { pass++; console.log(`  ✓ ${name}`); }
  else {
    fail++; failures.push(name);
    console.log(`  ✗ ${name}${detail ? '  → ' + detail : ''}`);
  }
}

function section(t) { console.log(`\n── ${t} ──`); }

async function req(path, init = {}) {
  const res = await fetch(BASE + path, init);
  const text = await res.text();
  let json = null;
  const ct = res.headers.get('content-type') || '';
  if (ct.includes('json')) { try { json = JSON.parse(text); } catch {} }
  return { res, text, json, ct, status: res.status };
}

const uid = () => 'c' + Math.random().toString(36).slice(2) + Date.now().toString(36);
const post = (body, headers = {}) => req('/api/emojis', {
  method: 'POST',
  headers: { 'Content-Type': 'application/json', ...headers },
  body: typeof body === 'string' ? body : JSON.stringify(body),
});

// 开场先把墙清空。本地 D1 是持久化的，上一次跑测试留下的行会破坏
// 「空库」这类前提，于是失败项看起来像是代码坏了——其实只是测试不幂等。
{
  if (!TOKEN) {
    console.error('找不到管理令牌：既没有 TOKEN 环境变量，也没能从 .dev.vars 里读到 ADMIN_TOKEN。');
    console.error('先建一个 .dev.vars，里面写一行 ADMIN_TOKEN=随便一串字符（要和 wrangler dev 读到的是同一个文件）。');
    process.exit(2);
  }
  const r = await req('/api/emojis?all=1', {
    method: 'DELETE', headers: { 'X-Admin-Token': TOKEN, Origin: BASE },
  });
  if (r.status !== 200) {
    console.error(`开场清空失败（${r.status}）。`);
    if (r.status === 401) {
      console.error('令牌对不上。最可能的原因：wrangler dev 是在你改 .dev.vars **之前**启动的，');
      console.error('它内存里还是旧的令牌。重启 wrangler dev 再试。');
      console.error('（另一个可能：有多个 wrangler 实例堆在同一个端口上，见 README 本地预览一节。）');
    } else {
      console.error('检查 wrangler dev 是否在 8787 上正常运行。');
    }
    process.exit(2);
  }
  console.log(`（开场清空：移除 ${r.json.removed} 行）`);
}

/* ── 1. 静态资源回归 ──────────────────────────────────────────────────
   加 Worker 最容易悄悄弄坏的就是这里：它只影响中文文件名，
   表现是「PDF 不见了」而首页完全正常，很容易往错的方向查。 */

section('1. 静态资源回归');

{
  const r = await req('/');
  check('GET / → 200', r.status === 200, `实际 ${r.status}`);
  check('GET / 仍是 no-cache', /no-cache/.test(r.res.headers.get('cache-control') || ''),
    r.res.headers.get('cache-control'));
  check('GET / 仍返回 HTML 首页', /<title>单词本<\/title>/.test(r.text));

  const r2 = await req('/index.html');
  check('GET /index.html → 200 且 no-cache', r2.status === 200 && /no-cache/.test(r2.res.headers.get('cache-control') || ''));
}

{
  const r = await req('/vendor/pdf.min.js');
  check('GET /vendor/pdf.min.js → 200', r.status === 200, `实际 ${r.status}`);
  check('vendor 仍是长期强缓存 immutable',
    /immutable/.test(r.res.headers.get('cache-control') || ''),
    r.res.headers.get('cache-control'));
}

{
  // 中文路径必须原样编码后请求。若 Worker 里重建了 URL，这里会 404。
  const pdfPath = '/' + encodeURIComponent('单词本.pdf');
  const r = await req(pdfPath);
  check('中文 PDF 路径 → 200（原始 Request 透传成功）', r.status === 200, `实际 ${r.status} 于 ${pdfPath}`);
  check('中文 PDF 仍是 no-cache', /no-cache/.test(r.res.headers.get('cache-control') || ''),
    r.res.headers.get('cache-control'));
  check('中文 PDF 大小与磁盘一致 (107170)', r.res.headers.get('content-length') === '107170',
    r.res.headers.get('content-length'));

  // 注意：Last-Modified 在本机测不了。
  // wrangler 的本地资源服务器对任何文件都只发 ETag，从不发 Last-Modified
  // （已用不匹配任何 _headers 规则的文件验证过，与 Worker 无关）。
  // 线上由 Cloudflare 边缘从资源元数据里发出，所以页面顶部「更新于 X」
  // 这一条只能在推送后到手机上验收。
  // 本地能测的是「HEAD 请求确实到达了资源层并原样返回」，这已经覆盖了
  // 「Worker 把 HEAD 吞掉」这一类回归。
  const h = await fetch(BASE + pdfPath, { method: 'HEAD' });
  check('HEAD 中文 PDF 到达资源层并返回 200',
    h.status === 200, `${h.status}`);
  check('HEAD 中文 PDF 带 ETag（资源层正常）', !!h.headers.get('etag'),
    h.headers.get('etag'));

  const docx = await req('/' + encodeURIComponent('单词本.docx'));
  check('中文 Word 路径 → 200', docx.status === 200, `实际 ${docx.status}`);
}

{
  const r = await req('/不存在的页面');
  check('不存在的路径返回真 404（未被回退成首页）', r.status === 404, `实际 ${r.status}`);
}

/* ── 2. 基本读写 ────────────────────────────────────────────────────── */

section('2. 基本读写');

let v0;
{
  const r = await req('/api/emojis');
  check('空库 GET → 200', r.status === 200, `实际 ${r.status}`);
  check('空库 items 为空数组', Array.isArray(r.json?.items) && r.json.items.length === 0);
  check('响应带版本号 v', typeof r.json?.v === 'number');
  check('响应带 kinds 白名单', Array.isArray(r.json?.kinds) && r.json.kinds.length === 10);
  check('接口不被缓存 (no-store)', /no-store/.test(r.res.headers.get('cache-control') || ''));
  check('接口不发送 CORS 头', !r.res.headers.get('access-control-allow-origin'));
  v0 = r.json.v;
}

let firstId, firstClient;
{
  firstClient = uid();
  const r = await post({ kind: 'smile', client_id: firstClient });
  check('POST → 201', r.status === 201, `实际 ${r.status} ${r.text}`);
  check('返回新行含 id/kind/x/y', r.json?.item?.id > 0 && r.json.item.kind === 'smile'
    && typeof r.json.item.x === 'number' && typeof r.json.item.y === 'number');
  check('坐标落在 0~1 内', r.json.item.x >= 0 && r.json.item.x <= 1
    && r.json.item.y >= 0 && r.json.item.y <= 1);
  firstId = r.json.item.id;

  const g = await req('/api/emojis');
  check('POST 后 GET 能看到', g.json.items.length === 1 && g.json.items[0].id === firstId);
  check('POST 让版本号前进', g.json.v !== v0, `${v0} → ${g.json.v}`);
}

/* ── 3. 幂等 ────────────────────────────────────────────────────────── */

section('3. 幂等（同一 client_id）');

{
  const r = await post({ kind: 'love', client_id: firstClient });
  check('重复 POST → 200 而非 201', r.status === 200, `实际 ${r.status}`);
  check('重复 POST 返回同一个 id', r.json?.item?.id === firstId, `${r.json?.item?.id} vs ${firstId}`);
  check('重复 POST 标记 duplicate', r.json?.duplicate === true);
  check('重复 POST 不改 kind（原行未被覆盖）', r.json?.item?.kind === 'smile', r.json?.item?.kind);

  const g = await req('/api/emojis');
  check('总数仍为 1（没有新增行）', g.json.items.length === 1 && g.json.total === 1, `total=${g.json.total}`);
}

/* ── 4. 输入校验 ────────────────────────────────────────────────────── */

section('4. 输入校验');

{
  const cases = [
    ['非法 kind → 400', { kind: 'nope', client_id: uid() }, 400],
    ['缺 kind → 400', { client_id: uid() }, 400],
    ['原始 emoji 字符当 kind → 400', { kind: '😊', client_id: uid() }, 400],
    ['kind 非字符串 → 400', { kind: 123, client_id: uid() }, 400],
    ['client_id 太短 → 400', { kind: 'smile', client_id: 'abc' }, 400],
    ['client_id 含非法字符 → 400', { kind: 'smile', client_id: 'abc<script>x</script>' }, 400],
    ['缺 client_id → 400', { kind: 'smile' }, 400],
  ];
  for (const [name, body, want] of cases) {
    const r = await post(body);
    check(name, r.status === want, `实际 ${r.status}`);
  }
}

{
  const r = await post('{ 这不是 json');
  check('坏 JSON → 400', r.status === 400, `实际 ${r.status}`);

  const r2 = await post('null');
  check('body 为 null → 400', r2.status === 400, `实际 ${r2.status}`);
}

{
  // 批量赋值：body 里夹带的 id / x / y 必须被忽略，不能生效
  const cid = uid();
  const r = await post({ kind: 'party', client_id: cid, id: 999999, x: 0, y: 0, ts: 0 });
  check('夹带 id/x/y/ts 的 body 被忽略 → 201', r.status === 201, `实际 ${r.status}`);
  check('夹带的 id 未生效', r.json?.item?.id !== 999999 && r.json.item.id > 0, String(r.json?.item?.id));
  const placed = r.json.item.x !== 0 || r.json.item.y !== 0;
  check('夹带的坐标未生效（服务端自己算位置）', placed, `x=${r.json.item.x} y=${r.json.item.y}`);
}

{
  const big = JSON.stringify({ kind: 'smile', client_id: uid(), pad: 'x'.repeat(4000) });
  const r = await post(big);
  check('超大 body → 413', r.status === 413, `实际 ${r.status}`);
}

{
  const r = await req('/api/emojis', {
    method: 'POST',
    headers: { 'Content-Type': 'text/plain' },
    body: JSON.stringify({ kind: 'smile', client_id: uid() }),
  });
  check('非 JSON Content-Type → 415（CSRF 防线）', r.status === 415, `实际 ${r.status}`);

  const r2 = await req('/api/emojis', {
    method: 'POST', body: new URLSearchParams({ kind: 'smile', client_id: uid() }),
  });
  check('表单编码（跨站可发的简单请求）→ 415', r2.status === 415, `实际 ${r2.status}`);
}

{
  const r = await post({ kind: 'smile', client_id: uid() }, { Origin: 'https://evil.example' });
  check('跨域 Origin → 403', r.status === 403, `实际 ${r.status}`);

  const ok = await post({ kind: 'smile', client_id: uid() }, { Origin: BASE });
  check('同源 Origin 正常放行', ok.status === 201, `实际 ${ok.status}`);
}

{
  const r = await req('/api/emojis', { method: 'PUT' });
  check('不支持的方法 → 405', r.status === 405, `实际 ${r.status}`);
  const o = await req('/api/emojis', { method: 'OPTIONS', headers: { Origin: BASE } });
  check('OPTIONS 预检 → 405 且无 CORS 头', o.status === 405
    && !o.res.headers.get('access-control-allow-origin'), `实际 ${o.status}`);
  const nf = await req('/api/nope');
  check('未知接口 → 404', nf.status === 404, `实际 ${nf.status}`);
}

/* ── 5. 版本号语义 ──────────────────────────────────────────────────── */

section('5. 版本号');

let vNow;
{
  const g = await req('/api/emojis');
  vNow = g.json.v;

  const same = await req(`/api/emojis?v=${vNow}`);
  check('?v=当前值 → unchanged', same.status === 200 && same.json?.unchanged === true,
    JSON.stringify(same.json));
  check('unchanged 响应体很小（< 100 字节）', same.text.length < 100, `${same.text.length} 字节`);
  check('unchanged 不带 items', same.json.items === undefined);

  const stale = await req('/api/emojis?v=0');
  check('?v=过期值 → 返回完整列表', stale.json?.unchanged === undefined && Array.isArray(stale.json.items));
}

/* ── 6. 删除鉴权 ────────────────────────────────────────────────────── */

section('6. 删除与鉴权');

{
  const noTok = await req(`/api/emojis/${firstId}`, { method: 'DELETE' });
  const badTok = await req(`/api/emojis/${firstId}`, {
    method: 'DELETE', headers: { 'X-Admin-Token': 'wrong-token-aaaaaaaa' },
  });
  check('无令牌 DELETE → 401', noTok.status === 401, `实际 ${noTok.status}`);
  check('错令牌 DELETE → 401', badTok.status === 401, `实际 ${badTok.status}`);
  check('「无令牌」与「错令牌」响应完全一致（不泄露信息）',
    noTok.status === badTok.status && noTok.text === badTok.text);

  const g = await req('/api/emojis');
  check('401 之后数据没被删掉', g.json.items.some((i) => i.id === firstId));
}

{
  const r = await req('/api/admin', { headers: { 'X-Admin-Token': 'wrong' } });
  check('错令牌 GET /api/admin → 401', r.status === 401, `实际 ${r.status}`);
  const ok = await req('/api/admin', { headers: { 'X-Admin-Token': TOKEN } });
  check('正确令牌 GET /api/admin → 200', ok.status === 200, `实际 ${ok.status} ${ok.text}`);
}

{
  const before = (await req('/api/emojis')).json;
  const d = await req(`/api/emojis/${firstId}`, {
    method: 'DELETE', headers: { 'X-Admin-Token': TOKEN, Origin: BASE },
  });
  check('正确令牌 DELETE → 200', d.status === 200, `实际 ${d.status} ${d.text}`);

  const after = (await req('/api/emojis')).json;
  check('删除后该行消失', !after.items.some((i) => i.id === firstId));
  check('删除让版本号变化（删除能传播给其他客户端）', after.v !== before.v, `${before.v} → ${after.v}`);

  const d2 = await req(`/api/emojis/${firstId}`, {
    method: 'DELETE', headers: { 'X-Admin-Token': TOKEN, Origin: BASE },
  });
  check('重复删除同一 id → 404', d2.status === 404, `实际 ${d2.status}`);
}

{
  const d = await req('/api/emojis/abc', { method: 'DELETE', headers: { 'X-Admin-Token': TOKEN } });
  check('非数字 id → 400', d.status === 400, `实际 ${d.status}`);
  const d2 = await req('/api/emojis/999999', { method: 'DELETE', headers: { 'X-Admin-Token': TOKEN } });
  check('不存在的 id → 404', d2.status === 404, `实际 ${d2.status}`);
}

/* ── 7. 并发 ────────────────────────────────────────────────────────── */

section('7. 并发');

{
  const ids = Array.from({ length: 20 }, () => uid());
  const rs = await Promise.all(ids.map((c) => post({ kind: 'grin', client_id: c })));
  check('20 个并发不同 client_id 全部 201', rs.every((r) => r.status === 201),
    rs.map((r) => r.status).join(','));
  const got = rs.map((r) => r.json?.item?.id);
  check('20 个并发拿到 20 个互不相同的 id', new Set(got).size === 20, `去重后 ${new Set(got).size}`);
}

{
  const cid = uid();
  const rs = await Promise.all(Array.from({ length: 20 }, () => post({ kind: 'cry', client_id: cid })));
  const statuses = rs.map((r) => r.status);
  const ids = new Set(rs.map((r) => r.json?.item?.id));
  check('20 个并发同一 client_id → 恰好 1 个 201', statuses.filter((s) => s === 201).length === 1,
    statuses.join(','));
  check('20 个并发同一 client_id → 全部指向同一个 id', ids.size === 1, `去重后 ${ids.size}`);
}

/* ── 8. 清空 ────────────────────────────────────────────────────────── */

section('8. 一键清空');

{
  const before = (await req('/api/emojis')).json;
  check('清空前有若干行', before.total > 0, `total=${before.total}`);

  const noTok = await req('/api/emojis?all=1', { method: 'DELETE' });
  check('无令牌清空 → 401', noTok.status === 401, `实际 ${noTok.status}`);
  const still = await req('/api/emojis');
  check('401 之后数据还在', still.json.total === before.total);

  const d = await req('/api/emojis?all=1', {
    method: 'DELETE', headers: { 'X-Admin-Token': TOKEN, Origin: BASE },
  });
  check('正确令牌清空 → 200', d.status === 200, `实际 ${d.status}`);
  check('清空返回删除条数', d.json?.removed === before.total, `${d.json?.removed} vs ${before.total}`);

  const after = await req('/api/emojis');
  check('清空后库为空', after.json.total === 0 && after.json.items.length === 0);
  check('清空也让版本号变化', after.json.v !== before.v);

  // 清空后 client_id 唯一索引应已释放，同一个 id 能再次留表情
  const reuse = await post({ kind: 'strong', client_id: firstClient });
  check('清空后同一 client_id 可再次留表情 → 201', reuse.status === 201, `实际 ${reuse.status}`);
}

/* ── 汇总 ──────────────────────────────────────────────────────────── */

console.log(`\n${'═'.repeat(52)}`);
console.log(`通过 ${pass}  失败 ${fail}`);
if (fail) {
  console.log('\n失败项：');
  for (const f of failures) console.log('  · ' + f);
}
process.exit(fail ? 1 : 0);

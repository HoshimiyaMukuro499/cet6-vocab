-- 表情墙的表结构（权威版本）。
-- src/worker.js 里的 ensureSchema() 与本文必须保持一致，改一处就要改另一处。

-- 表情按「代号」存，不存 emoji 字符本身。
-- 这样流向前端 DOM 的每一个字节都来自前端自己的字符串字面量，
-- 安全性由结构保证，而不是依赖「以后每处渲染都记得转义」。
-- 代号表见 src/worker.js 的 KINDS 与 public/index.html 的 GLYPH，三处必须一致
-- （前端无法 import 服务端代码，所以只能手动同步；任何一处加了代号，另两处也要加）。
CREATE TABLE IF NOT EXISTS emoji (
  id        INTEGER PRIMARY KEY AUTOINCREMENT,
  kind      TEXT    NOT NULL CHECK (kind IN (
                      'smile','grin','love','kiss','think',
                      'sad','cry','angry','strong','party')),
  -- 0~1 的相对坐标。落库后不再变，所以刷新页面、旋转屏幕都不会让表情重排。
  x         REAL    NOT NULL CHECK (x >= 0 AND x <= 1),
  y         REAL    NOT NULL CHECK (y >= 0 AND y <= 1),
  ts        INTEGER NOT NULL,
  -- 每次「浏览」生成一个随机值，用于幂等：同一 client_id 只会落一行。
  -- 它是随机的、跨次浏览不相关的，不存任何可识别信息——
  -- 别把它当成设备指纹，它不是。
  client_id TEXT    NOT NULL
);

-- AUTOINCREMENT 是承重的，不要删。
-- 普通 INTEGER PRIMARY KEY 会复用 id：删掉最大那行后，下一行插入会拿回同一个 id。
-- 站主删除会走到这条路径，而客户端是靠 id 来对齐窗口的——复用会让它静默丢行。
-- （这个关键字不写也能建表，所以很容易被后来的人当成冗余「清理」掉。）

-- 幂等插入的前提：缺了它，INSERT ... ON CONFLICT(client_id) 会直接报错。
CREATE UNIQUE INDEX IF NOT EXISTS emoji_client ON emoji(client_id);

-- 供防刷的「最近 60 秒插入了多少条」查询用。
CREATE INDEX IF NOT EXISTS emoji_ts ON emoji(ts);

-- 版本号。任何一次写入都 +1。
-- 客户端只比较它是否「相等」，不比较大小——删除同样会让它变化，
-- 所以「变大了」并不代表「内容变多了」，比大小没有意义。
CREATE TABLE IF NOT EXISTS meta (key TEXT PRIMARY KEY, value TEXT NOT NULL);
INSERT OR IGNORE INTO meta(key, value) VALUES ('v', '0');

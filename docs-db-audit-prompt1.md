# Prompt 1 — Auditoria de Queries e Conexões (telegram-auth-bot)

## 1) Busca por Prisma no código
- Resultado da varredura por `prisma.`, `findMany`, `findFirst`, `findUnique`, `create`, `update`, `delete`, `upsert`, `count`, `aggregate`, `groupBy`, `$queryRaw`, `$executeRaw`: **nenhuma query Prisma encontrada**.
- O projeto usa `pg` (`Pool`) com SQL manual em `web/database.js`.

## 2) Mapeamento de TODAS as queries SQL (arquivo/linha/modelo/operação/filtro)

> Convenção de “Modelo”: tabela principal da query.

### Startup / migração leve (`ensureSchema`)
- `web/database.js:106` — `SELECT 1` (health), modelo: n/a, **sem WHERE**.
- `web/database.js:124` — `ALTER TABLE channels ADD COLUMN...`, modelo: `channels`, DDL.
- `web/database.js:129` — `ALTER TABLE channels ADD COLUMN...`, modelo: `channels`, DDL.
- `web/database.js:134` — `ALTER TABLE subscribers ADD COLUMN...`, modelo: `subscribers`, DDL.
- `web/database.js:139` — `ALTER TABLE subscribers ALTER COLUMN...`, modelo: `subscribers`, DDL.
- `web/database.js:144` — `UPDATE subscribers SET origin... WHERE origin IS NULL`, modelo: `subscribers`, **com WHERE**.
- `web/database.js:150` — `ALTER TABLE subscribers ALTER COLUMN plan TYPE...`, modelo: `subscribers`, DDL.
- `web/database.js:155` — `CREATE TABLE IF NOT EXISTS user_invite_links`, DDL.
- `web/database.js:167` — `CREATE INDEX idx_user_invite_links_telegram`, DDL.
- `web/database.js:172` — `CREATE INDEX idx_users_email_lower`, DDL.
- `web/database.js:205` — `SELECT 1 FROM channels WHERE (...) LIMIT 1`, modelo: `channels`, **com WHERE**.
- `web/database.js:214` — `SELECT COALESCE(MAX(order_index)) FROM channels WHERE plan=$1`, modelo: `channels`, **com WHERE**.
- `web/database.js:226` — `INSERT INTO channels(...)`, modelo: `channels`, INSERT.

### Admin users
- `web/database.js:301` — `SELECT ... FROM admin_users WHERE username=$1`, **com WHERE**.
- `web/database.js:318` — `SELECT ... FROM admin_users ORDER BY username LIMIT 200`, **sem WHERE**.
- `web/database.js:336` — `INSERT INTO admin_users(...)`, INSERT.
- `web/database.js:353` — `UPDATE admin_users ... WHERE id=$2`, **com WHERE**.
- `web/database.js:378` — `UPDATE admin_users SET last_login... WHERE id=$1`, **com WHERE**.
- `web/database.js:395` — `DELETE FROM admin_users WHERE id=$1`, **com WHERE**.
- `web/database.js:406` — `SELECT COUNT(*) FROM admin_users`, **sem WHERE**.

### Subscribers / autorização / convites
- `web/database.js:423` — `SELECT ... FROM subscribers WHERE email=$1 AND status='active'`, **com WHERE**.
- `web/database.js:452` — `SELECT u.*, s... FROM authorized_users u LEFT JOIN subscribers s ... WHERE u.telegram_id=$1`, **com WHERE**.
- `web/database.js:476` — `SELECT id FROM authorized_users WHERE telegram_id=$1`, **com WHERE**.
- `web/database.js:483` — `UPDATE authorized_users ... WHERE telegram_id=$2`, **com WHERE**.
- `web/database.js:491` — `INSERT INTO authorized_users(...)`, INSERT.
- `web/database.js:500` — `INSERT INTO authorization_logs(...)`, INSERT.
- `web/database.js:525` — `SELECT ... FROM channels WHERE (plan='all' OR plan=ANY($1)) AND active=true ORDER BY ...`, **com WHERE**.
- `web/database.js:545` — `INSERT INTO user_invite_links(...)`, INSERT.
- `web/database.js:559` — `SELECT ... FROM user_invite_links JOIN channels ... WHERE telegram_id=$1 AND revoked_at IS NULL ORDER BY ...`, **com WHERE**.
- `web/database.js:586` — `UPDATE user_invite_links SET revoked_at=NOW() WHERE id IN (...)`, **com WHERE**.
- `web/database.js:601` — `UPDATE user_invite_links SET revoked_at=NOW() WHERE telegram_id=$1 AND revoked_at IS NULL`, **com WHERE**.
- `web/database.js:625` — `SELECT s.plan FROM authorized_users JOIN subscribers ... WHERE au.telegram_id=$1`, **com WHERE**.
- `web/database.js:738` — `SELECT au.subscriber_id, s.plan FROM authorized_users ... WHERE au.telegram_id=$1`, **com WHERE**.
- `web/database.js:751` — `UPDATE authorized_users SET authorized=false WHERE telegram_id=$1`, **com WHERE**.
- `web/database.js:756` — `INSERT INTO authorization_logs(...)`, INSERT.
- `web/database.js:775` — `SELECT COUNT(*) FROM authorized_users WHERE authorized=true`, **com WHERE**.
- `web/database.js:780` — `SELECT COUNT(*) FROM subscribers WHERE status='active'`, **com WHERE**.
- `web/database.js:785` — `SELECT s.plan, COUNT(*) ... GROUP BY s.plan`, **com WHERE** em `u.authorized=true`.
- `web/database.js:831` — `INSERT INTO subscribers ... ON CONFLICT(email) DO UPDATE ... RETURNING ...`, UPSERT.
- `web/database.js:865` — CTE + `INSERT INTO authorization_logs ... SELECT ... FROM subscriber_telegram`, grava log de webhook.
- `web/database.js:895` — `SELECT ... FROM subscribers WHERE email=$1`, **com WHERE**.
- `web/database.js:918` — `SELECT ... FROM subscribers WHERE email = ANY(...)`, **com WHERE**.
- `web/database.js:946` — `SELECT ... FROM subscribers WHERE email=$1`, **com WHERE**.
- `web/database.js:960` — `SELECT telegram_id FROM authorized_users WHERE subscriber_id=$1`, **com WHERE**.
- `web/database.js:987` — `UPDATE subscribers ... WHERE id=$3`, **com WHERE**.
- `web/database.js:998` — `UPDATE subscribers SET status='inactive' ... WHERE id=$1`, **com WHERE**.
- `web/database.js:1048` — `SELECT * FROM authorized_users WHERE subscriber_id=$1`, **com WHERE**.
- `web/database.js:1068` — `SELECT au.telegram_id, s.plan ... WHERE au.subscriber_id=$1`, **com WHERE**.
- `web/database.js:1085` — `INSERT INTO authorization_logs(...)`, INSERT.
- `web/database.js:1092` — `DELETE FROM authorized_users WHERE subscriber_id=$1`, **com WHERE**.
- `web/database.js:1098` — `DELETE FROM subscribers WHERE id=$1`, **com WHERE**.
- `web/database.js:1117` — `SELECT DISTINCT au.telegram_id ... LEFT JOIN subscribers ... LIMIT $1`, **sem WHERE**.
- `web/database.js:1145` — `SELECT s.*, au... FROM subscribers s LEFT JOIN authorized_users ... [WHERE search opcional] ORDER BY ... LIMIT/OFFSET`.
- `web/database.js:1168` — `SELECT * FROM subscribers WHERE id=$1`, **com WHERE**.
- `web/database.js:1192` — `SELECT id, plan FROM subscribers WHERE email=$1 LIMIT 1`, **com WHERE**.
- `web/database.js:1206` — `UPDATE subscribers ... WHERE id=$5 RETURNING *`, **com WHERE**.
- `web/database.js:1221` — `INSERT INTO subscribers(...) RETURNING *`, INSERT.
- `web/database.js:1255` — `SELECT status, plan FROM subscribers WHERE id=$1`, **com WHERE**.
- `web/database.js:1261` — `UPDATE subscribers ... WHERE id=$6`, **com WHERE**.
- `web/database.js:1272` — `SELECT telegram_id FROM authorized_users WHERE subscriber_id=$1`, **com WHERE**.
- `web/database.js:1284` — `SELECT au.telegram_id, s.plan ... WHERE au.subscriber_id=$1`, **com WHERE**.
- `web/database.js:1301` — `UPDATE authorized_users SET authorized=false WHERE subscriber_id=$1`, **com WHERE**.
- `web/database.js:1307` — `INSERT INTO authorization_logs(...)`, INSERT.
- `web/database.js:1322` — `UPDATE authorized_users SET authorized=true WHERE subscriber_id=$1`, **com WHERE**.
- `web/database.js:1343` — `SELECT * FROM channels ORDER BY plan, order_index LIMIT $1`, **sem WHERE**.
- `web/database.js:1359` — `INSERT INTO channels(...) RETURNING *`, INSERT.
- `web/database.js:1376` — `UPDATE channels ... WHERE id=$8`, **com WHERE**.
- `web/database.js:1392` — `DELETE FROM channels WHERE id=$1`, **com WHERE**.
- `web/database.js:1403` — `SELECT l.*, s.name, s.email FROM authorization_logs l LEFT JOIN subscribers s ... ORDER BY timestamp DESC LIMIT 100`, **sem WHERE**.

### Queries diretas fora de `web/database.js`
- `bot/index.js:557` — `SELECT au.telegram_id, s.name, s.email FROM authorized_users JOIN subscribers ... WHERE s.status='inactive' AND au.authorized=true`.
- `web/admin-routes.js:1040` — query equivalente para sincronização manual de inativos.

## 3) Hot Paths (maior → menor frequência estimada)

> Estimativa baseada em: fluxo de execução, endpoints públicos, polling do Telegram e rate limiters configurados.

1. **Webhook Hotmart** (`POST /api/hotmart/webhook`, `processHotmartEvent`)
   - Frequência estimada: até **60/min por IP** (rate limiter).
   - Ativação: ~**3 queries** por evento (getSubscriberByEmail + upsert + logWebhookAuthorization).
   - Desativação: **4+ queries** por evento (SELECT subscriber + SELECT authorized users + UPDATE subscriber + log; pode crescer com `revokeAuthorization/revokeTelegramAccess`).

2. **Fluxo de verificação `/api/verify`**
   - Frequência estimada: dependente do tráfego de login no bot/web.
   - ~**2 queries diretas** (buscar assinante por email/telefone + authorizeUser [3-4 statements transacionais]).
   - Depois dispara `notifyUserAuthorized`, que executa convites e mais queries (ver abaixo).

3. **Comando `/meuscanais` e pós-verificação (`notifyUserAuthorized`)**
   - Frequência estimada: alta em horário de pico do bot.
   - Por execução: `getUserByTelegramId` (cache miss), `getAllChannels` (cache miss), `getActiveInviteLinksByTelegramId` + `markInviteLinksRevoked` (se houver), e `saveUserInviteLink` para cada canal elegível.
   - Custo típico: **3 + N** queries, onde N = nº de canais do plano.

4. **Admin dashboard `/api/admin/dashboard`**
   - Por requisição: chama em paralelo `getStats` (3 queries) + `getAllSubscribers` (1) + `getAllChannels` (1) + `getAuthorizationLogs` (1) = **6 queries**.

5. **Sincronização de inativos (`/sync` no bot e `/api/admin/sync`)**
   - 1 query inicial para listar inativos + para cada usuário `revokeAuthorization` (mínimo 3-5 queries internas, podendo escalar por convites/canais).

## 4) Queries suspeitas
- `web/database.js:1145` (`getAllSubscribers`) quando **sem search**: varre assinantes + join, só com ORDER BY/LIMIT/OFFSET (pode pressionar I/O em tabela grande).
- `web/database.js:1343` (`getAllChannels`) e `1117` (`getAllAuthorizedUsers`) são **sem WHERE**.
- `web/database.js:780` (`COUNT active subscribers`) e `775` (`COUNT authorized=true`) executadas com frequência no dashboard.
- `web/database.js:1403` (`authorization_logs` ordenado por timestamp) pode ficar caro sem índice adequado em `timestamp`.
- `web/database.js:423` (`email + status`) e `946`/`1192`/`895` (`email`) dependem de índice efetivo em `email` normalizado.
- `web/database.js:559` (`user_invite_links` por `telegram_id` + `revoked_at IS NULL` + order by `created_at`) pode se beneficiar de índice composto.

## 5) Cron / intervalos e impacto em DB
- `web/hotmart-webhook.js:168` — retry da fila de webhook a cada **30s**; cada tentativa repete fluxo de webhook (3 a 4+ queries/evento).
- `web/server.js:243` — health watch a cada **60s**, faz `SELECT 1` (`db.healthCheckQuery`).
- `web/server.js:239` — limpeza de tentativas (Map) a cada **1h**, sem DB.
- `bot/index.js:404` e `406` — intervalos de limpeza/log cache a cada **5 min**, sem DB direto.

## 6) Recomendações imediatas
1. Priorizar otimização dos caminhos públicos e frequentes: webhook Hotmart, `/api/verify`, `/meuscanais`.
2. Reduzir leituras redundantes no webhook de ativação (ex.: evitar `getSubscriberByEmail` prévio quando possível).
3. Garantir índices para filtros quentes: `authorized_users(telegram_id)`, `authorized_users(subscriber_id)`, `subscribers(email)`, `subscribers(status)`, `authorization_logs(timestamp DESC)`, `user_invite_links(telegram_id, revoked_at, created_at DESC)`.
4. Para dashboard, considerar cache curto (15–60s) de métricas agregadas (`getStats`).
5. Revisar endpoints/rotinas que listam muitas linhas sem filtro (`getAllSubscribers` sem search, `getAllAuthorizedUsers`) e manter paginação conservadora.

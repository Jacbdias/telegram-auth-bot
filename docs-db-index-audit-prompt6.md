# Prompt 6 — Verificação de Indexes no Banco (telegram-auth-bot)

## Execução das queries no banco

Para cumprir o Prompt 6, foi criado e executado o utilitário:

- `scripts/db-index-audit.js`

Ele roda exatamente as 4 consultas pedidas:
1. volume por tabela (`pg_stat_user_tables`)
2. índices existentes (`pg_indexes`)
3. queries mais lentas (`pg_stat_statements`)
4. seq scans vs index scans (`pg_stat_user_tables`)

### Resultado da execução no ambiente atual

Comando executado:

```bash
node scripts/db-index-audit.js
```

Saída:

```text
DATABASE_URL is not set. Export DATABASE_URL and rerun this script.
```

Ou seja, **não foi possível conectar ao banco neste ambiente** porque a variável `DATABASE_URL` não está disponível.

---

## Análise com base no schema versionado + queries hot do Prompt 1

Como fallback, cruzei os campos quentes do Prompt 1 com os índices definidos no repositório (`schema.sql` + bootstrap em `web/database.js`).

### Campos hot solicitados

- `authorized_users.telegram_id`
- `authorized_users.subscriber_id`
- `subscribers.email`
- `subscribers.status`
- `authorization_logs.timestamp`
- `user_invite_links.telegram_id`

### Situação inferida no código

- `authorized_users.telegram_id`: **indexado** (UNIQUE + índice explícito em `schema.sql`).
- `authorized_users.subscriber_id`: **faltando índice explícito**.
- `subscribers.email`: **indexado** (UNIQUE + índice explícito).
- `subscribers.status`: **indexado**.
- `authorization_logs.timestamp`: **indexado**.
- `user_invite_links.telegram_id`: **indexado**.

Além disso, o código usa filtros compostos em convites (`telegram_id` + `revoked_at IS NULL` + `ORDER BY created_at DESC`) que se beneficiam de índice composto.

---

## SQL proposto para índices faltantes / melhorias

> Seguro para execução incremental com `IF NOT EXISTS`.

```sql
-- 1) Campo hot sem índice explícito (crítico)
CREATE INDEX IF NOT EXISTS idx_authorized_users_subscriber_id
  ON authorized_users(subscriber_id);

-- 2) Otimiza busca de convites ativos por usuário (query hot)
CREATE INDEX IF NOT EXISTS idx_user_invite_links_active_lookup
  ON user_invite_links(telegram_id, revoked_at, created_at DESC);

-- 3) (Opcional) Ajuda dashboard/joins frequentes por autorizados ativos
CREATE INDEX IF NOT EXISTS idx_authorized_users_authorized_subscriber
  ON authorized_users(authorized, subscriber_id);

-- 4) (Opcional) Ajuda listagem de logs recentes com ORDER BY timestamp DESC
CREATE INDEX IF NOT EXISTS idx_authorization_logs_timestamp_desc
  ON authorization_logs(timestamp DESC);
```

---

## Como rodar no ambiente real (Neon)

```bash
export DATABASE_URL='postgres://...'
node scripts/db-index-audit.js
```

Se `pg_stat_statements` falhar, habilitar extensão no banco:

```sql
CREATE EXTENSION IF NOT EXISTS pg_stat_statements;
```

(ou manter a consulta como opcional, pois o script já trata falha individual dessa query).

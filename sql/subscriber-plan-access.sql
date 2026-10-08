-- Acesso até o fim do período já pago (regra 1 do Davi)
--
-- Quando a Hotmart avisa que a RENOVAÇÃO foi cancelada
-- (SUBSCRIPTION_CANCELLATION), o acesso NÃO é cortado na hora: o bot grava
-- aqui até quando aquele plano daquele assinante continua valendo, usando o
-- `date_next_charge` do payload. O job diário remove o plano quando a data
-- passa.
--
-- COMO RODAR: no banco do BOT (o DATABASE_URL do serviço do bot, NÃO o do
-- portal). É reexecutável — rodar duas vezes não causa erro nem perde dados.
--
--   psql "$DATABASE_URL" -f sql/subscriber-plan-access.sql
--
-- Enquanto este SQL não rodar, o bot funciona normalmente: o cancelamento é
-- apenas registrado no log e NINGUÉM é cortado.

CREATE TABLE IF NOT EXISTS subscriber_plan_access (
    id SERIAL PRIMARY KEY,
    subscriber_id INTEGER NOT NULL REFERENCES subscribers(id) ON DELETE CASCADE,
    plan TEXT NOT NULL,
    access_until TIMESTAMPTZ NOT NULL,
    reason VARCHAR(80),
    created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    CONSTRAINT subscriber_plan_access_subscriber_plan_key UNIQUE (subscriber_id, plan)
);

-- A chave única acima é o que o ON CONFLICT (subscriber_id, plan) do código
-- usa. Em um banco que já tenha a tabela sem a constraint, adiciona.
DO $$
BEGIN
    IF NOT EXISTS (
        SELECT 1
        FROM pg_constraint
        WHERE conname = 'subscriber_plan_access_subscriber_plan_key'
    ) THEN
        ALTER TABLE subscriber_plan_access
            ADD CONSTRAINT subscriber_plan_access_subscriber_plan_key
            UNIQUE (subscriber_id, plan);
    END IF;
END
$$;

-- O job diário varre por data.
CREATE INDEX IF NOT EXISTS idx_subscriber_plan_access_until
    ON subscriber_plan_access (access_until);

CREATE INDEX IF NOT EXISTS idx_subscriber_plan_access_subscriber
    ON subscriber_plan_access (subscriber_id);

-- Conferência rápida depois de rodar:
--
--   SELECT spa.plan, spa.access_until, spa.reason, s.email
--   FROM subscriber_plan_access spa
--   JOIN subscribers s ON s.id = spa.subscriber_id
--   ORDER BY spa.access_until;

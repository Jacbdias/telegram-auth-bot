#!/usr/bin/env node

const { Pool } = require('pg');

const isDryRun = process.argv.includes('--dry-run');

if (!process.env.DATABASE_URL) {
  console.error('DATABASE_URL não configurada.');
  process.exit(1);
}

const pool = new Pool({
  connectionString: process.env.DATABASE_URL,
  max: 5,
  idleTimeoutMillis: 30000,
  connectionTimeoutMillis: 10000,
  ssl: { rejectUnauthorized: false }
});

async function run() {
  const client = await pool.connect();

  try {
    const candidates = await client.query(
      `SELECT l.id,
              l.subscriber_id,
              l.telegram_id AS old_telegram_id,
              COALESCE(NULLIF(TRIM(au.telegram_id), ''), 'PENDENTE') AS new_telegram_id
       FROM authorization_logs l
       JOIN subscribers s ON s.id = l.subscriber_id
       LEFT JOIN authorized_users au ON au.subscriber_id = s.id
       WHERE l.telegram_id = 'HOTMART'
       ORDER BY l.id ASC`
    );

    if (candidates.rows.length === 0) {
      console.log('Nenhum registro legado com telegram_id = HOTMART encontrado.');
      return;
    }

    const withTelegram = candidates.rows.filter((row) => row.new_telegram_id !== 'PENDENTE').length;
    const pending = candidates.rows.length - withTelegram;

    console.log(`Encontrados ${candidates.rows.length} registro(s) para correção.`);
    console.log(`- Com Telegram ID disponível: ${withTelegram}`);
    console.log(`- Sem Telegram vinculado (virará PENDENTE): ${pending}`);

    if (isDryRun) {
      console.log('Dry-run ativo: nenhuma alteração aplicada.');
      return;
    }

    await client.query('BEGIN');

    const updateResult = await client.query(
      `UPDATE authorization_logs l
       SET telegram_id = CASE
         WHEN au.telegram_id IS NOT NULL AND TRIM(au.telegram_id) <> '' THEN TRIM(au.telegram_id)
         ELSE 'PENDENTE'
       END
       FROM subscribers s
       LEFT JOIN authorized_users au ON au.subscriber_id = s.id
       WHERE l.subscriber_id = s.id
         AND l.telegram_id = 'HOTMART'`
    );

    await client.query('COMMIT');
    console.log(`Atualização concluída. Registros atualizados: ${updateResult.rowCount}.`);
  } catch (error) {
    try {
      await client.query('ROLLBACK');
    } catch (_) {}
    throw error;
  } finally {
    client.release();
    await pool.end();
  }
}

run().catch((error) => {
  console.error('Falha ao corrigir authorization_logs.telegram_id:', error);
  process.exit(1);
});

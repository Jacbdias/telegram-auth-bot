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
    const result = await client.query(
      `SELECT id, email, LOWER(TRIM(email)) AS normalized_email
       FROM subscribers
       WHERE email <> LOWER(TRIM(email))
       ORDER BY id ASC`
    );

    if (result.rows.length === 0) {
      console.log('Nenhum email legado para normalizar.');
      return;
    }

    console.log(`Encontrados ${result.rows.length} registro(s) com email não normalizado.`);

    result.rows.forEach((row) => {
      console.log(`- id=${row.id} | "${row.email}" -> "${row.normalized_email}"`);
    });

    if (isDryRun) {
      console.log('Dry-run ativo: nenhuma alteração aplicada.');
      return;
    }

    await client.query('BEGIN');

    let updated = 0;
    let skipped = 0;

    for (const row of result.rows) {
      try {
        const updateResult = await client.query(
          'UPDATE subscribers SET email = $1, updated_at = NOW() WHERE id = $2',
          [row.normalized_email, row.id]
        );

        if (updateResult.rowCount > 0) {
          updated += 1;
        }
      } catch (error) {
        skipped += 1;
        console.warn(`⚠️ Não foi possível normalizar id=${row.id}: ${error.message}`);
      }
    }

    await client.query('COMMIT');
    console.log(`Normalização concluída. Atualizados: ${updated}. Ignorados: ${skipped}.`);
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
  console.error('Falha na migração de normalização de emails:', error);
  process.exit(1);
});

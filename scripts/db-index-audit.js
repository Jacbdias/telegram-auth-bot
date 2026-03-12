const { Client } = require('pg');

const QUERIES = [
  {
    name: 'table_volume',
    sql: `SELECT schemaname, relname, n_live_tup
          FROM pg_stat_user_tables
          ORDER BY n_live_tup DESC;`
  },
  {
    name: 'existing_indexes',
    sql: `SELECT tablename, indexname, indexdef
          FROM pg_indexes
          WHERE schemaname = 'public'
          ORDER BY tablename, indexname;`
  },
  {
    name: 'slow_queries_pg_stat_statements',
    sql: `SELECT query, calls, mean_exec_time, total_exec_time
          FROM pg_stat_statements
          ORDER BY total_exec_time DESC
          LIMIT 20;`
  },
  {
    name: 'table_io_seq_vs_idx',
    sql: `SELECT relname, seq_scan, seq_tup_read, idx_scan, idx_tup_fetch
          FROM pg_stat_user_tables
          ORDER BY seq_scan DESC;`
  }
];

function printRows(name, rows) {
  console.log(`\n=== ${name} (${rows.length} rows) ===`);
  if (!rows.length) {
    console.log('(no rows)');
    return;
  }
  console.table(rows);
}

async function run() {
  const connectionString = process.env.DATABASE_URL;
  if (!connectionString) {
    console.error('DATABASE_URL is not set. Export DATABASE_URL and rerun this script.');
    process.exitCode = 2;
    return;
  }

  const client = new Client({
    connectionString,
    ssl: { rejectUnauthorized: false }
  });

  try {
    await client.connect();
    console.log('Connected to PostgreSQL.');

    for (const { name, sql } of QUERIES) {
      try {
        const result = await client.query(sql);
        printRows(name, result.rows);
      } catch (error) {
        console.error(`\n=== ${name} (failed) ===`);
        console.error(error.message);
      }
    }
  } finally {
    await client.end();
    console.log('\nConnection closed.');
  }
}

run().catch((error) => {
  console.error('Fatal error while running DB index audit:', error.message);
  process.exitCode = 1;
});

import 'dotenv/config';
import pg from 'pg';

/** Read-only diagnosis of the membership/benefits state (no writes). */
const pool = new pg.Pool({ connectionString: process.env.DATABASE_URL, max: 2 });

async function main(): Promise<void> {
  const mem = await pool.query<{
    id: number; name: string; active: boolean; pagos: string; beneficios: string[];
  }>(
    `SELECT m.id, m.name, m.active,
       (SELECT count(*) FROM membership_payments mp WHERE mp.membership_id = m.id)::text AS pagos,
       COALESCE((SELECT array_agg(b.name ORDER BY b.name)
                 FROM membership_benefits mb JOIN benefits b ON b.id = mb.benefit_id
                 WHERE mb.membership_id = m.id), '{}') AS beneficios
     FROM memberships m ORDER BY m.id`,
  );
  console.log('== Membresías (versiones) ==');
  for (const r of mem.rows) {
    console.log(`v${r.id} · "${r.name}" · active=${r.active} · pagos=${r.pagos} · beneficios=[${r.beneficios.join(', ')}]`);
  }

  console.log('\n== Catálogo de beneficios ==');
  const ben = await pool.query<{ id: number; name: string; active: boolean }>(
    `SELECT id, name, active FROM benefits ORDER BY id`,
  );
  for (const r of ben.rows) console.log(`#${r.id} · ${r.name} · active=${r.active}`);

  console.log('\n== Qué versión de membresía pagó cada chofer (últimos 15) ==');
  const mp = await pool.query<{ name: string; membership_id: number; status: string }>(
    `SELECT u.full_name AS name, mp.membership_id, mp.status
     FROM membership_payments mp JOIN users u ON u.id = mp.driver_id
     ORDER BY mp.created_at DESC LIMIT 15`,
  );
  if (mp.rows.length === 0) console.log('(sin pagos de membresía)');
  for (const r of mp.rows) console.log(`${r.name} · membresía v${r.membership_id} · ${r.status}`);

  await pool.end();
}

main().catch((err) => {
  console.error('Falló:', err);
  process.exitCode = 1;
});

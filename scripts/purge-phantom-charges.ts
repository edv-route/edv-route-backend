import 'dotenv/config';
import pg from 'pg';

/**
 * One-shot data cleanup: remove PHANTOM tariff charges the debt engine emitted
 * for weeks already covered by paid coverage (root-cause fix 2026-07-29). They
 * appear when a driver approved while the engine was OFF (coverage anchored to a
 * weekday) is later billed by the engine on its Monday grid: the idempotency
 * guard misses the coverage and duplicates the week.
 *
 *   npm run db:purge-phantom            # DRY-RUN (read-only): reports what it would delete
 *   npm run db:purge-phantom -- --apply # APPLY (transactional + audited)
 *
 * Scope: charge_kind='period', status IN ('pending','overdue'), invoice_id IS NULL
 * (no money attached), whose period_start falls INSIDE the subscription's paid
 * coverage (max period_end of paid periods). Never touches invoiced or paid rows,
 * so money is never deleted (project money rule). Idempotent.
 */

const APPLY = process.argv.includes('--apply');

// The phantom set: unpaid, un-invoiced period charges whose week starts inside
// the paid coverage (paidUntil). No coverage -> COALESCE to period_start -> the
// strict `<` excludes it (nothing to purge), so real debt is never removed.
const PHANTOM_CTE = `
  WITH phantom AS (
    SELECT sp.id, ds.id AS sub_id, ds.driver_id,
           sp.period_start, sp.period_end, sp.amount_usd
    FROM subscription_payments sp
    JOIN driver_subscriptions ds ON ds.id = sp.driver_subscription_id
    WHERE sp.charge_kind = 'period'
      AND sp.status IN ('pending', 'overdue')
      AND sp.invoice_id IS NULL
      AND sp.period_start < COALESCE(
        (SELECT max(cov.period_end) FROM subscription_payments cov
         WHERE cov.driver_subscription_id = sp.driver_subscription_id
           AND cov.status = 'paid' AND cov.charge_kind = 'period'), sp.period_start)
  )`;

interface Row {
  id: string;
  sub_id: string;
  driver_id: string;
  period_start: Date;
  period_end: Date;
  amount_usd: string;
}

async function main(): Promise<void> {
  const pool = new pg.Pool({ connectionString: process.env.DATABASE_URL });
  try {
    console.log(`\n== Purga de cargos fantasma (${APPLY ? 'APPLY' : 'DRY-RUN'}) ==\n`);

    const preview = await pool.query<Row>(
      `${PHANTOM_CTE}
       SELECT id, sub_id, driver_id, period_start, period_end, amount_usd
       FROM phantom ORDER BY sub_id, period_start`,
    );

    if (preview.rowCount === 0) {
      console.log('No hay cargos fantasma (cargos de tarifa sin factura cubiertos por adelantos). Nada que hacer.\n');
      return;
    }

    const bySub = new Map<string, Row[]>();
    for (const row of preview.rows) {
      (bySub.get(row.sub_id) ?? bySub.set(row.sub_id, []).get(row.sub_id)!).push(row);
    }
    for (const [subId, rows] of bySub) {
      console.log(`sub ${subId} · driver ${rows[0]!.driver_id} · ${rows.length} cargo(s) fantasma:`);
      for (const r of rows) {
        console.log(
          `   ${r.period_start.toISOString()} -> ${r.period_end.toISOString()}  ($${r.amount_usd})`,
        );
      }
    }
    console.log(`\nTotal: ${bySub.size} suscripción(es), ${preview.rowCount} cargo(s) fantasma.`);

    if (!APPLY) {
      console.log('\nDRY-RUN: no se borró nada. Ejecuta con --apply para eliminarlos.\n');
      return;
    }

    const client = await pool.connect();
    try {
      await client.query('BEGIN');
      const deleted = await client.query<{ sub_id: string; driver_id: string }>(
        `${PHANTOM_CTE}
         DELETE FROM subscription_payments sp
         USING phantom ph
         WHERE sp.id = ph.id
         RETURNING ph.sub_id, ph.driver_id`,
      );
      // One audit entry per subscription, with the number of charges removed.
      const counts = new Map<string, { driverId: string; n: number }>();
      for (const r of deleted.rows) {
        const c = counts.get(r.sub_id) ?? { driverId: r.driver_id, n: 0 };
        c.n += 1;
        counts.set(r.sub_id, c);
      }
      for (const [subId, c] of counts) {
        await client.query(
          `INSERT INTO audit_logs (actor_admin_id, event_type, entity, entity_id, data)
           VALUES (NULL, 'subscription.phantom_purged', 'driver_subscriptions', $1, $2)`,
          [subId, JSON.stringify({ driverId: c.driverId, charges: c.n })],
        );
      }
      await client.query('COMMIT');
      console.log(`\n✅ Aplicado: ${deleted.rowCount} cargo(s) fantasma eliminado(s) en ${counts.size} suscripción(es).\n`);
    } catch (err) {
      await client.query('ROLLBACK');
      throw err;
    } finally {
      client.release();
    }
  } finally {
    await pool.end();
  }
}

main().catch((err) => {
  console.error(err);
  process.exitCode = 1;
});

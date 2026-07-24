import 'dotenv/config';
import pg from 'pg';

/**
 * One-shot data migration: re-anchor the live WEEKLY subscriptions from the
 * moving-window model to the debt engine's Monday grid (design v8). See
 * docs/proposals/tarifa-penalizacion/plan-migracion-anclaje.md.
 *
 *   npm run db:reanchor            # DRY-RUN (read-only): reports before/after
 *   npm run db:reanchor -- --apply # APPLY (transactional + audited)
 *
 * Scope: `active` subscriptions on a `weekly` plan, re-anchoring only the
 * non-consumed paid coverage (`status = 'paid'`, `charge_kind = 'period'`,
 * `period_end > now()`) to consecutive Mondays from the current week's Monday.
 * Money is never duplicated or deleted: only period windows move. Idempotent.
 *
 * PRE-CONDITION: every active weekly subscription must be up to date (have live
 * coverage). Any `active` weekly sub WITHOUT live coverage is reported and, in
 * --apply, ABORTS the run (resolve those by hand first, per the plan).
 */

const APPLY = process.argv.includes('--apply');

// Shared source set: the non-consumed paid weeks of every active weekly sub,
// numbered per subscription so idx 0,1,2… map to consecutive Mondays.
const ORDERED_CTE = `
  WITH cfg AS (SELECT $1::text AS tz),
       ordered AS (
         SELECT sp.id,
                ds.id AS sub_id,
                ds.driver_id,
                sp.period_start AS old_start,
                sp.period_end   AS old_end,
                (row_number() OVER (PARTITION BY ds.id ORDER BY sp.period_start) - 1)::int AS idx,
                date_trunc('week', (now() AT TIME ZONE (SELECT tz FROM cfg))) AS monday,
                (SELECT tz FROM cfg) AS tz
         FROM subscription_payments sp
         JOIN driver_subscriptions ds ON ds.id = sp.driver_subscription_id
         JOIN subscription_plans   p  ON p.id  = ds.plan_id
         WHERE ds.status = 'active'
           AND p.billing_period = 'weekly'
           AND sp.status = 'paid'
           AND sp.charge_kind = 'period'
           AND sp.period_end > now()
       )`;

interface PreviewRow {
  id: string;
  sub_id: string;
  driver_id: string;
  old_start: Date;
  new_start: Date;
  new_end: Date;
  idx: number;
}

async function main(): Promise<void> {
  const pool = new pg.Pool({ connectionString: process.env.DATABASE_URL });
  try {
    const tzRow = await pool.query<{ value: unknown }>(
      `SELECT value FROM app_settings WHERE key = 'business_timezone'`,
    );
    const tz = String(tzRow.rows[0]?.value ?? 'America/Caracas');
    console.log(`\n== Re-anclaje semanal (${APPLY ? 'APPLY' : 'DRY-RUN'}) · tz=${tz} ==\n`);

    // Pre-condition: active weekly subs without live coverage break the assumption.
    const bad = await pool.query<{ sub_id: string; driver_id: string }>(
      `SELECT ds.id AS sub_id, ds.driver_id
       FROM driver_subscriptions ds
       JOIN subscription_plans p ON p.id = ds.plan_id
       WHERE ds.status = 'active' AND p.billing_period = 'weekly'
         AND NOT EXISTS (
           SELECT 1 FROM subscription_payments sp
           WHERE sp.driver_subscription_id = ds.id
             AND sp.status = 'paid' AND sp.charge_kind = 'period' AND sp.period_end > now()
         )`,
    );
    if (bad.rowCount) {
      console.log(`⚠️  ${bad.rowCount} suscripción(es) weekly activas SIN cobertura vigente (resolver a mano):`);
      for (const r of bad.rows) console.log(`   - sub ${r.sub_id} · driver ${r.driver_id}`);
      if (APPLY) {
        console.error('\n❌ ABORTADO: la pre-condición no se cumple. Salda/ajusta esas suscripciones antes de --apply.\n');
        process.exitCode = 1;
        return;
      }
      console.log('   (en --apply esto abortaría; en dry-run solo se avisa)\n');
    }

    // Preview: old -> new window for every non-consumed paid week.
    const preview = await pool.query<PreviewRow>(
      `${ORDERED_CTE}
       SELECT id, sub_id, driver_id, old_start, idx,
              (monday + make_interval(days => idx * 7))       AT TIME ZONE tz AS new_start,
              (monday + make_interval(days => (idx + 1) * 7)) AT TIME ZONE tz AS new_end
       FROM ordered ORDER BY sub_id, idx`,
      [tz],
    );

    if (preview.rowCount === 0) {
      console.log('No hay cobertura weekly vigente que re-anclar. Nada que hacer.\n');
      return;
    }

    const bySub = new Map<string, PreviewRow[]>();
    for (const row of preview.rows) {
      (bySub.get(row.sub_id) ?? bySub.set(row.sub_id, []).get(row.sub_id)!).push(row);
    }
    for (const [subId, rows] of bySub) {
      console.log(`sub ${subId} · driver ${rows[0]!.driver_id} · ${rows.length} semana(s):`);
      for (const r of rows) {
        console.log(
          `   [${r.idx}] ${r.old_start.toISOString()}  ->  ${r.new_start.toISOString()}`,
        );
      }
    }
    console.log(`\nTotal: ${bySub.size} suscripción(es), ${preview.rowCount} período(s).`);

    if (!APPLY) {
      console.log('\nDRY-RUN: no se escribió nada. Ejecuta con --apply en la ventana de corte.\n');
      return;
    }

    // Apply, transactional + audited. Re-runs are idempotent (already-Monday
    // rows are rewritten to the same values).
    const client = await pool.connect();
    try {
      await client.query('BEGIN');
      const moved = await client.query<{ driver_subscription_id: string }>(
        `${ORDERED_CTE}
         UPDATE subscription_payments sp SET
           period_start = (o.monday + make_interval(days => o.idx * 7))       AT TIME ZONE o.tz,
           period_end   = (o.monday + make_interval(days => (o.idx + 1) * 7)) AT TIME ZONE o.tz
         FROM ordered o WHERE o.id = sp.id
         RETURNING sp.driver_subscription_id`,
        [tz],
      );
      const subs = await client.query<{ id: string; driver_id: string }>(
        `UPDATE driver_subscriptions ds SET
           current_period_start = date_trunc('week', (now() AT TIME ZONE $1)) AT TIME ZONE $1,
           current_period_end   = (date_trunc('week', (now() AT TIME ZONE $1)) + interval '7 days') AT TIME ZONE $1
         FROM subscription_plans p
         WHERE p.id = ds.plan_id AND ds.status = 'active' AND p.billing_period = 'weekly'
           AND EXISTS (
             SELECT 1 FROM subscription_payments sp
             WHERE sp.driver_subscription_id = ds.id
               AND sp.status = 'paid' AND sp.charge_kind = 'period' AND sp.period_end > now()
           )
         RETURNING ds.id, ds.driver_id`,
        [tz],
      );
      for (const sub of subs.rows) {
        const weeks = moved.rows.filter((r) => r.driver_subscription_id === sub.id).length;
        await client.query(
          `INSERT INTO audit_logs (actor_admin_id, event_type, entity, entity_id, data)
           VALUES (NULL, 'subscription.reanchored', 'driver_subscriptions', $1, $2)`,
          [sub.id, JSON.stringify({ driverId: sub.driver_id, weeks })],
        );
      }
      await client.query('COMMIT');
      console.log(`\n✅ Aplicado: ${subs.rowCount} suscripción(es), ${moved.rowCount} período(s) re-anclado(s).\n`);
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

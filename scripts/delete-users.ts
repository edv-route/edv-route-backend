import 'dotenv/config';
import pg from 'pg';

/**
 * Deletes specific drivers (by national id) and EVERYTHING hanging off them —
 * payment submissions + files, tariff/membership charges, invoices, subscriptions,
 * vehicles + images, documents, training attendance and their audit trail — in one
 * transaction. Money rows are removed too (regla #7 says money is never deleted;
 * this is an explicit, admin-authorised cleanup of TEST data pre-production).
 *
 * DESTRUCTIVE — run ONLY against the development database. Dry-run by default:
 *   node --import tsx scripts/delete-users.ts V-12345678 V-8765432       (dry-run)
 *   node --import tsx scripts/delete-users.ts V-12345678 V-8765432 --apply
 */

const args = process.argv.slice(2);
const apply = args.includes('--apply');
const cedulas = args.filter((a) => a !== '--apply');

const pool = new pg.Pool({ connectionString: process.env.DATABASE_URL });

async function main(): Promise<void> {
  if (cedulas.length === 0) {
    console.error('Uso: delete-users.ts <cédula> [<cédula> …] [--apply]');
    process.exitCode = 1;
    return;
  }

  const client = await pool.connect();
  try {
    const { rows: targets } = await client.query<{
      id: string;
      name: string;
      cedula: string;
      status: string;
    }>(
      `SELECT u.id, u.full_name AS name, d.national_id AS cedula, d.status::text AS status
       FROM users u JOIN drivers d ON d.user_id = u.id
       WHERE d.national_id = ANY($1)`,
      [cedulas],
    );

    console.log(`\n== Usuarios encontrados (${targets.length}/${cedulas.length}) ==`);
    for (const t of targets) {
      const { rows: c } = await client.query<Record<string, string>>(
        `SELECT
           (SELECT count(*) FROM payment_submissions WHERE driver_id = $1) AS recibos,
           (SELECT count(*) FROM invoices WHERE driver_id = $1) AS facturas,
           (SELECT count(*) FROM subscription_payments sp
              JOIN driver_subscriptions ds ON ds.id = sp.driver_subscription_id
              WHERE ds.driver_id = $1) AS cargos,
           (SELECT count(*) FROM membership_payments WHERE driver_id = $1) AS membresias,
           (SELECT count(*) FROM vehicles WHERE driver_id = $1) AS vehiculos,
           (SELECT count(*) FROM documents WHERE driver_id = $1) AS documentos`,
        [t.id],
      );
      const n = c[0]!;
      console.log(
        `- ${t.cedula} · ${t.name} · [${t.status}] → recibos:${n['recibos']} facturas:${n['facturas']} ` +
          `cargos:${n['cargos']} membresías:${n['membresias']} vehículos:${n['vehiculos']} docs:${n['documentos']}`,
      );
    }
    const found = new Set(targets.map((t) => t.cedula));
    for (const ced of cedulas) if (!found.has(ced)) console.log(`  ⚠️ NO encontrada: ${ced}`);

    const ids = targets.map((t) => t.id);
    if (!apply) {
      console.log(`\nDRY-RUN — nada se borró. Añade --apply para eliminar ${ids.length} usuario(s) y todo lo suyo.\n`);
      return;
    }
    if (ids.length === 0) {
      console.log('\nNada que borrar.\n');
      return;
    }

    const vehSub = `(SELECT id FROM vehicles WHERE driver_id = ANY($1::uuid[]))`;
    await client.query('BEGIN');
    // Lock the subscriptions so a concurrent scheduler cannot insert a charge
    // between the DELETEs (INSERT takes a key-share lock on the referenced row).
    await client.query(`SELECT id FROM driver_subscriptions WHERE driver_id = ANY($1::uuid[]) FOR UPDATE`, [ids]);
    // Children -> parents (order mirrors reset-data, filtered to these users).
    await client.query(
      `DELETE FROM payment_submission_files WHERE submission_id IN
         (SELECT id FROM payment_submissions WHERE driver_id = ANY($1::uuid[]))`,
      [ids],
    );
    await client.query(`DELETE FROM payment_submissions WHERE driver_id = ANY($1::uuid[])`, [ids]);
    await client.query(
      `DELETE FROM subscription_payments WHERE driver_subscription_id IN
         (SELECT id FROM driver_subscriptions WHERE driver_id = ANY($1::uuid[]))`,
      [ids],
    );
    await client.query(`DELETE FROM membership_payments WHERE driver_id = ANY($1::uuid[])`, [ids]);
    await client.query(`DELETE FROM invoices WHERE driver_id = ANY($1::uuid[])`, [ids]);
    await client.query(`DELETE FROM driver_subscriptions WHERE driver_id = ANY($1::uuid[])`, [ids]);
    await client.query(`DELETE FROM documents WHERE driver_id = ANY($1::uuid[]) OR vehicle_id IN ${vehSub}`, [ids]);
    await client.query(`DELETE FROM vehicle_images WHERE vehicle_id IN ${vehSub}`, [ids]);
    await client.query(`DELETE FROM training_attendees WHERE driver_id = ANY($1::uuid[])`, [ids]);
    // Break the drivers.current_vehicle_id FK before removing the vehicles.
    await client.query(`UPDATE drivers SET current_vehicle_id = NULL WHERE user_id = ANY($1::uuid[])`, [ids]);
    await client.query(`DELETE FROM vehicles WHERE driver_id = ANY($1::uuid[])`, [ids]);
    // Audit trail of these drivers (actor, entity or the driverId stamped in data).
    await client.query(
      `DELETE FROM audit_logs
       WHERE actor_user_id = ANY($1::uuid[])
          OR entity_id::text = ANY($2::text[])
          OR data->>'driverId' = ANY($2::text[])`,
      [ids, ids],
    );
    await client.query(`DELETE FROM users WHERE id = ANY($1::uuid[])`, [ids]); // cascades to drivers
    await client.query('COMMIT');
    console.log(
      `\n✅ Eliminados ${ids.length} usuario(s) y todo lo suyo (recibos, facturas, cargos, ` +
        `membresías, suscripciones, vehículos, documentos, auditoría).\n`,
    );
  } catch (err) {
    await client.query('ROLLBACK').catch(() => {});
    throw err;
  } finally {
    client.release();
    await pool.end();
  }
}

main().catch((err) => {
  console.error('❌ Falló:', err);
  process.exitCode = 1;
});

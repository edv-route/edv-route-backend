/* eslint-disable camelcase */

/**
 * Notification system, phase 1 (design v7 §5, decision 2026-08-19): the tables
 * and the transactional outbox. No delivery yet - the dispatcher ships with a
 * log-only sender and Firebase arrives last, on purpose: everything below works
 * without push.
 *
 * ONE table serves both roles. `notifications` IS the inbox row (what the app
 * lists) and IS the outbox row (what the dispatcher has to push). A second
 * table would only duplicate the same fact and invite the two to disagree.
 *
 * The row is written INSIDE the transaction of the fact it announces, so a
 * reverted payment takes its notice with it. Nothing here ever calls a vendor:
 * an HTTP call inside a money transaction would hang the debt engine tick, and
 * a push sent before COMMIT announces something that may never happen.
 */

exports.up = (pgm) => {
  // Closed list for v1: only automatic money/approval notices. A new case costs
  // a migration ON PURPOSE - that friction is what keeps this from drifting into
  // manual campaigns (push_campaigns was deliberately postponed).
  pgm.createType('notification_type', [
    'charge_issued', // weekly charge emitted (Friday)
    'charge_reminder', // single heads-up before the week starts (Sunday afternoon)
    'debt_overdue', // the week started unpaid -> arrears
    'penalty_applied', // debt cap crossed -> fine + penalized
    'driver_reactivated', // back to operating after settling
    'tariff_starting', // admin scheduled the start date
    'payment_received', // report landed, under review
    'payment_approved',
    'payment_rejected', // carries the reason in `payload`
    'application_approved',
    'application_rejected',
    'document_approved',
    'document_rejected',
    'vehicle_approved',
    'vehicle_rejected',
  ]);

  // 'skipped' is NOT a failure: it means there was nothing to push to (no active
  // device token). The driver still has the notice in his inbox, which is the
  // only channel some of them will ever have (Huawei without Play Services,
  // permission denied on Android 13+).
  pgm.createType('notification_push_status', ['pending', 'sent', 'skipped', 'failed']);
  pgm.createType('device_platform', ['android', 'ios']);

  pgm.createTable('notifications', {
    id: {
      type: 'bigint',
      primaryKey: true,
      sequenceGenerated: { precedence: 'BY DEFAULT' },
    },
    // CASCADE: the applicant cleanup deletes users; their notices are not
    // history worth orphaning (the audit log is what keeps the record).
    user_id: { type: 'uuid', notNull: true, references: 'users', onDelete: 'CASCADE' },
    type: { type: 'notification_type', notNull: true },
    title: { type: 'text', notNull: true },
    body: { type: 'text', notNull: true },
    // Structured context the app needs to act (amounts, invoice ids, rejection
    // reason). The title/body are already rendered: the phone must not have to
    // compose the text, or fixing a wording means shipping an APK.
    payload: { type: 'jsonb' },
    read_at: { type: 'timestamptz' },
    /**
     * When the push may leave. Defaults to "now", but it is what separates the
     * NOTICE from the FACT: the engine marks arrears at 00:05 and writes the row
     * in that same transaction with delivery set to ~7:00 am. Without this column
     * the alternative is a second scheduler that re-reads the facts - and then
     * the notice is no longer atomic with what it announces.
     */
    deliver_after: { type: 'timestamptz', notNull: true, default: pgm.func('now()') },
    push_status: { type: 'notification_push_status', notNull: true, default: 'pending' },
    push_attempts: { type: 'integer', notNull: true, default: 0 },
    push_sent_at: { type: 'timestamptz' },
    push_error: { type: 'text' },
    created_at: { type: 'timestamptz', notNull: true, default: pgm.func('now()') },
  });
  // No updated_at trigger here: this table is append-only except for two state
  // changes that already carry their own explicit timestamp (read_at, push_sent_at).
  // A generic "something changed" column would say less than they do.

  // The inbox listing: newest first for one driver.
  pgm.createIndex('notifications', [{ name: 'user_id' }, { name: 'created_at', sort: 'DESC' }], {
    name: 'notifications_user_created_idx',
  });
  // The unread badge. It travels inside /driver-auth/me/account, which every
  // app screen already asks for, so this count runs constantly.
  pgm.createIndex('notifications', 'user_id', {
    name: 'notifications_unread_idx',
    where: 'read_at IS NULL',
  });
  // The dispatcher's queue scan. Partial: delivered rows are the vast majority
  // and must not weigh on it.
  pgm.createIndex('notifications', 'deliver_after', {
    name: 'notifications_pending_idx',
    where: "push_status = 'pending'",
  });

  pgm.createTable('device_tokens', {
    id: {
      type: 'bigint',
      primaryKey: true,
      sequenceGenerated: { precedence: 'BY DEFAULT' },
    },
    user_id: { type: 'uuid', notNull: true, references: 'users', onDelete: 'CASCADE' },
    /**
     * UNIQUE GLOBALLY, not per user - this is a privacy control, not a tidiness
     * one. The token identifies a PHONE. When a second driver signs in on the
     * same device, registering re-points this row at him instead of leaving two
     * owners for one handset; otherwise the previous driver's amounts and
     * rejection reasons keep landing on a screen that is no longer his. Logout
     * revokes as well - both doors have to be closed.
     */
    token: { type: 'text', notNull: true, unique: true },
    platform: { type: 'device_platform', notNull: true },
    last_seen_at: { type: 'timestamptz', notNull: true, default: pgm.func('now()') },
    // Revoked, not deleted: FCM rotates tokens and the app re-registers them, so
    // a row that comes back to life is normal and keeps its history.
    revoked_at: { type: 'timestamptz' },
    created_at: { type: 'timestamptz', notNull: true, default: pgm.func('now()') },
  });
  pgm.createIndex('device_tokens', 'user_id', {
    name: 'device_tokens_active_idx',
    where: 'revoked_at IS NULL',
  });

  // Master switch, same shape as debt_engine_enabled. OFF: prod and dev share
  // this database, so an unguarded dispatcher on a laptop pushes to real drivers.
  // The dispatcher ALSO refuses to run outside NODE_ENV=production - this flag is
  // the business kill switch, that check is the physical lock.
  pgm.sql(`
    INSERT INTO app_settings (key, value, description) VALUES
    ('notifications_enabled', 'false',
     'Sistema de avisos: interruptor maestro del despachador. false = los avisos se siguen escribiendo y se ven en la bandeja, pero NO sale ningún push')
    ON CONFLICT (key) DO NOTHING
  `);
};

exports.down = (pgm) => {
  pgm.sql(`DELETE FROM app_settings WHERE key = 'notifications_enabled'`);
  pgm.dropTable('device_tokens');
  pgm.dropTable('notifications');
  pgm.dropType('device_platform');
  pgm.dropType('notification_push_status');
  pgm.dropType('notification_type');
};

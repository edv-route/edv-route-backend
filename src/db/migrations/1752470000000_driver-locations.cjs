/* eslint-disable camelcase */

/**
 * Where each affiliate has been while working (proposal:
 * docs/proposals/ubicacion-afiliados). The app reports a point on an interval;
 * this is where they land, plus the last known position and the two settings
 * that govern the whole thing.
 *
 * The history table and the "last known" column are NOT the same fact stored
 * twice. The map asks "where is everyone right now", and answering that from
 * the history means digging out each driver's newest row from tens of thousands
 * every time somebody opens it. On `drivers` it is one column read.
 *
 * PostGIS 3.3.7 is already installed, so `geography` gives distance and
 * proximity queries for free - which is the whole point once trips arrive.
 */

exports.up = (pgm) => {
  pgm.createTable('driver_locations', {
    id: {
      type: 'bigint',
      primaryKey: true,
      sequenceGenerated: { precedence: 'BY DEFAULT' },
    },
    // CASCADE, like notifications: the applicant cleanup deletes users, and a
    // trail of coordinates is not history worth orphaning.
    driver_id: { type: 'uuid', notNull: true, references: 'drivers', onDelete: 'CASCADE' },
    // geography (not geometry): metres out of the box, correct over the globe,
    // and it is what the proximity search will want. Schema-qualified because
    // Supabase installs PostGIS in `extensions`, and migrations run with a
    // search_path that does not include it (runtime queries do, so they are fine).
    point: { type: 'extensions.geography(Point, 4326)', notNull: true },
    // What the phone said its margin of error was. A fix taken indoors or with
    // a cold GPS can be off by 500 m: still worth keeping for the trail, but the
    // live map and trip assignment MUST be able to ignore it, or somebody gets
    // sent to an address the phone invented. Stored always, filtered on read.
    accuracy_m: { type: 'real' },
    // When the PHONE took it.
    recorded_at: { type: 'timestamptz', notNull: true },
    // When it reached the server.
    created_at: { type: 'timestamptz', notNull: true, default: pgm.func('now()') },
  });

  // Two timestamps, not one: with the local queue a point can arrive hours after
  // it was taken. The trail is drawn with `recorded_at`; the gap between the two
  // is how long that driver spent with no signal, which is real operational
  // information rather than bookkeeping.

  // The only query anyone will run: this driver's trail between two times. It
  // is also what keeps a driver's history together on disk.
  //
  // The daily purge deliberately gets NO index of its own: it deletes by age
  // across every driver, and a second index would tax every single insert to
  // speed up one job a day that scans a table this size in milliseconds. If the
  // table ever grows enough to matter, that is the moment to add it.
  pgm.createIndex('driver_locations', [{ name: 'driver_id' }, { name: 'recorded_at', sort: 'DESC' }], {
    name: 'driver_locations_driver_recent_idx',
  });

  // The last known position, for the live map. Designed back in v7 and never
  // implemented - the columns did not exist until now.
  pgm.addColumns('drivers', {
    last_location: { type: 'extensions.geography(Point, 4326)' },
    last_location_at: { type: 'timestamptz' },
  });

  // GIST is what makes "who is nearest" a lookup instead of a full scan. Cheap
  // to create now with ten rows; expensive to bolt on once trips depend on it.
  pgm.createIndex('drivers', 'last_location', {
    name: 'drivers_last_location_gist',
    method: 'gist',
    where: 'last_location IS NOT NULL',
  });

  pgm.sql(`
    INSERT INTO app_settings (key, value, description) VALUES
    ('location_retention_days', '30',
     'Ubicación: días de historial de posiciones que se conservan. Un job diario borra lo anterior. Subirlo hace crecer la base (unas 144 posiciones por chofer y día)'),
    ('location_interval_seconds', '600',
     'Ubicación: cada cuántos segundos reporta su posición la app EN REPOSO (600 = 10 min). La app lo consulta al arrancar, así que se puede subir el día que haya viajes sin publicar un APK nuevo')
    ON CONFLICT (key) DO NOTHING
  `);
};

exports.down = (pgm) => {
  pgm.sql(`DELETE FROM app_settings WHERE key IN ('location_retention_days', 'location_interval_seconds')`);
  pgm.dropIndex('drivers', 'last_location', { name: 'drivers_last_location_gist' });
  pgm.dropColumns('drivers', ['last_location', 'last_location_at']);
  pgm.dropTable('driver_locations');
};

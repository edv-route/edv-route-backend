/* eslint-disable camelcase */

/**
 * Cache of reverse geocoding: coordinates turned into a street name (proposal:
 * docs/proposals/ubicacion-afiliados/fase-4-mapa.md, fase 4d).
 *
 * A cache is not an optimisation here, it is the only way this can exist at
 * all. The public OpenStreetMap geocoder allows ONE request per second and its
 * usage policy explicitly requires caching results; a panel with a hundred
 * affiliates refreshing would need seven per second and get blocked.
 *
 * The key is a rounded coordinate, not the exact one. An affiliate parked at a
 * traffic light produces dozens of readings metres apart that all resolve to
 * the same street: snapping them to a ~33 m grid collapses those into one
 * lookup. Two decimals more would defeat the purpose; two less would put the
 * wrong corner on the card.
 */

exports.up = (pgm) => {
  pgm.createTable('geocode_cache', {
    // The grid cell, as "lat_step:lon_step". Natural key: the same cell must
    // never be looked up twice, and that is the whole point of the table.
    grid_key: { type: 'text', primaryKey: true },
    // The coordinate actually sent to the geocoder (centre of the cell).
    lat: { type: 'double precision', notNull: true },
    lon: { type: 'double precision', notNull: true },
    /**
     * What the panel shows: "Av. Luis Roche, Altamira". NULL is a real answer,
     * not a missing one - the middle of a field has no street, and without
     * storing that we would ask again forever for a place that has no name.
     */
    label: { type: 'text' },
    created_at: { type: 'timestamptz', notNull: true, default: pgm.func('now()') },
  });

  // Ages out with the history it describes: a cached street name is worthless
  // once no point references that cell, and OSM data does change.
  pgm.createIndex('geocode_cache', 'created_at');
};

exports.down = (pgm) => {
  pgm.dropTable('geocode_cache');
};

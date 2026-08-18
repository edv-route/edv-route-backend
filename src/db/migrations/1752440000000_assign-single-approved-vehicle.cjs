/* eslint-disable camelcase */

/**
 * Puts the only approved vehicle in use, for the drivers who already have one
 * (2026-08-18).
 *
 * `drivers.current_vehicle_id` existed since the original design but nothing
 * ever wrote it, so every driver reads as "no vehicle in use" — including five
 * who have exactly one approved vehicle and therefore nothing to choose from.
 *
 * The rule (decision de Luis): WHICH vehicle he works with is the affiliate's
 * decision, not the admin's — but with a single approved vehicle there is no
 * decision to make. So this only fills the drivers with EXACTLY ONE approved
 * vehicle and none in use. Anyone with two or more is left untouched: he picks
 * from the app.
 */

exports.up = (pgm) => {
  pgm.sql(`
    UPDATE drivers d
       SET current_vehicle_id = v.id
      FROM vehicles v
     WHERE v.driver_id = d.user_id
       AND v.approval_status = 'approved'
       AND d.current_vehicle_id IS NULL
       AND (SELECT count(*) FROM vehicles x
             WHERE x.driver_id = d.user_id AND x.approval_status = 'approved') = 1
  `);
};

exports.down = (pgm) => {
  // Only release what this migration could have set: a driver whose single
  // approved vehicle is the one in use. A choice made from the app (two or more
  // approved) is his and must survive a rollback.
  pgm.sql(`
    UPDATE drivers d
       SET current_vehicle_id = NULL
     WHERE d.current_vehicle_id IS NOT NULL
       AND (SELECT count(*) FROM vehicles v
             WHERE v.driver_id = d.user_id AND v.approval_status = 'approved') = 1
  `);
};

const { readFileSync } = require('node:fs');
const { join } = require('node:path');
exports.up = (pgm) => pgm.sql(readFileSync(join(__dirname, '../schema-baseline.sql'), 'utf8'));
exports.down = () => {
  throw new Error(
    'Migración fundacional: restaurar un respaldo o crear una nueva migración correctiva.',
  );
};

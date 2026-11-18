const { readFileSync } = require('node:fs');
const { join } = require('node:path');
exports.up = (pgm) => pgm.sql(readFileSync(join(__dirname, '../schema-phase1.sql'), 'utf8'));
exports.down = () => {
  throw new Error(
    'Esta migración conserva identidades e historial; usar una migración correctiva.',
  );
};

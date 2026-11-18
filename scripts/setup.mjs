import './check-node.mjs';
import { readFile, writeFile, access } from 'node:fs/promises';
import { randomBytes } from 'node:crypto';
try {
  await access('.env');
  console.log('.env ya existe; se conserva su configuración.');
} catch {
  const template = await readFile('.env.example', 'utf8');
  await writeFile(
    '.env',
    template.replace(
      'REPLACE_WITH_A_RANDOM_SECRET_OF_AT_LEAST_48_CHARACTERS',
      randomBytes(48).toString('base64url'),
    ),
    { flag: 'wx' },
  );
  console.log('.env creado con una clave aleatoria.');
}

import { writeFile } from 'node:fs/promises';
// This prepares configuration only; it creates no remote service or paid resource.
const [backend, frontend] = process.argv.slice(2);
for (const origin of [backend, frontend]) {
  if (!origin)
    throw new Error(
      'Usage: node scripts/configure-hosting.mjs https://backend.example https://frontend.example',
    );
  const url = new URL(origin);
  if (url.protocol !== 'https:' || url.origin !== origin)
    throw new Error('Use exact HTTPS origins without paths or credentials.');
}
await writeFile(
  'vercel.json',
  JSON.stringify(
    {
      $schema: 'https://openapi.vercel.sh/vercel.json',
      framework: null,
      installCommand: 'npm ci',
      buildCommand: 'npm run build -w @apuntado/contracts && npm run build -w @apuntado/web',
      outputDirectory: 'apps/web/dist',
      rewrites: [
        { source: '/api/:path*', destination: `${backend}/api/:path*` },
        { source: '/:path*', destination: '/index.html' },
      ],
      headers: [
        {
          source: '/(.*)',
          headers: [
            { key: 'X-Content-Type-Options', value: 'nosniff' },
            { key: 'Referrer-Policy', value: 'strict-origin-when-cross-origin' },
            {
              key: 'Content-Security-Policy',
              value: `default-src 'self'; script-src 'self'; style-src 'self'; img-src 'self' data:; connect-src 'self' ${backend} ${backend.replace('https:', 'wss:')}; frame-ancestors 'none'; base-uri 'self'; form-action 'self'`,
            },
          ],
        },
        { source: '/api/:path*', headers: [{ key: 'Cache-Control', value: 'no-store' }] },
      ],
    },
    null,
    2,
  ) + '\n',
);
console.log(
  `Prepared vercel.json. Set VITE_SOCKET_URL=${backend} on Vercel and ALLOWED_ORIGINS=${frontend} on Railway. No deployment was performed.`,
);

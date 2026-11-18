import { test } from 'node:test';
import assert from 'node:assert/strict';
import { complexity, inspectProject, sourceGraph, violations } from '../scripts/architecture.mjs';
test('architecture: full source graph has no cycles or forbidden imports; game rules/coordinator CC <= 10', () => {
  const result = inspectProject();
  assert.ok(result.files >= 20);
  assert.ok(result.functions.length >= 30);
  assert.deepEqual(result.problems, []);
  assert.deepEqual(
    result.functions.filter((f: { score: number }) => f.score > 10),
    [],
  );
});
test('architecture controls detect cycles, infrastructure imports and crossed variants', () => {
  const graph = sourceGraph(
    new Map([
      ['apps/web/src/a.ts', `import '../../server/src/game/service.js';`],
      ['apps/server/src/game/service.ts', `import '../../../web/src/a.js';`],
      ['apps/server/src/game/rules/classic.ts', `import 'pg'; import './apuntado.js';`],
      ['apps/server/src/game/rules/apuntado.ts', `export const value=1;`],
    ]),
  );
  const errors = violations(graph).join('\n');
  for (const marker of ['cycle:', 'pure rules', 'UI depends', 'variants depend'])
    assert.ok(errors.includes(marker), errors);
  assert.equal(
    violations(
      sourceGraph(
        new Map([
          [
            'apps/server/src/game/rules/classic.ts',
            `import type { Closure } from '@apuntado/contracts';`,
          ],
        ]),
      ),
    ).length,
    0,
  );
});
test('complexity controls: ten passes, eleven fails and nested functions are counted separately', () => {
  const code = (branches: number) =>
    `function value(x:number){${Array.from({ length: branches }, (_, i) => `if(x===${i})return ${i};`).join('')}return -1;}`;
  assert.equal(complexity(code(9))[0].score, 10);
  assert.equal(complexity(code(10))[0].score, 11);
  assert.deepEqual(
    complexity(`function a(){const b=()=>{if(true)return 1;};}`).map(
      (f: { score: number }) => f.score,
    ),
    [1, 2],
  );
});

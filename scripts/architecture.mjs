import ts from 'typescript';
import { readFileSync, readdirSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const functionNode = (node) =>
  ts.isFunctionDeclaration(node) ||
  ts.isFunctionExpression(node) ||
  ts.isArrowFunction(node) ||
  ts.isMethodDeclaration(node) ||
  ts.isConstructorDeclaration(node);
export function complexity(source, filename = 'input.ts') {
  const ast = ts.createSourceFile(filename, source, ts.ScriptTarget.Latest, true);
  const functions = [];
  function collect(node) {
    if (functionNode(node) && node.body) {
      let score = 1;
      function count(child) {
        if (child !== node && functionNode(child)) return;
        if (
          ts.isIfStatement(child) ||
          ts.isConditionalExpression(child) ||
          ts.isForStatement(child) ||
          ts.isForOfStatement(child) ||
          ts.isForInStatement(child) ||
          ts.isWhileStatement(child) ||
          ts.isDoStatement(child) ||
          ts.isCatchClause(child) ||
          ts.isCaseClause(child)
        )
          score++;
        if (
          ts.isBinaryExpression(child) &&
          [
            ts.SyntaxKind.AmpersandAmpersandToken,
            ts.SyntaxKind.BarBarToken,
            ts.SyntaxKind.QuestionQuestionToken,
            ts.SyntaxKind.AmpersandAmpersandEqualsToken,
            ts.SyntaxKind.BarBarEqualsToken,
            ts.SyntaxKind.QuestionQuestionEqualsToken,
          ].includes(child.operatorToken.kind)
        )
          score++;
        if (
          child.questionDotToken ||
          (ts.isParameter(child) && child.initializer) ||
          (ts.isBindingElement(child) && child.initializer)
        )
          score++;
        ts.forEachChild(child, count);
      }
      count(node);
      functions.push({
        file: filename,
        line: ast.getLineAndCharacterOfPosition(node.getStart(ast)).line + 1,
        name: node.name?.getText(ast) ?? '<callback>',
        score,
      });
    }
    ts.forEachChild(node, collect);
  }
  collect(ast);
  return functions;
}
export function sourceGraph(files) {
  const graph = new Map();
  for (const [filename, source] of files) {
    const ast = ts.createSourceFile(filename, source, ts.ScriptTarget.Latest, true);
    const dependencies = [];
    function visit(node) {
      let specifier;
      if (
        (ts.isImportDeclaration(node) || ts.isExportDeclaration(node)) &&
        node.moduleSpecifier &&
        ts.isStringLiteral(node.moduleSpecifier)
      )
        specifier = node.moduleSpecifier.text;
      if (
        ts.isCallExpression(node) &&
        (node.expression.kind === ts.SyntaxKind.ImportKeyword ||
          node.expression.getText(ast) === 'require') &&
        node.arguments[0] &&
        ts.isStringLiteral(node.arguments[0])
      )
        specifier = node.arguments[0].text;
      if (specifier) {
        const base = path.posix.normalize(
          path.posix.join(path.posix.dirname(filename), specifier.replace(/\.js$/, '.ts')),
        );
        dependencies.push(
          specifier.startsWith('.')
            ? ([base, `${base}.ts`, `${base}.tsx`].find((candidate) => files.has(candidate)) ??
                base)
            : specifier,
        );
      }
      ts.forEachChild(node, visit);
    }
    visit(ast);
    graph.set(filename, dependencies);
  }
  return graph;
}
export function violations(graph) {
  const problems = [];
  const pure = (file) =>
    (file.includes('/game/rules/') && !file.endsWith('/catalog.ts')) ||
    file.endsWith('/game/domain.ts');
  for (const [file, imports] of graph)
    for (const target of imports) {
      if (pure(file) && target !== '@apuntado/contracts' && !pure(target))
        problems.push(`${file} -> ${target}: pure rules depend on infrastructure`);
      if (
        file.startsWith('apps/web/') &&
        (target.startsWith('apps/server/') || /^(pg|express|socket\.io)$/.test(target))
      )
        problems.push(`${file} -> ${target}: UI depends on server`);
      if (file.startsWith('packages/contracts/') && target !== 'zod')
        problems.push(`${file} -> ${target}: contracts depend on implementation`);
      if (
        /\/rules\/(classic|apuntado)\.ts$/.test(file) &&
        /\/rules\/(classic|apuntado)\.ts$/.test(target) &&
        file !== target
      )
        problems.push(`${file} -> ${target}: variants depend on each other`);
    }
  const visited = new Set(),
    active = new Set();
  function walk(file) {
    if (active.has(file)) {
      problems.push(`cycle: ${[...active, file].join(' -> ')}`);
      return;
    }
    if (visited.has(file)) return;
    active.add(file);
    for (const dependency of graph.get(file) ?? []) if (graph.has(dependency)) walk(dependency);
    active.delete(file);
    visited.add(file);
  }
  for (const file of graph.keys()) walk(file);
  return problems;
}
export function inspectProject() {
  const files = new Map();
  for (const root of ['apps/server/src', 'apps/web/src', 'packages/contracts/src'])
    for (const file of readdirSync(root, { recursive: true })
      .map(String)
      .filter((f) => /\.tsx?$/.test(f))) {
      const filename = `${root}/${file.replaceAll('\\', '/')}`;
      files.set(filename, readFileSync(filename, 'utf8'));
    }
  const measured = [...files]
    .filter(
      ([file]) =>
        file.endsWith('/game/domain.ts') ||
        file.endsWith('/game/service.ts') ||
        file.includes('/game/rules/'),
    )
    .flatMap(([file, source]) => complexity(source, file));
  return { files: files.size, functions: measured, problems: violations(sourceGraph(files)) };
}
if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  const result = inspectProject();
  console.log(
    JSON.stringify(
      {
        files: result.files,
        functions: result.functions.length,
        maximum: Math.max(...result.functions.map((f) => f.score)),
        violations: result.problems,
        overLimit: result.functions.filter((f) => f.score > 10),
      },
      null,
      2,
    ),
  );
  if (result.problems.length || result.functions.some((f) => f.score > 10)) process.exitCode = 1;
}

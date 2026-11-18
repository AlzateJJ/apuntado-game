if (Number(process.versions.node.split('.')[0]) !== 24) {
  console.error(
    'Apuntado requiere Node.js 24 LTS. Selecciona Node 24 antes de instalar o ejecutar.',
  );
  process.exit(1);
}

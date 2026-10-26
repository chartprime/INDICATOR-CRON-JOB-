const {mapObservation} = require('../../apps/runtime/src/data-contracts/v1/adapters');
const {createIdentityResolver} = require('../../apps/runtime/src/data-contracts/v1/identity');
const MAX = 16 * 1024 * 1024;
let input = Buffer.alloc(0);
process.stdin.on('data', chunk => {
  if (input.length + chunk.length > MAX) { process.stderr.write('BATCH_BYTE_LIMIT\n'); process.exit(1); }
  input = Buffer.concat([input, chunk]);
});
process.stdin.on('end', () => {
  try {
    const request = JSON.parse(input.toString('utf8'));
    if (!Array.isArray(request.rows) || request.rows.length > 512) throw new Error('BATCH_ROW_LIMIT');
    const resolveIdentity = createIdentityResolver(request.mappings);
    const results = request.rows.map(({row, position}) => mapObservation(request.provider, request.family, row, {
      ...request.context, resolveIdentity, position: String(position),
      lineage: {...request.context.lineage, row: String(position)},
    }));
    for (const result of results) for (const record of result.records) record.quality.flags.push('PROTOTYPE_INGEST_TIME_UNAVAILABLE');
    const output = JSON.stringify(results);
    if (Buffer.byteLength(output) > MAX) throw new Error('OUTPUT_BYTE_LIMIT');
    process.stdout.write(output);
  } catch (error) { process.stderr.write((error.code ?? 'MAPPER_FAILURE') + '\n'); process.exitCode = 1; }
});

import path from 'node:path';
import { pathToFileURL } from 'node:url';
import { parseArgs } from 'node:util';
import { captureCanonicalAudit } from './consolidation/canonical-audit.mjs';

export { captureCanonicalAudit };

if (process.argv[1] && pathToFileURL(path.resolve(process.argv[1])).href === import.meta.url) {
    const { values } = parseArgs({ options: { output: { type: 'string' },
        'skip-measurement': { type: 'boolean' }, help: { type: 'boolean' } }, strict: true });
    if (values.help) process.stdout.write('Usage: node scripts/audit-consolidation.mjs [--output <new-directory>] [--skip-measurement]\nCapture current canonical data offline. Existing captures are never overwritten.\n');
    else {
        const { report } = await captureCanonicalAudit({ output: values.output, measure: !values['skip-measurement'] });
        process.stdout.write(JSON.stringify(report, null, 2) + '\n');
    }
}

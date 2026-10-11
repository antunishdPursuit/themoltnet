import { readFile, writeFile } from 'node:fs/promises';

const path = 'pnpm-workspace.yaml';
const source = await readFile(path, 'utf8');
let inExclusions = false;

const formatted = source
  .split('\n')
  .map((line) => {
    if (/^minimumReleaseAgeExclude:\s*$/.test(line)) {
      inExclusions = true;
    } else if (/^[^\s#-][^:]*:/.test(line)) {
      inExclusions = false;
    }

    if (!inExclusions) return line;

    // Renovate writes new security exceptions with double quotes. Prettier's
    // singleQuote setting expects single quotes for these plain package specs.
    const match = line.match(/^(\s+- )"([^"']+)"(\s*)$/);
    return match ? `${match[1]}'${match[2]}'${match[3]}` : line;
  })
  .join('\n');

if (formatted !== source) await writeFile(path, formatted);

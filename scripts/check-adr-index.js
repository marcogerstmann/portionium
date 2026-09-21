// The index in docs/adr/README.md is hand written, so it can drift from the records it lists.
// This is the check that stops that, and it also catches a deleted record, which is what a gap
// in the numbering means.
import { readdir, readFile } from 'node:fs/promises';

const dir = new URL('../docs/adr/', import.meta.url);
const field = (text, name) => text.match(new RegExp(`^${name}:\\s*'?(.*?)'?\\s*$`, 'm'))?.[1];

const files = (await readdir(dir)).filter((f) => /^\d{3}-.*\.md$/.test(f)).sort();
const records = await Promise.all(
  files.map(async (file) => {
    const text = await readFile(new URL(file, dir), 'utf8');
    return {
      file,
      number: file.slice(0, 3),
      title: field(text, 'title'),
      status: field(text, 'status'),
      id: field(text, 'id'),
    };
  }),
);

const index = await readFile(new URL('README.md', dir), 'utf8');
const rows = [
  ...index.matchAll(/^\|\s*\[(\d{3})\]\(\.\/([^)]+)\)\s*\|\s*(.+?)\s*\|\s*(.+?)\s*\|$/gm),
].map(([, number, file, title, status]) => ({ number, file, title, status }));

const problems = [];
records.forEach((record, i) => {
  const expected = String(i + 1).padStart(3, '0');
  if (record.number !== expected)
    problems.push(`${record.file}: numbering jumps, expected ${expected}`);
  if (record.id !== `ADR-${record.number}`)
    problems.push(`${record.file}: frontmatter id is ${record.id}`);

  const row = rows.find((r) => r.file === record.file);
  if (!row) return problems.push(`${record.file}: no row in the index`);
  if (row.title !== record.title)
    problems.push(`${record.file}: index title "${row.title}" is not "${record.title}"`);
  if (row.status !== record.status)
    problems.push(`${record.file}: index status "${row.status}" is not "${record.status}"`);
});
rows
  .filter((row) => !records.some((record) => record.file === row.file))
  .forEach((row) => problems.push(`${row.file}: listed in the index, no such record`));

if (problems.length) {
  console.error(
    `docs/adr/README.md does not match the records:\n${problems.map((p) => `  ${p}`).join('\n')}`,
  );
  process.exit(1);
}
console.log(
  `docs/adr/README.md matches ${records.length} records, numbered 001 to ${records.at(-1).number}.`,
);

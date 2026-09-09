/**
 * The README written into the sync folder, once, on the first pass.
 *
 * It is never rewritten. Once it is on disk it is the person's file — a README that reappears
 * every fifteen minutes is a README nobody reads.
 *
 * Two things in here are not decoration. The inbox is the only part of this folder someone has to
 * be told about, because it is the only part that does something. And the paragraph about this
 * being a copy outside the account is the honest consequence of the whole feature: erasing the
 * record on the server does not reach these files.
 */
export function folderReadme(opts: { record: string; profile: string }): string {
  const agent = opts.profile === "default" ? "coen" : `coen agent ${opts.profile}`;
  return `# Your record, as files

Coen keeps this folder in step with ${opts.record}. Every file here was written by
\`${agent} sync\`.

## The files are read-only

That is on purpose. This is a copy. Editing a copy does not change the record, so a mirror you
can edit is one that quietly disagrees with the thing it mirrors.

If you edit one anyway — make it writable, change it — the next pass will not throw your work
away. It copies what you wrote to \`.coen-sync/edited/\` first, then puts the record's version
back.

To change something for real, use the CLI or the web app. Then it shows up here.

## \`new/\` is yours

It is the one writable directory, and it is how you write.

    nano ${"~"}/journal/new/tuesday.md

Save it. The next pass reads it, checks it in — the same as \`coen pulse\` or typing into Home —
files it under \`journal/\`, and deletes the file you wrote. Your words are in the mirror before
the original goes; nothing is deleted until it exists somewhere else.

If the check-in fails, the file stays where it is and a \`.error\` file appears next to it saying
why. It will try again on the next pass.

One file is one check-in. There is nothing to learn: no front matter, no header, no format. Write
the way you would write anywhere.

## What is here

| | |
| --- | --- |
| \`journal/\` | everything you have written, by year and month, with its read |
| \`habits/\` | what you track, and every tick, by month |
| \`decisions/\` | decisions, with the reasoning |
| \`insights/\` | realizations |
| \`reminders.md\` | what you told yourself |
| \`reports/\` | the daily activity reports |
| \`reads/\` | the emotional read, one file per month |
| \`metrics/\` | numbers that are not habits |
| \`life-model.md\` | people and things that recur in your writing |
| \`your-words.md\` | the links you drew yourself |
| \`profile.md\` | your profile, and the rolling baseline |

\`.coen-sync/\` is Coen's own bookkeeping for this folder. Leave it alone and it will leave you
alone.

## This copy is outside your account

Worth saying plainly. These files are on your disk. If you erase your account, the record on the
server goes; this folder does not. Deleting it is yours to do.

If you put this folder in git — \`${agent} git-sync\` — it goes wherever you push it. Git also
does not record the read-only bit, so anywhere else this is cloned, these files will be writable.

## Turning it off

    ${agent} sync --off

The files stay. Nothing else happens to them.
`;
}

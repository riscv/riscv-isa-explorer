#!/usr/bin/env node
/*
 * AI summaries of each landed series' review discussion (#649), written into
 * src/upstream-history.json after scripts/sync_upstream_history.mjs.
 *
 *   node scripts/summarize_upstream_history.mjs            # new or changed series only
 *   node scripts/summarize_upstream_history.mjs --dry-run  # say what would be sent, send nothing
 *   node scripts/summarize_upstream_history.mjs --force V  # rewrite these extensions' summaries
 *
 * The model is Claude Haiku 5.5 on Amazon Bedrock, through the AWS CLI with
 * whatever credentials it finds (the weekly workflow assumes an OIDC role).
 * UPSTREAM_MODEL names the model or inference profile to call; the data only
 * ever records the model's name, never the identifier, which can carry an
 * account number.
 *
 * Facts stay out of the model's hands: dates, people and counts come from the
 * sync. The model writes one paragraph from the numbered messages, and each
 * sentence must cite the messages it rests on. checkCitations() rejects a
 * summary with a citation to a message that does not exist or a sentence
 * without one; after one retry, a series that still fails keeps no summary
 * rather than an unchecked one. A series whose messages have not changed
 * (same input hash) is not sent again.
 */
import { execFileSync } from 'node:child_process';
import crypto from 'node:crypto';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import {
  BOT,
  checkCitations,
  isReplySubject,
  ownWords,
  part,
  versionLabel,
} from './upstream-history-lib.mjs';
import { DATA, thread, writeData } from './sync_upstream_history.mjs';

export const MODEL_NAME = 'Claude Haiku 5.5';
const MODEL = process.env.UPSTREAM_MODEL || 'us.anthropic.claude-haiku-5-5';
const REGION = process.env.AWS_REGION || 'us-east-1';
// Bumped when the prompt or the message selection changes, so every summary
// is rewritten once.
export const PROMPT_VERSION = 1;
const CHUNK_CHARS = 300_000; // about 75k tokens, under the model's 100k price step

export const SYSTEM = `You summarise Linux kernel patch review threads for a public reference site about RISC-V ISA extensions. Use only what the numbered messages say: no background knowledge, no speculation, and no judgement of people or of how fast anyone worked.`;

export function instructions(extensions, series, scope = '') {
  return `Extensions: ${extensions.join(', ')}
Patch series that landed: "${series.title}"
Versions: ${series.versions.map((v) => `${v.version} ${v.date} (${v.author})`).join('; ')}
${scope}
Below are the numbered messages from the review threads: cover letters and replies, with quoted text and diffs removed. Each begins "[n] date | author | version | subject".

Write one paragraph of 4 to 6 plain sentences for a reader who knows RISC-V but has not read the threads: what the series does, the main points reviewers raised, how they were settled, and how the series changed across versions. End every sentence with the numbers of the messages it comes from, like [3, 17]. Leave out style nits, rebases, typos and thanks. Answer with the paragraph only.`;
}

/** The numbered messages a summary is written from: cover letters and replies, oldest first. */
export async function messagesFor(series, readThread = thread) {
  const seen = new Set();
  const out = [];
  for (const v of series.versions) {
    for (const m of await readThread(v.href)) {
      if (!m.messageId || seen.has(m.messageId) || BOT.test(m.from)) continue;
      seen.add(m.messageId);
      const reply = isReplySubject(m.subject);
      if (!reply && part(m.subject)[0] !== 0) continue; // patches themselves are not discussion
      const text = ownWords(m.body);
      if (text.split(/\s+/).length < 4) continue; // a bare ack carries nothing to summarise
      // The message's own subject says which version it answers; the thread
      // it came in with can be an earlier version's (v2 sent in reply to v1).
      out.push({ ...m, version: versionLabel(m.subject) ?? v.version, text });
    }
  }
  out.sort((a, b) => a.date - b.date);
  out.forEach((m, i) => {
    m.n = i + 1;
  });
  return out;
}

const render = (m) =>
  `[${m.n}] ${m.date.toISOString().slice(0, 10)} | ${m.from.replace(/\s*<.*>/, '')} | ${m.version} | ${m.subject}\n${m.text}\n`;

/** Everything the model is shown, so a summary is rewritten when any of it changes. */
export function inputHash(extensions, series, messages) {
  return crypto
    .createHash('sha256')
    .update(JSON.stringify({ v: PROMPT_VERSION, model: MODEL_NAME, system: SYSTEM }))
    .update(instructions(extensions, series))
    .update(messages.map(render).join('\n'))
    .digest('hex')
    .slice(0, 16);
}

/** One Converse call through the AWS CLI; returns the text. */
function converse(user) {
  const request = {
    modelId: MODEL,
    system: [{ text: SYSTEM }],
    messages: [{ role: 'user', content: [{ text: user }] }],
    inferenceConfig: { maxTokens: 1200 },
    // Haiku 5.5 thinks by default, and the thinking would eat the budget.
    additionalModelRequestFields: { thinking: { type: 'disabled' } },
  };
  const file = path.join(
    fs.mkdtempSync(path.join(os.tmpdir(), 'upstream-summary-')),
    'request.json',
  );
  fs.writeFileSync(file, JSON.stringify(request));
  const out = JSON.parse(
    execFileSync(
      'aws',
      [
        'bedrock-runtime',
        'converse',
        '--region',
        REGION,
        '--cli-input-json',
        `file://${file}`,
        '--cli-read-timeout',
        '600',
        '--output',
        'json',
      ],
      { maxBuffer: 1 << 26, encoding: 'utf8' },
    ),
  );
  fs.rmSync(path.dirname(file), { recursive: true, force: true });
  return {
    text: out.output.message.content
      .map((c) => c.text ?? '')
      .join('')
      .trim(),
    usage: out.usage,
  };
}

/** Every citation in a part's summary names a message of that part, and every sentence cites. */
function withinChunk(text, chunk) {
  const check = checkCitations(text, chunk.at(-1).n);
  const shown = new Set(chunk.map((m) => m.n));
  return check.ok && check.cited.every((n) => shown.has(n));
}

/** A checked summary of one series, or null when none passes. `call` is injected by the tests. */
export async function summarize(extensions, series, messages, call = converse) {
  const chunks = [];
  let current = [];
  let size = 0;
  for (const m of messages) {
    const r = render(m);
    if (size + r.length > CHUNK_CHARS && current.length) {
      chunks.push(current);
      current = [];
      size = 0;
    }
    current.push(m);
    size += r.length;
  }
  if (current.length) chunks.push(current);
  if (!chunks.length) return null;

  const usage = { input: 0, output: 0, calls: 0 };
  const ask = (user) => {
    const r = call(user);
    usage.input += r.usage?.inputTokens ?? 0;
    usage.output += r.usage?.outputTokens ?? 0;
    usage.calls += 1;
    return r.text;
  };
  for (let attempt = 0; attempt < 2; attempt += 1) {
    const reminder = attempt
      ? '\nYour previous answer had a sentence without citations or a citation to a message that does not exist. Every sentence must end with [n] citations to messages below.'
      : '';
    let text;
    let allowed = null;
    if (chunks.length === 1) {
      text = ask(
        `${instructions(extensions, series)}${reminder}\n\n${chunks[0].map(render).join('\n')}`,
      );
    } else {
      // Each part may cite only the messages it was shown: a part citing
      // [1] from messages 20 to 30 would pass the final check, since [1]
      // exists, while resting on nothing. A part that fails twice drops the
      // summary.
      const parts = [];
      for (const [i, chunk] of chunks.entries()) {
        const prompt = `${instructions(extensions, series, `This is part ${i + 1} of ${chunks.length} of the discussion (messages ${chunk[0].n} to ${chunk.at(-1).n}).`)}${reminder}\n\n${chunk.map(render).join('\n')}`;
        let partial = null;
        for (let tryPart = 0; tryPart < 2 && partial === null; tryPart += 1) {
          const answer = ask(prompt);
          if (withinChunk(answer, chunk)) partial = answer;
        }
        if (partial === null) return null;
        parts.push(partial);
      }
      // The merge sees only the parts, so it may cite only what they cited.
      allowed = new Set(parts.flatMap((p) => checkCitations(p, messages.length).cited));
      text = ask(
        `${instructions(extensions, series, 'The discussion was summarised in parts; merge these partial summaries into one paragraph, keeping the message citations exactly as given.')}${reminder}\n\n${parts.map((p, i) => `Part ${i + 1}: ${p}`).join('\n')}`,
      );
    }
    const check = checkCitations(text, messages.length);
    if (check.ok && (!allowed || check.cited.every((n) => allowed.has(n)))) {
      const byN = new Map(messages.map((m) => [m.n, m]));
      return {
        summary: text,
        sources: check.cited.map((n) => ({
          n,
          date: byN.get(n).date.toISOString().slice(0, 10),
          from: byN
            .get(n)
            .from.replace(/\s*<.*>/, '')
            .replace(/^"|"$/g, ''),
          url: `https://lore.kernel.org/all/${encodeURIComponent(byN.get(n).messageId)}/`,
        })),
        usage,
      };
    }
  }
  return null;
}

export async function main(argv = process.argv.slice(2)) {
  const dryRun = argv.includes('--dry-run');
  const force = argv.includes('--force');
  const only = new Set(argv.filter((a) => !a.startsWith('--')));
  const data = JSON.parse(fs.readFileSync(DATA, 'utf8'));
  const members = new Map();
  for (const [id, e] of Object.entries(data.extensions)) {
    if (!members.has(e.series)) members.set(e.series, []);
    members.get(e.series).push(id);
  }
  const totals = { written: 0, kept: 0, failed: [], input: 0, output: 0, calls: 0 };
  for (const [key, series] of Object.entries(data.series)) {
    const ids = members.get(key) ?? [];
    if (only.size && !ids.some((id) => only.has(id))) continue;
    const messages = await messagesFor(series);
    const hash = inputHash(ids, series, messages);
    if (!force && series.ai?.inputHash === hash) {
      totals.kept += 1;
      continue;
    }
    if (dryRun) {
      const chars = messages.reduce((n, m) => n + render(m).length, 0);
      console.log(
        `would summarise ${ids.join(', ')}: ${messages.length} messages, ~${Math.round(chars / 4000)}k tokens`,
      );
      continue;
    }
    const result = await summarize(ids, series, messages);
    if (!result) {
      // Keep nothing rather than an unchecked summary; the dialog shows the facts alone.
      series.ai = null;
      totals.failed.push(ids.join('/'));
      continue;
    }
    series.ai = {
      model: MODEL_NAME,
      generated: new Date().toISOString().slice(0, 10),
      inputHash: hash,
      summary: result.summary,
      sources: result.sources,
    };
    totals.written += 1;
    totals.input += result.usage.input;
    totals.output += result.usage.output;
    totals.calls += result.usage.calls;
    writeData(data); // after each, so an interrupted run keeps what it paid for
  }
  if (!dryRun) writeData(data);
  console.log(
    `summaries written ${totals.written}, unchanged ${totals.kept}, failed the citation check ${totals.failed.length}${totals.failed.length ? ` (${totals.failed.join(', ')})` : ''}; ${totals.calls} calls, ${totals.input} tokens in, ${totals.output} out`,
  );
  return totals;
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  main().catch((error) => {
    console.error(error);
    process.exit(2);
  });
}

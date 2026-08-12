import { createHash } from 'node:crypto';

export interface InboundMessage {
  id: string;
  received_at: string;
  channel: string;
  from_name: string;
  from_org: string;
  subject: string;
  body: string;
}

/**
 * `from_org` sentinels. The brief is explicit that these are not real org names,
 * so we strip them before the model ever sees the field — otherwise the prompt
 * literally reads `Organisation: (unknown)` and the model treats "(unknown)" as
 * a company, which is how you get a vendor label on a private individual.
 */
const ORG_SENTINELS = new Set(['(individual)', '(unknown)', '(none)', 'n/a', 'unknown', '']);

/** Markers that a body is transport wreckage rather than a human message. */
const CORRUPTION_MARKERS = [
  '=?utf-8?', // undecoded MIME encoded-word in a header
  '=?iso-8859', //          ""
  'content-type: multipart',
  '--- forwarded message truncated ---',
  'boundary=',
];

export interface NormalizedMessage {
  id: string;
  received_at: string;
  channel: string;
  /** null when absent or a sentinel — never the sentinel string itself. */
  from_name: string | null;
  from_org: string | null;
  subject: string | null;
  body: string;
  /** Characters removed / replaced during cleaning, for display and for the rationale. */
  cleaned: string[];
  /** True when there is too little human-authored signal to be worth an LLM call's trust. */
  lowSignal: boolean;
  /** Why it was judged low-signal. Empty when it wasn't. */
  lowSignalReasons: string[];
}

function blankToNull(v: string | undefined | null): string | null {
  if (v == null) return null;
  const t = v.trim();
  return t.length === 0 ? null : t;
}

/**
 * Strip characters that are either meaningless to the model or actively hostile
 * to the storage layer.
 *
 * The NUL case is not hypothetical: `inb-011` contains real U+0000 bytes, and
 * Postgres rejects them in `text` columns with
 * `unsupported Unicode escape sequence`. If we passed the raw body through, the
 * insert would fail *after* we had already paid for the LLM call. So cleaning
 * happens before both the API call and the write.
 */
function cleanText(raw: string): { text: string; cleaned: string[] } {
  const cleaned: string[] = [];
  let text = raw;

  const NUL = /\u0000/g;
  const REPLACEMENT = /\uFFFD/g;
  // C0 controls except tab, LF and CR, plus DEL.
  const OTHER_CONTROLS = /[\u0001-\u0008\u000B\u000C\u000E-\u001F\u007F]/g;

  if (NUL.test(text)) {
    cleaned.push('NUL bytes (U+0000) - rejected outright by Postgres text columns');
    text = text.replace(NUL, '');
  }
  if (REPLACEMENT.test(text)) {
    cleaned.push('U+FFFD replacement characters - evidence of an earlier decode failure');
    text = text.replace(REPLACEMENT, '');
  }
  if (OTHER_CONTROLS.test(text)) {
    cleaned.push('other C0 control characters');
    text = text.replace(OTHER_CONTROLS, '');
  }

  text = text.replace(/[ \t]+/g, ' ').trim();
  return { text, cleaned };
}

/** Letters and digits only — the crude but effective measure of "is there a message here". */
function alnumCount(s: string): number {
  return (s.match(/[\p{L}\p{N}]/gu) ?? []).length;
}

export function normalize(msg: InboundMessage): NormalizedMessage {
  const { text: body, cleaned } = cleanText(msg.body ?? '');
  const { text: subjectText } = cleanText(msg.subject ?? '');
  const { text: nameText } = cleanText(msg.from_name ?? '');

  const rawOrg = (msg.from_org ?? '').trim();
  const from_org = ORG_SENTINELS.has(rawOrg.toLowerCase()) ? null : blankToNull(rawOrg);

  // A name that is itself a broken MIME encoded-word is not a name.
  const nameLooksCorrupt = /=\?[\w-]+\?[bq]\?/i.test(nameText);
  const from_name = nameLooksCorrupt ? null : blankToNull(nameText);

  const subject = blankToNull(subjectText);

  const lowSignalReasons: string[] = [];
  const bodyChars = alnumCount(body);
  const subjectChars = alnumCount(subject ?? '');

  if (bodyChars + subjectChars < 15) {
    lowSignalReasons.push(`only ${bodyChars + subjectChars} alphanumeric characters in subject+body`);
  }
  const lowerBody = body.toLowerCase();
  const hitMarkers = CORRUPTION_MARKERS.filter((m) => lowerBody.includes(m));
  if (hitMarkers.length > 0) {
    lowSignalReasons.push(`transport corruption markers present (${hitMarkers[0]})`);
  }
  if (nameLooksCorrupt) {
    lowSignalReasons.push('sender name is an undecoded MIME encoded-word');
  }

  return {
    id: msg.id,
    received_at: msg.received_at,
    channel: blankToNull(msg.channel) ?? 'unknown',
    from_name,
    from_org,
    subject,
    body,
    cleaned,
    lowSignal: lowSignalReasons.length > 0,
    lowSignalReasons,
  };
}

/**
 * Cache key. Deliberately includes the prompt version and model, so that editing
 * the prompt or switching models correctly invalidates every cached result
 * instead of silently serving answers from the old prompt.
 */
export function inputHash(msg: NormalizedMessage, promptVersion: string, model: string): string {
  return createHash('sha256')
    .update(
      JSON.stringify([
        msg.id,
        msg.channel,
        msg.from_name,
        msg.from_org,
        msg.subject,
        msg.body,
        promptVersion,
        model,
      ]),
    )
    .digest('hex')
    .slice(0, 32);
}

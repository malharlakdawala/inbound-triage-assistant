/**
 * The taxonomy is the product decision in this tool, so it lives in one file and
 * everything else imports from here: the Zod validator, the prompt builder, the
 * eval harness, and the UI legend.
 *
 * Categories are chosen by *who acts on the message*, not by topic. A category
 * that nobody routes differently doesn't earn its place — that is the test each
 * one below has to pass.
 */

export const CATEGORIES = [
  'prospect',
  'existing_client',
  'vendor',
  'recruiter',
  'partner_referral',
  'noise',
  'unclear',
] as const;

export type Category = (typeof CATEGORIES)[number];

export const PRIORITIES = ['high', 'medium', 'low'] as const;
export type Priority = (typeof PRIORITIES)[number];

/** Routing destination per category — this is what justifies the split. */
export const CATEGORY_ROUTING: Record<Category, string> = {
  prospect: 'Advisor / business development',
  existing_client: 'Client service team',
  vendor: 'Operations (usually declined)',
  recruiter: 'No action — informational',
  partner_referral: 'Partnerships / principal',
  noise: 'No action — archive',
  unclear: 'Human review queue',
};

/** Shown in the UI legend and inlined into the prompt so both stay in sync. */
export const CATEGORY_DEFINITIONS: Record<Category, string> = {
  prospect: 'A potential new client enquiring about services for themselves or their family.',
  existing_client: 'A current client making a request, asking a question, or raising a complaint.',
  vendor: 'Someone selling a product or service to the firm.',
  recruiter: 'Talent or recruiting outreach, including candidate and role pitches.',
  partner_referral:
    'Another firm or professional proposing a referral or partnership arrangement, or introducing someone.',
  noise: 'Automated mail, newsletters, marketing blasts — nothing for a human to action.',
  unclear:
    'Not enough signal to place the message in any other category. Use this instead of guessing.',
};

/**
 * Priority is defined by explicit rules rather than a vibe, so that two people
 * (or a person and the model) can disagree about a message and resolve it by
 * pointing at a rule.
 *
 * Deliberate consequence: urgency and value are separate axes. A large prospect
 * who says "no rush" is low PRIORITY and still high VALUE — priority orders the
 * queue, it does not score the opportunity.
 */
export const PRIORITY_RULES: Record<Priority, string> = {
  high: 'Money or a mandate is at stake right now, the sender states a deadline within ~48 hours, or an existing client is unhappy.',
  medium: 'A real opportunity or a genuine client request, but with no hard deadline.',
  low: 'No action needed, automated, or the sender explicitly says it is not urgent.',
};

/**
 * Categories we never auto-action, regardless of what the model returns.
 * `unclear` always goes to a human; `noise` is safe to archive.
 */
export const NEEDS_HUMAN: readonly Category[] = ['unclear'];

/** Below this, the row is flagged for review even if the category looks confident. */
export const CONFIDENCE_REVIEW_THRESHOLD = 0.6;

// The kinds of confidential document SealedPaper protects, with sensible defaults for each.
export const CATEGORIES = {
  research: {
    label: 'Research and R&D',
    short: 'Research',
    example: 'Phase III trial results before publication, a patent filing, unpublished results',
    k: 2, window: 60, copies: 1,
  },
  financial: {
    label: 'Financial results',
    short: 'Financial',
    example: 'Quarterly results before the stock-exchange filing, earnings guidance',
    k: 2, window: 60, copies: 1,
  },
  board: {
    label: 'Board and M&A',
    short: 'Board',
    example: 'Board deck, merger or acquisition plan, layoff plan',
    k: 3, window: 180, copies: 1,
  },
  legal: {
    label: 'Legal',
    short: 'Legal',
    example: 'Court judgment before pronouncement, settlement terms',
    k: 2, window: 60, copies: 2,
  },
  government: {
    label: 'Government and tenders',
    short: 'Government',
    example: 'Tender bids before opening, budget or policy drafts',
    k: 3, window: 60, copies: 2,
  },
  exam: {
    label: 'Exam paper (finished file)',
    short: 'Exam',
    example: 'A finished question paper. For a pool with per-centre copies, use Exam papers instead.',
    k: 2, window: 60, copies: 2,
  },
  other: { label: 'Other confidential document', short: 'Other', example: 'Anything that must stay sealed until a set time', k: 2, window: 60, copies: 2 },
};

export const categoryLabel = (c) => CATEGORIES[c]?.short || 'Document';

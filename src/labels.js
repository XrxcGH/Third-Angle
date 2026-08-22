'use strict';

/*
 * Human labels for every stored enum, and the capitalisation rules.
 *
 * The database stores machine values: 'case-study', 'in-progress', 'cad_render',
 * 'third-party'. Before this file each template printed them with an ad hoc
 * .replace(), so the same value appeared as "case-study" in one table, "case
 * study" in another and "Case Study" in a third, and a dropdown offered
 * "original, I made or shot this" next to "Public". One map, one answer.
 *
 * THE RULE, stated once so it can be applied without judgement each time:
 *
 *   Title Case   anything that names something: headings, navigation, button
 *                and link labels, table headers, form labels, dropdown options,
 *                status badges, album and album-like titles.
 *
 *   Sentence case  anything that reads as a sentence: body prose, hints under
 *                a field, empty states, flash messages, alt text, placeholders.
 *
 *   ALL CAPS     never typed. Where small caps are wanted, the uppercase comes
 *                from `text-transform` in CSS, so the source stays Title Case
 *                and stays searchable, translatable and readable in a diff.
 *
 * Title Case here is the AP form: capitalise the first and last word and every
 * word of four letters or more, and leave short articles, conjunctions and
 * prepositions lowercase in between. "Open in a New Tab", not "Open In A New
 * Tab", because the second reads as a shout.
 */

/* Lowercase inside a title unless first or last. Four letters or fewer, and
   only the closed classes: articles, coordinating conjunctions, prepositions. */
const MINOR = new Set([
  'a', 'an', 'and', 'as', 'at', 'but', 'by', 'for', 'in', 'nor', 'of', 'off',
  'on', 'or', 'per', 'so', 'the', 'to', 'up', 'via', 'vs', 'with', 'from',
  'into', 'over', 'than', 'that', 'yet',
]);

/* Words whose casing is theirs, not ours. */
const EXACT = new Map(Object.entries({
  cad: 'CAD', pdf: 'PDF', cv: 'CV', url: 'URL', uri: 'URI', id: 'ID',
  ip: 'IP', smtp: 'SMTP', totp: 'TOTP', csv: 'CSV', ucla: 'UCLA',
  frc: 'FRC', ftc: 'FTC', fll: 'FLL', ap: 'AP', asme: 'ASME',
  github: 'GitHub', linkedin: 'LinkedIn', wrrf: 'WRRF', led: 'LED',
  can: 'CAN', usb: 'USB', api: 'API', html: 'HTML', css: 'CSS',
  matlab: 'MATLAB', mse: 'MSE', mae: 'MAE', math: 'MATH',
}));

/**
 * AP-style title case.
 *
 * Deliberately conservative: a word that already contains an interior capital
 * is left exactly as it is, so "iD Tech", "PhotonVision" and "McMaster" survive
 * a pass through this function rather than being flattened to "Id Tech".
 */
function titleCase(input) {
  const str = String(input == null ? '' : input).trim();
  if (!str) return '';
  const words = str.split(/(\s+|[/-])/);
  const isWord = (w) => /[A-Za-z0-9]/.test(w);
  const realWords = words.filter(isWord);
  let seen = 0;

  return words.map((w) => {
    if (!isWord(w)) return w;
    seen += 1;
    const first = seen === 1;
    const last = seen === realWords.length;
    const bare = w.toLowerCase().replace(/[^a-z0-9]/g, '');

    // An interior capital means the writer meant it. Checked BEFORE the
    // exact-case map, or "iD Tech" is flattened to "ID Tech" by the entry that
    // exists to turn the word "id" into "ID".
    // An all-caps word, or a plural acronym such as PDFs or IDs, where the
    // only lowercase letter is the trailing s.
    if (/[a-z][A-Z]/.test(w) || /^[A-Z]{2,}s?$/.test(w)) return w;
    if (EXACT.has(bare)) return w.replace(/[A-Za-z0-9]+/, EXACT.get(bare));
    if (!first && !last && MINOR.has(bare)) return w.toLowerCase();
    return w.charAt(0).toUpperCase() + w.slice(1).toLowerCase();
  }).join('');
}

/** A stored enum value rendered for a reader. Falls back to title casing it. */
function label(group, value) {
  const map = LABELS[group];
  const key = String(value == null ? '' : value);
  if (map && key in map) return map[key];
  return titleCase(key.replace(/[_-]+/g, ' '));
}

const LABELS = {
  /* project.tier */
  tier: {
    note: 'Note',
    build: 'Build',
    'case-study': 'Case Study',
  },
  /* project.status */
  status: {
    shipped: 'Shipped',
    competed: 'Competed',
    'in-progress': 'In Progress',
    specification: 'Specification',
    archived: 'Archived',
  },
  /* project_facet.weight */
  weight: {
    primary: 'Primary',
    significant: 'Significant',
    supporting: 'Supporting',
  },
  /* media.kind */
  mediaKind: {
    photo: 'Photo',
    cad_render: 'CAD Render',
    drawing: 'Drawing',
    schematic: 'Schematic',
    harness_photo: 'Harness Photo',
    plot: 'Plot',
    video: 'Video',
    other: 'Other',
  },
  /*
   * media.origin. The long form is kept, because the difference between these
   * three is the whole publish gate and a one word label would not carry it.
   * Sentence case after the leading term, because it is a sentence.
   */
  origin: {
    original: 'Original, I made or shot this',
    generated: 'Generated, a render or plot from my work',
    'third-party': 'Third Party, someone else made it',
  },
  /* document.visibility */
  visibility: {
    public: 'Public',
    private: 'Private, admin only',
  },
  /* document.doc_role */
  docRole: {
    resume: 'Resume',
    cv: 'CV',
    other: 'Other',
  },
  /* course.status */
  courseStatus: {
    completed: 'Completed',
    'in-progress': 'In Progress',
    planned: 'Planned',
  },
  /* activity.kind */
  activityKind: {
    activity: 'Activity',
    award: 'Award',
    certification: 'Certification',
  },
  /* school.kind */
  schoolKind: {
    university: 'University',
    'high-school': 'High School',
    certification: 'Certification',
  },
  /* message.mail_status */
  mailStatus: {
    sent: 'Sent',
    failed: 'Failed',
    pending: 'Pending',
    off: 'Forwarding Off',
    unconfigured: 'No SMTP',
  },
  /* link.kind */
  linkKind: {
    repo: 'Repository',
    cad: 'CAD',
    document: 'Document',
    video: 'Video',
    demo: 'Demo',
    other: 'Other',
  },
};

module.exports = { titleCase, label, LABELS, MINOR, EXACT };

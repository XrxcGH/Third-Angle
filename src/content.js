'use strict';

/*
 * Editable content.
 *
 * Every fixed string on the public site — headings, ledes, button labels, empty
 * states, the two site-wide images, and the rules between sections — is a slot
 * with a default in this file and an optional override in the database. The
 * templates ask for a slot by key; nothing on a page is a literal any more.
 *
 * Two decisions are load bearing.
 *
 * The default lives in code, not in a seed row. A slot that has never been
 * edited has no row at all, so adding one here needs no migration, deploying a
 * better default reaches every unedited site, and "reset to default" is a
 * DELETE rather than a copy of a string somebody has to keep in step.
 *
 * The key set is closed. An unknown key is a typo that would silently render an
 * empty heading, which is the worst behaviour available: the page still looks
 * deliberate. `c()` throws instead, and a test walks every template and asserts
 * that every key it asks for is registered here, and that every key registered
 * here is asked for somewhere.
 */

const { get, all, run } = require('./db');
const { richText, escapeHtml } = require('./markup');

/* ------------------------------------------------------------------ pages */

/*
 * The dropdown at the top of the editor, in the order the site reads. `route`
 * is what the "View this page" link points at, so every screen in the admin is
 * one click from the thing it changes.
 */
const PAGES = [
  { slug: 'site', label: 'Site-Wide', route: '/', note: 'The header, the footer, and the two images every page can use.' },
  { slug: 'home', label: 'Home', route: '/' },
  { slug: 'work', label: 'Work Index', route: '/work' },
  { slug: 'project', label: 'Project Page', route: '/work', note: 'The headings shared by every project page.' },
  { slug: 'disciplines', label: 'Disciplines', route: '/disciplines' },
  { slug: 'discipline', label: 'One Discipline', route: '/disciplines', note: 'Shared by all eight discipline pages.' },
  { slug: 'education', label: 'Education', route: '/education' },
  { slug: 'professional', label: 'Professional', route: '/professional' },
  { slug: 'personal', label: 'Personal', route: '/personal' },
  { slug: 'documents', label: 'Documents', route: '/documents' },
  { slug: 'contact', label: 'Contact', route: '/contact' },
  { slug: 'search', label: 'Search', route: '/search' },
  { slug: 'log', label: 'Build Log', route: '/log' },
  { slug: 'now', label: 'Now', route: '/now' },
  { slug: 'attributions', label: 'Attributions', route: '/attributions' },
  { slug: 'errors', label: 'Error Pages', route: '/404', note: 'What a visitor sees when a URL is wrong or something breaks.' },
];

/* ------------------------------------------------------------------ slots */

/*
 * kind decides the control in the admin and the helper a template uses:
 *
 *   line   one line of plain text          c('key')
 *   text   several lines of plain text     c('key')
 *   rich   markup, rendered                cr('key')
 *   image  a media row, or nothing         ci('key')
 *   flag   on or off                       cf('key')
 */
/*
 * A slot nobody should be able to empty by accident. A blank <h1> is not a
 * design choice, it is a page with no name in a search result and nothing for a
 * screen reader to announce. Submitting one of these empty restores the
 * default rather than storing the blank.
 */
/*
 * The name of a field in the editor, from its key.
 *
 * Derived rather than written out, so a slot cannot be added with a key that
 * says one thing and a label that says another. The substitutions are for the
 * handful of abbreviations that are perfectly clear in a key and unreadable in
 * a form: "home.tb3.v" is a fine key and "Tb3 V" is not a field name.
 */
const WORDS = {
  k: 'Label', v: 'Value', cta: 'Button', cta2: 'Second Button',
  li: 'LinkedIn', gh: 'GitHub', pdf: 'PDF', cv: 'CV', og: 'Social Card',
  tb: 'Detail', aria: 'Screen Reader Name', alt: 'Description',
  pre: 'Before', post: 'After', noun: 'Word', sub: 'Second Line',
  url: 'URL', nav: 'Menu', github: 'GitHub', linkedin: 'LinkedIn',
  utc: 'UTC', forword: 'Joining Word', inprogress: 'In Progress',
  meta: 'Search Engine', li_name: 'LinkedIn',
};

function humanLabel(key) {
  const parts = key.split('.').slice(1);
  const tb = key.match(/\.tb(\d)\.(k|v)$/);
  if (tb) return `Fact ${tb[1]} ${tb[2] === 'k' ? 'Label' : 'Value'}`;
  return parts
    .map((p) => WORDS[p] || p.replace(/-/g, ' ').replace(/\b\w/g, (ch) => ch.toUpperCase()))
    .join(' ');
}

const REQUIRED = (key) =>
  key.endsWith('.heading') || key.endsWith('.meta.title') || key === 'home.headline';

const SLOTS = [
  /* ---- site-wide ---- */
  ['site.brand.name', 'site', 'line', 'ERIC DEAN', 'Wordmark in the header. Shown exactly as typed.'],
  ['site.brand.sub', 'site', 'line', 'Third Angle', 'The line under the wordmark. Uppercased by the design.'],
  ['site.logo', 'site', 'image', '', 'Replaces the drawn mark in the header. Leave empty for the mark.'],
  ['site.og.image', 'site', 'image', '', 'Fallback social card. Leave empty to keep the generated one.'],
  ['site.footer.line', 'site', 'line', 'Eric J. Dean · Half Moon Bay, CA', 'Left side of the footer.'],
  ['site.github.url', 'site', 'line', 'https://github.com/XrxcGH', 'Linked from the footer and the professional page.'],
  ['site.linkedin.url', 'site', 'line', 'https://linkedin.com/in/edean07', 'Linked from the footer.'],

  /* ---- home ---- */
  /* ---- navigation and the theme control, on every page ---- */
  ['site.nav.work', 'site', 'line', 'Work'],
  ['site.nav.disciplines', 'site', 'line', 'Disciplines'],
  ['site.nav.education', 'site', 'line', 'Education'],
  ['site.nav.professional', 'site', 'line', 'Professional'],
  ['site.nav.personal', 'site', 'line', 'Personal'],
  ['site.nav.documents', 'site', 'line', 'Documents'],
  ['site.nav.log', 'site', 'line', 'Log'],
  ['site.nav.search', 'site', 'line', 'Search'],
  ['site.theme.label', 'site', 'line', 'Colour theme', 'Read out by a screen reader, not shown.'],
  ['site.theme.system', 'site', 'line', 'Auto'],
  ['site.theme.light', 'site', 'line', 'light'],
  ['site.theme.dark', 'site', 'line', 'dark'],
  ['site.mark.alt', 'site', 'line', 'Third angle projection mark', 'Describes the drawn mark for a screen reader.'],
  ['site.footer.github', 'site', 'line', 'GitHub'],
  ['site.footer.linkedin', 'site', 'line', 'LinkedIn'],
  ['site.footer.contact', 'site', 'line', 'Contact'],
  ['site.footer.now', 'site', 'line', 'Now'],
  ['site.footer.feed', 'site', 'line', 'Feed'],
  ['site.footer.attributions', 'site', 'line', 'Attributions'],
  ['site.footer.signin', 'site', 'line', 'Sign In', 'Goes to the admin, which asks for a password unless you are already in.'],
  ['site.updated', 'site', 'line', 'Updated', 'Precedes a date, wherever one is shown.'],
  ['site.home.link', 'site', 'line', 'Home'],

  /* ---- one document ---- */
  ['document.eyebrow', 'documents', 'line', 'Document'],
  ['document.tb.pages', 'documents', 'line', 'Pages'],
  ['document.tb.size', 'documents', 'line', 'Size'],
  ['document.tb.project', 'documents', 'line', 'The project it belongs to'],
  ['document.search.heading', 'documents', 'line', 'Search Inside This Document'],
  ['document.search.label', 'documents', 'line', 'Search inside'],
  ['document.search.button', 'documents', 'line', 'Find'],
  ['document.search.placeholder', 'documents', 'line', 'retention, crimp, inspection'],
  ['document.search.empty', 'documents', 'text', 'No page in this document mentions that.'],
  ['document.back', 'documents', 'line', 'All Documents'],
  ['documents.library.noun', 'documents', 'line', 'Further Document', 'Follows the count, and takes an s when there is more than one.'],

  /* ---- the resume page ---- */
  ['page.contact.cta', 'contact', 'line', 'Get in Touch', 'On the resume page.'],

  /* ---- attributions, the whole body ---- */
  ['attributions.fonts.heading', 'attributions', 'line', 'Typefaces'],
  ['attributions.fonts.body', 'attributions', 'rich',
    'All three are licensed under the SIL Open Font License 1.1, which permits self hosting and requires that the copyright and licence notice travel with the fonts. They are served from this domain rather than a font CDN.'],
  ['attributions.fonts.source', 'attributions', 'line', 'Source'],
  ['attributions.fonts.notice', 'attributions', 'line', 'SIL OFL 1.1 notice'],
  ['attributions.software.heading', 'attributions', 'line', 'Software'],
  ['attributions.software.body', 'attributions', 'rich',
    'Node, Express, and EJS, on SQLite through Node\'s built-in `node:sqlite`. Ordering uses `fractional-indexing` (CC0). Uploads are parsed by `multer` and re-encoded by `sharp`. Search is SQLite FTS5. There is no framework, no build step, and no analytics that sets a cookie.\n\nThe source is public at [github.com/XrxcGH/third-angle](https://github.com/XrxcGH/third-angle).'],
  ['attributions.privacy.heading', 'attributions', 'line', 'Privacy'],
  ['attributions.privacy.body', 'attributions', 'rich',
    'This site sets exactly one cookie, and only if you press the theme control: a preference recording whether you chose light, dark, or your system setting. It holds no identifier and nothing personal, and it exists so the correct theme is in the first response rather than flashing the wrong one at you.\n\nSigning into the admin area sets a session cookie. That is for me, not for you.\n\nThere is no advertising, no third party script, no tracking pixel, and no fingerprinting. Nothing on these pages loads from another domain, which is also why the fonts are self hosted. Server logs record ordinary request data and are not used to build a profile of anyone.'],
  ['attributions.method.heading', 'attributions', 'line', 'How I Work'],
  ['attributions.method.body', 'attributions', 'rich',
    'Parts of this site were built with AI assistance, working from a written specification rather than a prompt. The order was: decide the architecture, write the design rules down, then generate against them, then review and test by hand.\n\nThe verification is the part worth pointing at. The test suite exists because of specific defects found while building, not because a checklist asked for tests: a de-emphasis state that met the design brief and failed WCAG contrast while looking fine; a search query of `C++` that matched every row in the database; a single malformed cookie that returned a server error on every page; and a content security policy that silently blocked the site\'s own layout. Each of those is now a test that fails if it comes back.\n\nThe commit history is public if you want to check any of that.'],

  /* ---- small labels that carry a count or a date ---- */
  ['site.nav.aria', 'site', 'line', 'Main', 'Names the navigation for a screen reader.'],
  ['document.page.noun', 'documents', 'line', 'page', 'As in "3 pages mention".'],
  ['document.mention', 'documents', 'line', 'mention'],
  ['document.page.tag', 'documents', 'line', 'PAGE', 'Beside each result. Shown as typed.'],
  ['documents.indexed', 'documents', 'line', 'of pages indexed', 'Follows two numbers.'],
  ['documents.pdf.aria', 'documents', 'line', 'rendered in the page',
    'Follows the document title, for a screen reader.'],
  ['personal.photograph.noun', 'personal', 'line', 'photograph', 'Follows the count.'],
  ['professional.repos.all.pre', 'professional', 'line', 'All', 'Precedes the repository count.'],
  ['professional.repos.utc', 'professional', 'line', 'Pacific'],
  ['search.results.forword', 'search', 'line', 'for', 'Between the count and the query.'],
  ['work.status.of', 'work', 'line', 'of', 'As in "3 of 8 match".'],
  ['work.status.match', 'work', 'line', 'match'],
  ['work.status.projects', 'work', 'line', 'projects'],
  ['discipline.noun', 'discipline', 'line', 'project', 'Takes an s when there is more than one.'],
  ['project.evidence.noun', 'project', 'line', 'artefact'],
  ['project.more', 'project', 'line', 'More', 'As in "More Electrical".'],
  ['search.results.for', 'search', 'line', 'result', 'Takes an s, then "for" and the query.'],
  ['search.results.corrected', 'search', 'line', 'showing results for'],
  ['search.results.near', 'search', 'line', 'showing near matches'],
  ['professional.repo.stars', 'professional', 'line', 'star'],
  ['professional.repo.forks', 'professional', 'line', 'fork'],
  ['professional.repo.pushed', 'professional', 'line', 'Pushed'],
  ['professional.repo.fork', 'professional', 'line', 'Fork'],
  ['professional.repo.archived', 'professional', 'line', 'Archived'],
  ['professional.repos.fetched', 'professional', 'line', 'Fetched'],
  ['professional.repos.refreshing', 'professional', 'line', 'refreshing'],
  ['errors.back.work', 'errors', 'line', 'All Work'],
  ['contact.back.work', 'contact', 'line', 'Back to the Work'],
  ['contact.note.pre', 'contact', 'line', 'If you would rather not use a form,',
    'The word LinkedIn follows, as a link.'],
  ['contact.note.post', 'contact', 'line', 'works too.'],

  ['home.eyebrow', 'home', 'line', 'Mechanical · Electrical · Controls · Software'],
  ['home.headline', 'home', 'text',
    'I build the machine, wire it, write the code that runs it, and the document that explains it.'],
  ['home.lede', 'home', 'text',
    'Mechanical engineering at UCLA. Four seasons of FIRST Robotics Competition, first as a founding team captain, and now as a mentor. Currently interning at the Western Region Robotics Forum and founding Groundwork Robotics.'],
  ['home.tb1.k', 'home', 'line', 'Discipline'],
  ['home.tb1.v', 'home', 'line', 'Mechanical Engineering'],
  ['home.tb2.k', 'home', 'line', 'School'],
  ['home.tb2.v', 'home', 'line', 'UCLA, BS 2029'],
  ['home.tb3.k', 'home', 'line', 'Based'],
  ['home.tb3.v', 'home', 'line', 'Half Moon Bay, CA'],
  ['home.tb4.k', 'home', 'line', 'Seeking'],
  ['home.tb4.v', 'home', 'line', 'Summer 2027 Internship'],
  ['home.tb5.k', 'home', 'line', 'Code'],
  ['home.tb5.v', 'home', 'line', 'github.com/XrxcGH'],
  ['home.disciplines.rule', 'home', 'flag', '1', 'The dividing line above this section.'],
  ['home.disciplines.eyebrow', 'home', 'line', 'Disciplines'],
  ['home.disciplines.heading', 'home', 'line', 'One Record, Several Projections'],
  ['home.disciplines.body', 'home', 'rich',
    'A competition robot is mechanical, electrical, controls, and software at the same time. Rather than splitting one project across several pages, each carries weighted disciplines and opens with a different sentence depending on which door you came through.'],
  ['home.work.rule', 'home', 'flag', '1', 'The dividing line above this section.'],
  ['home.work.eyebrow', 'home', 'line', 'Selected Work'],
  ['home.work.heading', 'home', 'line', 'Work'],
  ['home.work.link', 'home', 'line', 'All Work'],
  ['home.now.rule', 'home', 'flag', '1', 'The dividing line above this section.'],
  ['home.now.eyebrow', 'home', 'line', 'Now'],

  /* ---- work index ---- */
  ['work.eyebrow', 'work', 'line', 'Work'],
  ['work.heading', 'work', 'line', 'Everything, Filterable'],
  ['work.lede', 'work', 'text',
    'Selecting a discipline emphasises the work where it applies and de-emphasises the rest. Nothing is hidden, so the breadth stays visible and the page does not jump.'],
  ['work.chip.all', 'work', 'line', 'All'],

  /* ---- one project ---- */
  ['project.breakdown.eyebrow', 'project', 'line', 'Discipline Breakdown'],
  ['project.breakdown.heading', 'project', 'line', 'What This Was, per Discipline'],
  ['project.evidence.eyebrow', 'project', 'line', 'Evidence'],
  ['project.links.eyebrow', 'project', 'line', 'Links'],
  ['project.back', 'project', 'line', 'All Work'],

  /* ---- disciplines ---- */
  ['disciplines.eyebrow', 'disciplines', 'line', 'Disciplines'],
  ['disciplines.heading', 'disciplines', 'line', 'Eight Doors into the Same Body of Work'],
  ['disciplines.lede', 'disciplines', 'text',
    'Each of these is a page a recruiter can be sent directly, not a filter chip that proves nothing.'],

  /* ---- one discipline ---- */
  ['discipline.eyebrow', 'discipline', 'line', 'Discipline'],
  ['discipline.sort', 'discipline', 'line', 'strongest first', 'Follows the project count, as in "3 projects, strongest first".'],
  ['discipline.empty', 'discipline', 'line', 'Nothing published here yet.'],
  ['discipline.back', 'discipline', 'line', 'All Disciplines'],

  /* ---- education ---- */
  ['education.eyebrow', 'education', 'line', 'Education'],
  ['education.heading', 'education', 'line', 'Every Class, and Where It Stands'],
  ['education.lede', 'education', 'text',
    'Completed and in progress are different claims, so they are labelled separately rather than merged into one list of subjects. Every row here is editable in the admin, which is why it stays current.'],
  ['education.metric.completed', 'education', 'line', 'Classes Completed'],
  ['education.metric.progress', 'education', 'line', 'In Progress'],
  ['education.metric.planned', 'education', 'line', 'Planned'],
  ['education.metric.schools', 'education', 'line', 'Institutions'],
  ['education.empty', 'education', 'text', 'Nothing recorded here yet. Add an institution in the admin.'],
  ['education.tb.credential', 'education', 'line', 'Credential'],
  ['education.tb.location', 'education', 'line', 'Location'],
  ['education.tb.dates', 'education', 'line', 'Dates'],
  ['education.tb.honours', 'education', 'line', 'Honours'],
  ['education.tb.classes', 'education', 'line', 'Classes'],
  ['education.done', 'education', 'line', 'done', 'As in "9 done, 3 in progress".'],
  ['education.inprogress', 'education', 'line', 'in progress'],
  ['education.coursework', 'education', 'line', 'Coursework'],
  ['education.sort.label', 'education', 'line', 'Sort By'],
  ['education.sort.name', 'education', 'line', 'Name'],
  ['education.sort.term', 'education', 'line', 'Term, Newest First'],
  ['education.sort.apply', 'education', 'line', 'Apply'],
  ['education.activities', 'education', 'line', 'Activities'],
  ['education.awards', 'education', 'line', 'Awards and Certifications'],
  ['education.unattached.eyebrow', 'education', 'line', 'Beyond the Classroom'],
  ['education.unattached.heading', 'education', 'line', 'Mentoring, Volunteering, and Sport'],
  ['education.unattached.awards', 'education', 'line', 'Awards, Medals, and Certifications'],
  ['education.cta.resume', 'education', 'line', 'Read the Resume'],
  ['education.cta.work', 'education', 'line', 'See the Work'],

  /* ---- professional ---- */
  ['professional.eyebrow', 'professional', 'line', 'Professional'],
  ['professional.heading', 'professional', 'line', 'The Public Record'],
  ['professional.lede', 'professional', 'text',
    'Repositories and profile, read here rather than somewhere else. The GitHub data below is fetched by this server and cached, so nothing on this page calls out to anyone while you read it.'],
  ['professional.gh.off', 'professional', 'text',
    'Live GitHub data is switched off in the admin, and nothing has been cached yet.'],
  ['professional.gh.pending', 'professional', 'text',
    'The GitHub data has not been fetched yet. It loads on the next request, or immediately from the admin.'],
  ['professional.gh.heading', 'professional', 'line', 'GitHub', 'Shown only when there is no cached profile.'],
  ['professional.gh.metric.repos', 'professional', 'line', 'Public Repositories'],
  ['professional.gh.metric.stars', 'professional', 'line', 'Stars'],
  ['professional.gh.metric.followers', 'professional', 'line', 'Followers'],
  ['professional.gh.metric.since', 'professional', 'line', 'Since'],
  ['professional.gh.languages', 'professional', 'line', 'Languages by Repository'],
  ['professional.repos.all', 'professional', 'line', 'repositories on GitHub', 'Follows the repository count.'],
  ['professional.li.school.k', 'professional', 'line', 'School'],
  ['professional.li.university.k', 'professional', 'line', 'University'],
  ['professional.li.credential.k', 'professional', 'line', 'Credential'],
  ['professional.li.name', 'professional', 'line', 'LinkedIn'],
  ['professional.li.badge.link', 'professional', 'line', 'View the Full Profile on LinkedIn'],
  ['professional.li.based.k', 'professional', 'line', 'Based'],
  ['professional.li.based.v', 'professional', 'line', 'Half Moon Bay, CA'],
  ['professional.li.seeking.k', 'professional', 'line', 'Seeking'],
  ['professional.li.seeking.v', 'professional', 'line', 'Summer 2027 Internship'],
  ['professional.li.cta', 'professional', 'line', 'Open LinkedIn'],
  ['professional.li.cta2', 'professional', 'line', 'Read the Resume'],
  ['professional.repos.eyebrow', 'professional', 'line', 'Repositories'],
  ['professional.repos.heading', 'professional', 'line', 'Most Recent Work on GitHub'],
  ['professional.repos.note', 'professional', 'text',
    'Most recently pushed first, so this is what is being worked on rather than what other people starred two years ago. Forks and archived repositories sink rather than disappear.'],
  ['professional.contact.eyebrow', 'professional', 'line', 'Contact'],
  ['professional.contact.heading', 'professional', 'line', 'Get in Touch'],
  ['professional.contact.note', 'professional', 'text',
    'This goes straight to my inbox and is kept here as well, so a mail problem never loses a message.'],

  /* ---- personal ---- */
  ['personal.eyebrow', 'personal', 'line', 'Personal'],
  ['personal.heading', 'personal', 'line', 'Beyond the Bench'],
  ['personal.lede', 'personal', 'text',
    'Sport, travel, family, animals, and the rest of it. A record of projects is an honest account of what someone has built and a poor account of who built it.'],
  ['personal.empty', 'personal', 'text',
    'Nothing here yet. Upload photographs in the admin and put them on the wall; they appear here immediately, with no arranging.'],
  ['personal.footnote', 'personal', 'line', 'Hover or focus one to open it up.',
    'Follows the photograph count.'],

  /* ---- documents ---- */
  ['documents.eyebrow', 'documents', 'line', 'Documents'],
  ['documents.heading', 'documents', 'line', 'Written to Be Used Without Me in the Room'],
  ['documents.lede', 'documents', 'text',
    'Game manuals, migration runbooks, governance packages, and training curricula. Every page of every document is indexed, so a search for a term returns the document and the page it is on.'],
  ['documents.resume.label', 'documents', 'line', 'Resume'],
  ['documents.cv.label', 'documents', 'line', 'Curriculum Vitae'],
  ['documents.cta.open', 'documents', 'line', 'Open in a New Tab'],
  ['documents.cta.download', 'documents', 'line', 'Download the PDF'],
  ['documents.cta.search', 'documents', 'line', 'Search Inside It'],
  ['documents.pdf.fallback', 'documents', 'text', 'This browser will not render a PDF in the page.'],
  ['documents.pdf.note', 'documents', 'text',
    'The reader above is hidden on a narrow screen, where almost no browser can render a PDF in the page. Use the two buttons instead.'],
  ['documents.row.view', 'documents', 'line', 'View', 'Button on each row of the library below.'],
  ['documents.row.download', 'documents', 'line', 'Download'],
  ['documents.library.eyebrow', 'documents', 'line', 'The Library'],
  ['documents.empty.some', 'documents', 'text', 'Nothing else published here yet.'],
  ['documents.empty.none', 'documents', 'text',
    'Nothing published here yet. Upload a PDF in the admin, and mark one as the resume and one as the CV to pin them above.'],

  /* ---- contact ---- */
  /* ---- the contact form, on both pages that carry it ---- */
  ['form.name', 'contact', 'line', 'Your Name'],
  ['form.email', 'contact', 'line', 'Email'],
  ['form.email.hint', 'contact', 'line', 'Only used to reply. Nothing else, ever.'],
  ['form.subject', 'contact', 'line', 'Subject'],
  ['form.message', 'contact', 'line', 'Message'],
  ['form.send', 'contact', 'line', 'Send'],

  ['contact.eyebrow', 'contact', 'line', 'Contact'],
  ['contact.heading', 'contact', 'line', 'Get in Touch'],
  ['contact.lede', 'contact', 'text',
    'Available for summer 2027 internships in robotics, mechanical design, controls, electrical, or hardware engineering, ideally spanning more than one of them, in the Bay Area or Los Angeles. Also happy to talk about FIRST, or about anything on this site.'],
  ['contact.sent.heading', 'contact', 'line', 'Message Sent'],
  ['contact.sent.lede', 'contact', 'text',
    'That reached me. I read everything and reply to anything that is not automated.'],
  ['contact.note', 'contact', 'text',
    'There is no tracking on this form, no third party script, and no captcha. It is checked on the server instead.'],

  /* ---- search ---- */
  ['search.eyebrow', 'search', 'line', 'Search'],
  ['search.heading', 'search', 'line', 'Find Anything'],
  ['search.label', 'search', 'line', 'Search Projects, Documents, and Disciplines', 'Read out by a screen reader.'],
  ['search.placeholder', 'search', 'line', 'Swerve, CAN Bus, Governance, MegaTag2'],
  ['search.button', 'search', 'line', 'Search'],
  ['search.empty', 'search', 'text', 'Nothing matched. Try a discipline name, a part, or a tool.'],
  ['search.browse.eyebrow', 'search', 'line', 'Or Start From a Discipline'],
  ['search.recent.eyebrow', 'search', 'line', 'Most Recent Work'],

  /* ---- build log ---- */
  ['log.eyebrow', 'log', 'line', 'Build Log'],
  ['log.heading', 'log', 'line', 'What Is Happening Now'],
  ['log.empty', 'log', 'line', 'No entries yet.'],
  ['log.edited', 'log', 'line', 'Edited', 'Shown on an entry that was corrected after it was posted.'],

  /* ---- now ---- */
  ['now.eyebrow', 'now', 'line', 'Now'],
  ['now.heading', 'now', 'line', 'What I Am Working On'],
  ['now.empty', 'now', 'line', 'Nothing recorded here yet.'],
  ['now.recent.heading', 'now', 'line', 'Recently'],
  ['now.recent.link', 'now', 'line', 'Full Build Log'],

  /* ---- attributions ---- */
  ['attributions.eyebrow', 'attributions', 'line', 'Colophon'],
  ['attributions.heading', 'attributions', 'line', 'Attributions'],
  ['attributions.lede', 'attributions', 'text',
    'What this site is built from, and the notices the licences require me to carry.'],

  /* ---- error pages ---- */
  ['errors.404.eyebrow', 'errors', 'line', '404'],
  ['errors.404.heading', 'errors', 'line', 'That Page Does Not Exist'],
  ['errors.404.body', 'errors', 'text', 'It may have moved. The work index is the best place to start.'],
  ['errors.500.eyebrow', 'errors', 'line', '500'],
  ['errors.500.heading', 'errors', 'line', 'Something Broke on My End'],
  ['errors.500.body', 'errors', 'text', 'The error was recorded. Try again, or head back to the work index.'],

  /* ---- what a search engine and a shared link show ----
     Kept with the page they belong to rather than in a group of their own, so
     editing a page means seeing everything about that page in one screen. */
  ['home.meta.title', 'home', 'line', 'Eric J. Dean', 'Browser tab and search result title.'],
  ['home.meta.description', 'home', 'text',
    'Mechanical design, electrical, controls, software, fabrication, documentation, and business. One engineer, several projections.'],
  ['work.meta.title', 'work', 'line', 'Work'],
  ['work.meta.description', 'work', 'text',
    'Projects across mechanical, electrical, controls, software, fabrication, documentation, and business.'],
  ['disciplines.meta.title', 'disciplines', 'line', 'Disciplines'],
  ['disciplines.meta.description', 'disciplines', 'text',
    'Eight disciplines, each with the work that proves it.'],
  ['education.meta.title', 'education', 'line', 'Education'],
  ['education.meta.description', 'education', 'text',
    'Coursework, activities, and awards at UCLA and Archbishop Riordan High School.'],
  ['professional.meta.title', 'professional', 'line', 'Professional Profile'],
  ['professional.meta.description', 'professional', 'text',
    'GitHub repositories and professional profile for Eric J. Dean, read without leaving the site.'],
  ['personal.meta.title', 'personal', 'line', 'Beyond the Bench'],
  ['personal.meta.description', 'personal', 'text',
    'Sport, travel, family, animals, and the rest of it. The parts of a person a project record leaves out.'],
  ['documents.meta.title', 'documents', 'line', 'Documents'],
  ['documents.meta.description', 'documents', 'text',
    'Game manuals, runbooks, governance packages, and training curricula, searchable by page.'],
  ['contact.meta.title', 'contact', 'line', 'Contact'],
  ['contact.meta.description', 'contact', 'text', 'Get in touch with Eric J. Dean.'],
  ['search.meta.title', 'search', 'line', 'Search'],
  ['search.meta.description', 'search', 'text', 'Search projects, documents, and disciplines.'],
  ['log.meta.title', 'log', 'line', 'Build Log'],
  ['log.meta.description', 'log', 'text', 'Short dated entries from work in progress.'],
  ['now.meta.title', 'now', 'line', 'Now'],
  ['now.meta.description', 'now', 'text', 'What Eric Dean is working on at the moment.'],
  ['attributions.meta.title', 'attributions', 'line', 'Attributions'],
  ['attributions.meta.description', 'attributions', 'text',
    'Typefaces, software, privacy, and method for this site.'],
].map(([key, page, kind, def, hint]) => ({
  key,
  page,
  kind,
  def,
  required: REQUIRED(key),
  hint: hint || '',
  /* The label in the editor is derived, so a new slot cannot be added with a
     key that says one thing and a label that says another. */
  label: humanLabel(key),
}));

const BY_KEY = new Map(SLOTS.map((s) => [s.key, s]));

/* ------------------------------------------------------------------ store */

/*
 * One read of the override table per process, invalidated on every write.
 * There are a few hundred slots and a page asks for a dozen; a query per string
 * would be the single hottest thing on the site for no reason.
 */
let cache = null;

function overrides() {
  if (cache) return cache;
  cache = new Map();
  try {
    for (const row of all('SELECT key, value FROM content')) cache.set(row.key, row.value);
  } catch { /* table not created yet; defaults are correct until it is */ }
  return cache;
}

function invalidate() { cache = null; }

/** The raw stored string for a key, default included. Throws on an unknown key. */
function value(key) {
  const slot = BY_KEY.get(key);
  if (!slot) throw new Error(`unknown content key: ${key}`);
  const o = overrides().get(key);
  return o === undefined ? slot.def : o;
}

/** True when a key has been edited away from its default. */
function isEdited(key) { return overrides().has(key); }

function set(key, raw) {
  const slot = BY_KEY.get(key);
  if (!slot) throw new Error(`unknown content key: ${key}`);
  const v = slot.kind === 'flag' ? (raw ? '1' : '0') : String(raw ?? '');
  // An empty heading is a mistake every time. Treat it as "put it back".
  if (slot.required && !v.trim()) return reset(key);
  if (v === slot.def) return reset(key);          // back to default is not an override
  run(
    `INSERT INTO content (key, value, updated_at) VALUES (?, ?, ?)
     ON CONFLICT(key) DO UPDATE SET value = excluded.value, updated_at = excluded.updated_at`,
    key, v, new Date().toISOString()
  );
  invalidate();
}

function reset(key) {
  run('DELETE FROM content WHERE key = ?', key);
  invalidate();
}

/* ---------------------------------------------------------------- helpers */

/** A media row for an image slot, or null. Missing rows read as "not set". */
function image(key) {
  const v = value(key);
  if (!v) return null;
  try {
    return get('SELECT id, storage_key, alt, width, height, mime FROM media WHERE id = ?', Number(v)) || null;
  } catch { return null; }
}

/**
 * The four helpers a template gets. Named short deliberately: they appear
 * several times per line of markup, and `content.text('home.headline')` reads
 * worse than the string it replaces.
 */
function helpers() {
  return {
    c: (key) => value(key),
    cr: (key) => richText(value(key)),
    cf: (key) => value(key) === '1',
    ci: image,
  };
}

/* ------------------------------------------------------------------ admin */

/** Every slot on one page, with its current value, for the editor. */
function forPage(page) {
  return SLOTS.filter((s) => s.page === page).map((s) => ({
    ...s,
    value: value(s.key),
    edited: isEdited(s.key),
  }));
}

function editedCount() {
  return SLOTS.filter((s) => isEdited(s.key)).length;
}

module.exports = {
  PAGES, SLOTS, BY_KEY,
  value, set, reset, isEdited, image, helpers, forPage, editedCount, invalidate,
  escapeHtml,
};

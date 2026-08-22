'use strict';

/*
 * Seed. Real content only, no lorem, because placeholder copy in a portfolio
 * is how a site stays unlaunched: you cannot judge a layout against text you
 * know is fake.
 *
 *   node scripts/seed.js            insert what is missing
 *   node scripts/seed.js --reset    drop the database first
 */

const fs = require('node:fs');
const path = require('node:path');

const RESET = process.argv.includes('--reset');
const DATA_DIR = path.join(__dirname, '..', 'data');

if (RESET) {
  for (const f of ['third-angle.db', 'third-angle.db-wal', 'third-angle.db-shm']) {
    const p = path.join(DATA_DIR, f);
    if (fs.existsSync(p)) { fs.rmSync(p); console.log(`removed ${f}`); }
  }
}

const db = require('../src/db');
const repo = require('../src/repo');
const markup = require('../src/markup');
const { generateNKeysBetween } = require('fractional-indexing');

db.assertEnvironment();
db.migrate();

const now = db.nowIso();

/* ---------------------------------------------------------- disciplines */

const DISCIPLINES = [
  ['mechanical', 'Mechanical and CAD', 'ch-mechanical',
    'Part and assembly modelling in Onshape and Fusion 360, mechanism and drivetrain design, dimensioned drawings, bills of materials, and tolerance and fit checks.'],
  ['electrical', 'Electrical', 'ch-electrical',
    'Wiring harness fabrication, crimping and connectorisation, through hole assembly standards, 12V distribution at several hundred amps, breakers and fusing, and first line triage of a robot that will not move.'],
  ['controls', 'Controls', 'ch-controls',
    'Closed loop control, swerve kinematics, odometry and pose estimation, sensor fusion, AprilTag localisation, and autonomous path planning.'],
  ['software', 'Software', 'ch-software',
    'Java robot code, TypeScript and Node applications, server rendered web apps with SQLite, WebSockets, and test suites that actually run.'],
  ['fabrication', 'Fabrication', 'ch-fabrication',
    'CNC milling, FDM printing, laser cutting, drill press and band saw, and the shop practice that keeps all of it safe.'],
  ['documentation', 'Documentation', 'ch-documentation',
    'Game manuals, migration runbooks, governance packages, training curricula, and build trackers. Documents that other people have to use without me in the room.'],
  ['business', 'Business', 'ch-business',
    'Fundraising and sponsorship, grant writing, budgeting, business planning, and founding a California nonprofit.'],
  ['teaching', 'Teaching', 'ch-teaching',
    'Instructing at iD Tech for ages 10 to 17, mentoring three FIRST teams, and writing the curriculum that outlives the session.'],
];

const dKeys = generateNKeysBetween(null, null, DISCIPLINES.length);
DISCIPLINES.forEach(([slug, label, color, blurb], i) => {
  db.run(
    `INSERT INTO facet (slug, label, kind, color_token, blurb, sort_key, in_nav)
     VALUES (?, ?, 'discipline', ?, ?, ?, 1)
     ON CONFLICT(slug) DO UPDATE SET
       label = excluded.label, color_token = excluded.color_token, blurb = excluded.blurb`,
    slug, label, color, blurb, dKeys[i]
  );
});
console.log(`disciplines: ${DISCIPLINES.length}`);

/* -------------------------------------------------------------- projects */

const PROJECTS = [
  {
    slug: 'summit-push',
    title: 'SUMMIT PUSH',
    subtitle: 'A complete off-season FRC game, designed end to end: manual, field CAD, drawings, and vision layout.',
    tier: 'case-study',
    status: 'shipped',
    context: 'CADathon 2026',
    role: 'Sole designer',
    featured: 1,
    started_on: '2026-06',
    ended_on: '2026-08',
    summary_md:
      'Two alliances of three robots climb opposite flanks of the same peak, ferrying supplies to a 90 inch spire ' +
      'that lights tier by tier as camps are established. A randomised forecast at the start of the match forces ' +
      'genuinely branching autonomous routines, and the last thirty seconds are a climb on a truss leaning at 15 degrees.',
    body_md: [
      'The package contains a design research foundation, a locked design specification, a full game manual that went ' +
      'through a red team pass, per element field CAD with bills of materials in both an official and a low cost plywood ' +
      'version, dimensioned SVG drawings of the field and game pieces, and a 26 tag AprilTag 36h11 layout with mounting ' +
      'and simulation guidance for PhotonVision and Limelight.',
      'The hardest constraint was buildability. A game that cannot be built out of plywood by a team with a circular saw ' +
      'is not an off-season game, it is a wish. Every field element carries two bills of materials for that reason.',
    ].join('\n\n'),
    metrics: [
      ['Game manual', '1,375', 'lines'],
      ['Concepts scored', '8', ''],
      ['AprilTags', '26', 'tags'],
      ['Field drawings', '5', 'SVG'],
    ],
    facets: [
      ['mechanical', 'primary', 'Per element field CAD with bills of materials in an official and a low cost plywood version, plus dimensioned SVG drawings of the field and game pieces.'],
      ['documentation', 'primary', 'A 1,375 line game manual across six sections, a locked design specification, and six research documents, all red teamed before release.'],
      ['controls', 'significant', 'A 26 tag AprilTag 36h11 field layout with mounting geometry and simulation guidance for both PhotonVision and Limelight backends.'],
      ['fabrication', 'supporting', 'Every field element specified so it can be cut from plywood by a team with a circular saw, not only by a machine shop.'],
    ],
    links: [['Field renderings', 'https://github.com/XrxcGH', 'cad']],
  },
  {
    slug: 'frc-robot-template',
    title: 'FRC Robot Template',
    subtitle: 'A state-based WPILib 2026 Java template with full AdvantageKit deterministic replay.',
    tier: 'build',
    status: 'shipped',
    context: 'Open source',
    role: 'Author',
    featured: 1,
    started_on: '2026-07',
    summary_md:
      'A batteries-included Java robot template for teams starting a season from scratch. Swerve, PathPlanner, and ' +
      'Choreo autonomous with on-the-fly pathfinding, AdvantageKit logging into AdvantageScope, and physics ' +
      'simulation with unit tests, all driven from one Constants file and coordinated by one Superstructure state machine.',
    body_md: [
      'Every subsystem, including the swerve drivetrain, sits behind an IO hardware abstraction layer, so a recorded ' +
      'match replays bit for bit. Every mechanism has both a Kraken X60 and a NEO implementation, switchable with one ' +
      'constant, and the vision backend switches between Limelight and PhotonVision the same way.',
      'It ships fill-in-the-blank mechanisms for an elevator, arm, wrist, turret, shooter, intake, indexer, end ' +
      'effector, climber, and CANdle LEDs. It builds, tests, and simulates out of the box with placeholders, which is the ' +
      'part most templates skip and the part a team starting in January actually needs.',
    ].join('\n\n'),
    metrics: [
      ['Java files', '80', ''],
      ['Mechanisms', '10', ''],
      ['Vision backends', '2', ''],
    ],
    facets: [
      ['software', 'primary', 'A state machine architecture with an IO abstraction layer under every subsystem, unit tested and simulated, written so a student can fill in a mechanism without understanding the whole.'],
      ['controls', 'primary', 'Swerve kinematics, closed loop control, PathPlanner and Choreo autonomous with on-the-fly pathfinding, and shoot-on-the-move aiming.'],
      ['teaching', 'significant', 'Written as a teaching artefact: one Constants file, fill-in-the-blank mechanisms, and documentation aimed at a team with no prior software mentor.'],
    ],
    links: [['Repository', 'https://github.com/XrxcGH/0000-XXXX-Robot-Template', 'repo']],
  },
  {
    slug: 'frc-electrical-curriculum',
    title: 'FRC Electrical Training',
    subtitle: 'Basic and advanced electrical sessions, written for everyone on a team rather than only the electrical subteam.',
    tier: 'build',
    status: 'shipped',
    context: 'WRRF',
    role: 'Author and instructor',
    featured: 1,
    started_on: '2026-07',
    summary_md:
      'A curriculum covering the hazards of a 12V system delivering several hundred amps, component identification, ' +
      'the power path from battery to motor and the signal path from driver station to motor controller, crimp and ' +
      'wire routing standards, and first line triage of a robot that will not move.',
    body_md: [
      'The design decision that matters: this is written for the whole team, not the electrical subteam. On a ' +
      'competition field the person standing next to a robot that will not move is usually not the person who wired it, ' +
      'and the failure is usually a connector.',
      'Delivered as both slides and a printable PDF, and taught live to Pirate Robolution, FRC 5430.',
    ].join('\n\n'),
    metrics: [
      ['Sessions', '2', ''],
      ['System voltage', '12', 'V'],
      ['Peak current', '300+', 'A'],
    ],
    facets: [
      ['electrical', 'primary', 'Power and signal paths, crimp and connectorisation standards to through hole assembly practice, breaker and fuse sizing, and multimeter triage.'],
      ['teaching', 'primary', 'Two sessions written and taught live, aimed at students with no prior electrical background, then handed over so someone else can run them.'],
      ['documentation', 'significant', 'Published as slides and a printable PDF so a mentor who was not in the room can deliver the same session.'],
    ],
    links: [],
  },
  {
    slug: 'wrrf-workspace',
    title: 'WRRF Google Workspace Architecture',
    subtitle: 'An architecture document, 90 day migration runbook, interactive wireframe, and ten tab tracker, all generated from one folder tree definition.',
    tier: 'case-study',
    status: 'shipped',
    context: 'WRRF',
    role: 'Intern, sole author',
    featured: 0,
    started_on: '2026-05',
    summary_md:
      'Domains and licensing, organisational units, groups and email addresses, ten shared drives with full folder trees, ' +
      'a permissions matrix, naming conventions, and a retention schedule, all mapped to the structure of the new website.',
    body_md: [
      'The interesting part is not the architecture, it is that the wireframe and the workbook are both generated by ' +
      'Python from a single shared folder tree definition rather than hand maintained. Two artefacts that describe the same ' +
      'structure will drift the moment a human edits one of them. These cannot.',
      'Shipped with a phased 90 day rollout, a security baseline, onboarding and offboarding checklists, and a risk register.',
    ].join('\n\n'),
    metrics: [
      ['Folders', '182', ''],
      ['Shared drives', '10', ''],
      ['Rollout', '90', 'days'],
      ['Tracker tabs', '10', ''],
    ],
    facets: [
      ['documentation', 'primary', 'An architecture document, a migration runbook, a permissions matrix, and a retention schedule, written so a volunteer can execute the migration without me.'],
      ['software', 'significant', 'Python generation of both the interactive HTML wireframe and the ten tab XLSX tracker from one shared folder tree definition, so the two artefacts cannot drift apart.'],
      ['business', 'significant', 'Organisational design work: units, groups, licensing, and access policy for a regional nonprofit.'],
    ],
    links: [],
  },
  {
    slug: 'team-9143-robots',
    title: 'Team 9143 Competition Robots',
    subtitle: 'Two robot codebases: a Phoenix 6 swerve drivetrain with a dual-NEO elevator and three-Limelight pose fusion.',
    tier: 'build',
    status: 'competed',
    context: 'Armor Robotics 9143',
    role: 'Team captain, software lead',
    featured: 0,
    started_on: '2025-01',
    ended_on: '2025-06',
    summary_md:
      'The A robot runs a Phoenix 6 swerve drivetrain on a 30 inch square frame with mixed SDS MK4i and MK4n modules, ' +
      'Kraken X60 drive and steer motors, CANcoders, and a Pigeon 2. On top sits a dual-NEO elevator with closed loop ' +
      'height control in inches and a pivoting arm that finds its angle off an absolute encoder.',
    body_md: [
      'Three Limelights fuse MegaTag2 pose estimates into odometry. Game piece detection runs off a CANrange rather ' +
      'than a beam break, which survives a collision better.',
      'The B robot shares the drivetrain and adds a KitBot roller and a pivoting ground intake that holds position ' +
      'under closed loop control. Both codebases are kept current with each year of WPILib and vendor libraries.',
    ].join('\n\n'),
    metrics: [
      ['Frame', '30', 'in sq'],
      ['Limelights', '3', ''],
      ['Codebases', '2', ''],
    ],
    facets: [
      ['controls', 'primary', 'Swerve kinematics, closed loop elevator height control in inches, absolute encoder homing, and MegaTag2 pose estimates fused into odometry from three cameras.'],
      ['software', 'primary', 'Two Java codebases on Phoenix 6 and REVLib, maintained across WPILib versions.'],
      ['mechanical', 'significant', 'Drivetrain and mechanism design on a 30 inch square frame with mixed SDS MK4i and MK4n modules.'],
      ['electrical', 'significant', 'CAN bus layout, motor controller addressing, sensor wiring, and the harness behind both robots.'],
    ],
    links: [
      ['A robot', 'https://github.com/XrxcGH/9143-2025-A-Updated', 'repo'],
      ['B robot', 'https://github.com/XrxcGH/9143-2025-B-Updated', 'repo'],
    ],
  },
  {
    slug: 'armor-robotics-program',
    title: 'Founding Armor Robotics 9143',
    subtitle: 'From a school club to a recognised varsity sport with a $45,000 annual budget, across three seasons.',
    tier: 'case-study',
    status: 'archived',
    context: 'Archbishop Riordan',
    role: 'Co-founder and team captain',
    featured: 0,
    started_on: '2022-01',
    ended_on: '2025-06',
    summary_md:
      'Grew the programme from a school club to a competitive team and then to a recognised co-ed non-athletic varsity ' +
      'sport, working with administration on recognition, recruiting, and parent volunteer coordination. Membership ranged ' +
      'from roughly 15 to 50 students across three seasons.',
    body_md: [
      'Secured a $45,000 annual base budget from the school in the second and third years, an increase driven by ' +
      'competition results, supplemented by sponsorships, grants, individual donations, and a crowdfunding campaign. ' +
      'Submitted grant applications to the Bayer Fund, REV Robotics, Intuitive, BAE Systems, and the YMCA Youth ' +
      'Empowerment Fund among others.',
      'Authored or co-authored the team business plan, sponsorship programme, handbook, EDI plan, branding guide, ' +
      'accounting and inventory sheets, and the 2023 Entrepreneurship Award submission, which was presented in a judged ' +
      'interview at CalGames.',
    ].join('\n\n'),
    metrics: [
      ['Annual budget', '$45,000', ''],
      ['Members', '15 to 50', ''],
      ['Seasons', '3', ''],
      ['Team awards', '9', ''],
    ],
    facets: [
      ['business', 'primary', 'Fundraising, sponsorship tiers, grant writing, budgeting, and the business plan and entrepreneurship submission behind a $45,000 annual programme.'],
      ['teaching', 'significant', 'Recruiting, onboarding, and running build season planning for a team that ranged from 15 to 50 students.'],
      ['documentation', 'significant', 'The full operating document set: handbook, EDI plan, branding guide, accounting and inventory sheets, agendas, and minutes.'],
    ],
    links: [],
  },
  {
    slug: 'internship-applier',
    title: 'Internship Applier',
    subtitle: 'A local-first desktop tool that reads a resume, finds eligible internships, and drafts answers it can trace back to a stored fact.',
    tier: 'build',
    status: 'in-progress',
    context: 'Personal',
    role: 'Author',
    featured: 0,
    started_on: '2026-08',
    summary_md:
      'Built across eight milestones covering resume ingestion, discovery, matching, a review queue, the writing engine, ' +
      'form filling, a tracker, and packaging, each with its own test suite.',
    body_md: [
      'The part worth pointing at is the verification gate: it refuses to generate any sentence it cannot trace back to ' +
      'a stored fact in the profile. An application tool that invents a credential is worse than no tool.',
      'The README names what is still untested rather than claiming completeness, because a number written down in a ' +
      'README rots and a test count does not.',
    ].join('\n\n'),
    metrics: [
      ['Milestones', '8', 'of 8'],
      ['Test suites', '8', ''],
    ],
    facets: [
      ['software', 'primary', 'A TypeScript monorepo on React, Fastify, SQLite with Drizzle, Playwright, and Zod, built across eight milestones each with its own tests.'],
    ],
    links: [['Repository', 'https://github.com/XrxcGH/internship-applier', 'repo']],
  },
  {
    slug: 'pumpkinlib',
    title: 'PumpkinLib',
    subtitle: 'A 22,778 line design specification for an FRC vendor library. No implementation, deliberately and visibly.',
    // 'build', not 'note'. A note renders three blocks, which hid the three
    // metrics that are the entire point of the record (22,778 lines of
    // specification against zero lines of Java) and the link to the repository
    // those numbers describe. The tier is a padding guard, not a content gate.
    tier: 'build',
    status: 'specification',
    context: 'Open source',
    role: 'Author',
    featured: 0,
    started_on: '2026-08',
    summary_md:
      'A Java library that would pre-wire AdvantageKit, PathPlanner, Choreo, PhotonVision, Limelight, Phoenix 6, REVLib, ' +
      'SysId and WPILib into one coherent seam. Currently design documents only, revised twice: once after an adversarial ' +
      'four lens review and again after a six lens independent expert review.',
    body_md: [
      'The roadmap states a realistic solo delivery estimate rather than an optimistic one, and nothing will be announced ' +
      'anywhere until v0.1 is tagged. If you found this repository, you found a plan, not a product.',
      'Listed here as a specification rather than as software on purpose. The artefact is the decision record: scope and ' +
      'non-goals, alternatives considered and rejected, and open questions. Those are the sections someone who did not ' +
      'think the problem through cannot fabricate.',
    ].join('\n\n'),
    metrics: [
      ['Specification', '22,778', 'lines'],
      ['Review passes', '2', ''],
      ['Java written', '0', 'lines'],
    ],
    facets: [
      ['software', 'primary', 'A design specification covering architecture, decisions, and roadmap for a library that pre-wires the modern FRC toolchain behind one seam.'],
      ['documentation', 'significant', 'Structured as an engineering design review package rather than a README: scope, non-goals, alternatives rejected, and open questions.'],
    ],
    links: [['Repository', 'https://github.com/XrxcGH/PumpkinLib', 'repo']],
  },
];

const pKeys = generateNKeysBetween(null, null, PROJECTS.length);

const seedProjects = db.transaction(() => {
  PROJECTS.forEach((p, i) => {
    const existing = db.get('SELECT id FROM project WHERE slug = ?', p.slug);
    if (existing) { db.run('DELETE FROM project WHERE id = ?', existing.id); }

    const res = db.run(
      `INSERT INTO project
         (slug, title, subtitle, tier, status, context, role,
          summary_md, summary_html, body_md, body_html,
          started_on, ended_on, published, featured, sort_key, created_at, updated_at)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 1, ?, ?, ?, ?)`,
      p.slug, p.title, p.subtitle, p.tier, p.status, p.context, p.role,
      p.summary_md, markup.paragraphs(p.summary_md), p.body_md, markup.paragraphs(p.body_md),
      p.started_on || null, p.ended_on || null, p.featured || 0, pKeys[i], now, now
    );
    const id = Number(res.lastInsertRowid);

    const fKeys = generateNKeysBetween(null, null, p.facets.length);
    p.facets.forEach(([slug, weight, note], j) => {
      db.run(
        `INSERT INTO project_facet (project_id, facet_slug, weight, contribution_note, sort_key)
         VALUES (?, ?, ?, ?, ?)`,
        id, slug, weight, note, fKeys[j]
      );
    });

    if (p.metrics && p.metrics.length) {
      const mKeys = generateNKeysBetween(null, null, p.metrics.length);
      p.metrics.forEach(([label, value, unit], j) => {
        db.run(
          'INSERT INTO metric (project_id, label, value, unit, sort_key) VALUES (?, ?, ?, ?, ?)',
          id, label, value, unit || null, mKeys[j]
        );
      });
    }

    if (p.links && p.links.length) {
      const lKeys = generateNKeysBetween(null, null, p.links.length);
      p.links.forEach(([label, url, kind], j) => {
        db.run(
          'INSERT INTO link (project_id, label, url, kind, sort_key) VALUES (?, ?, ?, ?, ?)',
          id, label, url, kind, lKeys[j]
        );
      });
    }
  });
});

seedProjects();
console.log(`projects: ${PROJECTS.length}`);

/*
 * The seed writes published = 1 directly, which means it does not pass through
 * the evidence gate the admin enforces on every save. That is deliberate: a
 * seed that refused to publish would leave the site empty on a fresh install.
 * What it must not do is stay quiet about it, because the first time the owner
 * opens one of these records and presses Save the gate demotes it to a draft
 * with no warning that anything was ever different.
 */
{
  const mediaGate = require('../src/media');
  const blocked = db.all('SELECT id, slug FROM project WHERE published = 1')
    .map((row) => ({ slug: row.slug, blockers: mediaGate.publishBlockers(row.id) }))
    .filter((r) => r.blockers.length);

  if (blocked.length) {
    console.log(`\nEvidence gate: ${blocked.length} published project${blocked.length === 1 ? '' : 's'} would be`);
    console.log('demoted to a draft the next time it is saved from the admin, because it');
    console.log('leads on physical work and has no photography of your own attached yet:');
    for (const b of blocked) console.log(`  ${b.slug}`);
    console.log('Upload evidence at /admin/media, or set the status to specification.');
  }
}

/* ------------------------------------------------------------------- now */

/*
 * One string, rendered. This used to pass the markdown and a hand written copy
 * of the HTML as two separate literals, and they drifted: the HTML carried a
 * sentence about this term's classes that the markdown did not, so the page
 * showed it and the admin editor did not, and saving from the admin would have
 * silently deleted it. See DESIGN.md, R11.
 */
const NOW_MD =
  'Interning at the Western Region Robotics Forum, founding Groundwork Robotics, '
  + 'and mentoring three FIRST teams. At UCLA this term: MAE M20, MATH 32B, and MSE 104.';

db.run(
  `INSERT INTO now_page (id, body_md, body_html, updated_at) VALUES (1, ?, ?, ?)
   ON CONFLICT(id) DO UPDATE SET body_md = excluded.body_md, body_html = excluded.body_html, updated_at = excluded.updated_at`,
  NOW_MD, markup.richText(NOW_MD), now
);

/* --------------------------------------------------------------- indexes */

repo.reindexAll();
const indexed = db.get('SELECT COUNT(*) AS n FROM search_index').n;
console.log(`search index: ${indexed} rows`);

console.log('\nSeed complete. Run `npm start` and open http://localhost:3000');

'use strict';

/*
 * Seed the singleton pages with real content.
 *
 * Kept separate from scripts/seed.js so a reseed of projects does not
 * overwrite prose that has been edited in the admin since. Run once:
 *
 *   node scripts/seed-pages.js
 *   node scripts/seed-pages.js --force    overwrite existing pages
 */

const db = require('../src/db');
const repo = require('../src/repo');

db.assertEnvironment();
db.migrate();

const FORCE = process.argv.includes('--force');

/* Minimal, deliberate subset of Markdown. A full parser is a dependency and an
   XSS surface; this escapes everything first and then adds back only the six
   constructs the pages actually use. */
function render(md) {
  const esc = (s) => String(s)
    .replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;').replace(/'/g, '&#39;');

  const inline = (s) => esc(s)
    .replace(/\*\*([^*]+)\*\*/g, '<strong>$1</strong>')
    .replace(/`([^`]+)`/g, '<code>$1</code>')
    .replace(/\[([^\]]+)\]\((https?:\/\/[^\s)]+|\/[^\s)]*)\)/g, '<a href="$2">$1</a>');

  const out = [];
  let list = null;

  const closeList = () => { if (list) { out.push(`</${list}>`); list = null; } };

  for (const raw of String(md).split(/\r?\n/)) {
    const line = raw.trimEnd();

    if (!line.trim()) { closeList(); continue; }

    const h = /^(#{2,4})\s+(.*)$/.exec(line);
    if (h) { closeList(); out.push(`<h${h[1].length}>${inline(h[2])}</h${h[1].length}>`); continue; }

    const li = /^[-*]\s+(.*)$/.exec(line);
    if (li) {
      if (list !== 'ul') { closeList(); out.push('<ul>'); list = 'ul'; }
      out.push(`<li>${inline(li[1])}</li>`);
      continue;
    }

    // "Label :: value" renders as a definition row, which is what a resume
    // actually is and what a paragraph handles badly.
    const dl = /^(.+?)\s+::\s+(.*)$/.exec(line);
    if (dl) {
      closeList();
      out.push(`<p class="res-row"><span class="res-k">${inline(dl[1])}</span><span class="res-v">${inline(dl[2])}</span></p>`);
      continue;
    }

    closeList();
    out.push(`<p>${inline(line)}</p>`);
  }
  closeList();
  return out.join('\n');
}

const PAGES = [
  {
    slug: 'resume',
    title: 'Eric J. Dean',
    subtitle: 'Mechanical engineering at UCLA. Mechanical design and CAD, electrical assembly and controls, and programming.',
    body_md: [
      'Half Moon Bay, CA :: [github.com/XrxcGH](https://github.com/XrxcGH) · [linkedin.com/in/edean07](https://linkedin.com/in/edean07)',
      '',
      '## Education',
      '',
      'University of California, Los Angeles :: BS Mechanical Engineering, expected June 2029',
      '',
      'Coursework: Statics and Strength of Materials; Computer Programming with MATLAB; Calculus of Several Variables; Mechanics and Mechanics Laboratory; Oscillations, Waves and Fields; Chemical Structure and Energetics; Statistical Reasoning.',
      '',
      'Activities: ASME at UCLA; Westwood SolidWorks User Group.',
      '',
      'Archbishop Riordan High School :: Diploma, Magna Cum Laude, May 2025',
      '',
      'Eleven Advanced Placement and honours subjects, the maximum allowed, including AP Calculus BC, AP Physics C: Mechanics, AP Computer Science Principles and AP Statistics. Completed the four year Engineering Program culminating in a capstone project.',
      '',
      '## Experience',
      '',
      '### Western Region Robotics Forum, San Jose CA',
      'Intern :: May 2026 to present',
      '',
      '- Authored the proposed CalGames 2026 event modification package, amending the official FIRST Robotics Competition game manual for a 40 team off-season event with more than 75 matches over three days.',
      '- Designed the organisation’s Google Workspace architecture and a 90 day migration plan covering ten shared drives and 182 folders, with a Python generated tracker and interactive wireframe built from one shared folder tree definition so the two cannot drift apart.',
      '- Built the proposed website application in Node.js and Express, with site-wide search, a staff area and a document library.',
      '- Wrote and taught the FRC electrical training curriculum, basic and advanced.',
      '',
      '### iD Tech, Stanford CA',
      'Instructor :: June 2026 to August 2026',
      '',
      '- Taught weeklong, full day robotics and programming courses at Stanford to students aged 10 to 17.',
      '- Ran BattleBots Camp with VEX Robotics and Robotics Engineering with VEX.',
      '- Taught Python Coding 101: variables, conditionals, functions, and 2D games in PyGame Zero.',
      '- Built iD Tech Watch, a classroom management application for monitoring and controlling lab laptops.',
      '',
      '### Groundwork Robotics, Half Moon Bay CA',
      'Founder :: August 2026 to present',
      '',
      '- Founding a California nonprofit, seeking 501(c)(3) status, to train and support the students, mentors and volunteers behind competitive robotics.',
      '- Built the public website and staff content management system, a brand package, and a document generation toolchain.',
      '',
      '### Armor Robotics 9143, San Francisco CA',
      'Team captain and founding member :: January 2022 to June 2025',
      '',
      '- Co-founded the team and led it through three competition seasons, growing it from a school club to a recognised co-ed non-athletic varsity sport with 15 to 50 students.',
      '- Secured a $45,000 annual base budget from the school, supplemented by sponsorships, grants and donations.',
      '- Authored the team business plan, sponsorship programme, handbook, EDI plan, branding guide and the 2023 Entrepreneurship Award submission.',
      '',
      '## Technical skills',
      '',
      'CAD and mechanical :: Onshape, Fusion 360, SolidWorks (in progress). Part and assembly modelling, mechanism and drivetrain design, dimensioned drawings, bills of materials, tolerance and fit checks.',
      '',
      'Manufacturing :: CNC milling, FDM 3D printing, laser cutting, drill press, band saw, shop safety practice.',
      '',
      'Electrical :: Wiring harness fabrication, crimping and connectorisation, through-hole assembly standards, 12V high-current distribution, breakers and fusing, motor controllers, CAN bus, PWM, encoders and limit switches, multimeter troubleshooting.',
      '',
      'Languages :: Java, JavaScript, Python, MATLAB, HTML and CSS. TypeScript and SQL at working knowledge.',
      '',
      'Robotics and controls :: WPILib, CTRE Phoenix 6, REVLib, PathPlanner, Choreo, AdvantageKit, PhotonVision, Limelight and MegaTag2, AprilTag localisation, swerve kinematics, odometry and pose estimation, PID and closed-loop control, sensor fusion, autonomous path planning, VEX V5 and IQ.',
      '',
      'Software and tools :: Node.js, React, Fastify, Express, SQLite, Firebase, WebSockets, REST APIs, Playwright, unit testing, Git, Gradle, Android Studio, Google Workspace administration.',
      '',
      'Business :: Fundraising and sponsorship development, grant writing, budgeting, business planning, SWOT and risk analysis, brand development, event operations, volunteer coordination.',
      '',
      '## Leadership',
      '',
      '- Mentor, Pumpkin Bots 8793 (FRC), Mercy Mechs 18233 (FTC), White Hat Hackers 11230 (FRC), 2025 to present. Reviewing student Java, running build and off-season training, and providing design expertise.',
      '- Competition volunteer, FIRST FRC, FTC and FLL Challenge, 2023 to present.',
      '',
      '## Awards and certifications',
      '',
      '- Dean’s List Semi-Finalist, FIRST Robotics Competition, 2023 and 2024',
      '- AP Scholar with Distinction, College Board, 2024 and 2025',
      '- National Merit Commended Student, 2024',
      '- President’s Volunteer Service Award, Gold, 2023',
      '- Certified Onshape Associate (in progress)',
      '- PADI Advanced Open Water, Enriched Air; First Aid, CPR and AED, American Red Cross',
    ].join('\n'),
  },
];

let n = 0;
for (const p of PAGES) {
  const existing = repo.getPageForEdit(p.slug);
  if (existing && !FORCE) {
    console.log(`skipped ${p.slug}, already exists. Use --force to overwrite.`);
    continue;
  }
  repo.savePage(p.slug, {
    title: p.title,
    subtitle: p.subtitle,
    body_md: p.body_md,
    body_html: render(p.body_md),
    published: 1,
  });
  console.log(`${existing ? 'updated' : 'created'} ${p.slug}`);
  n += 1;
}

console.log(`\n${n} page${n === 1 ? '' : 's'} written.`);
module.exports = { render };

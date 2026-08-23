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

/* One renderer, shared with the admin page editor. See src/markup.js. */
const { richText: render } = require('../src/markup');

const PAGES = [
  {
    slug: 'resume',
    title: 'Eric J. Dean',
    subtitle: 'Mechanical engineering at UCLA. Mechanical design and CAD, electrical assembly and controls, and programming.',
    body_md: [
      'Half Moon Bay, CA :: [github.com/XrxcGH](https://github.com/XrxcGH) · [linkedin.com/in/edean07](https://www.linkedin.com/in/edean07)',
      '',
      '## Education',
      '',
      'University of California, Los Angeles :: BS Mechanical Engineering, expected June 2029',
      '',
      'Coursework: Statics and Strength of Materials; Computer Programming with MATLAB; Calculus of Several Variables; Mechanics and Mechanics Laboratory; Oscillations, Waves, and Fields; Chemical Structure and Energetics; Statistical Reasoning.',
      '',
      'Activities: ASME at UCLA; Westwood SolidWorks User Group.',
      '',
      'Archbishop Riordan High School :: Diploma, Magna Cum Laude, 4.321 weighted and 3.968 unweighted GPA, May 2025',
      '',
      'Eleven Advanced Placement and honours subjects, the maximum allowed, including AP Calculus AB, AP Calculus BC, AP Physics C: Mechanics, AP Computer Science Principles, AP Statistics, and AP Biology. Completed the four year Engineering Program culminating in an Engineering Capstone project.',
      '',
      '## Experience',
      '',
      '### Western Region Robotics Forum, San Jose, CA',
      'Intern :: May 2026 to present',
      '',
      '- Authored the proposed CalGames 2026 event modification package, amending the official FIRST Robotics Competition game manual for a 40 team off-season event with more than 75 matches over three days.',
      '- Designed the organisation’s Google Workspace architecture and a 90 day migration plan covering ten shared drives and 182 folders, with a Python generated tracker and interactive wireframe built from one shared folder tree definition so the two cannot drift apart.',
      '- Built the proposed website application in Node.js and Express, with site-wide search, a staff area, and a document library.',
      '- Wrote and taught the FRC electrical training curriculum, basic and advanced.',
      '',
      '### iD Tech, Stanford, CA',
      'Instructor :: June 2026 to August 2026',
      '',
      '- Taught weeklong, full day robotics and programming courses at Stanford to students aged 10 to 17.',
      '- Ran BattleBots Camp with VEX Robotics and Robotics Engineering with VEX.',
      '- Taught Python Coding 101: variables, conditionals, functions, and 2D games in PyGame Zero.',
      '- Built iD Tech Watch, a classroom management application for monitoring and controlling lab laptops.',
      '',
      '### Groundwork Robotics, Half Moon Bay, CA',
      'Founder :: August 2026 to present',
      '',
      '- Founding a California nonprofit, seeking 501(c)(3) status, to train and support the students, mentors, and volunteers behind competitive robotics.',
      '- Built the public website and staff content management system, a brand package, and a document generation toolchain.',
      '',
      '### Armor Robotics 9143, San Francisco, CA',
      'Team captain and founding member :: January 2022 to June 2025',
      '',
      '- Co-founded the team and led it through three competition seasons, growing it from a school club to a recognised co-ed non-athletic varsity sport with 15 to 50 students.',
      '- Secured a $45,000 annual base budget from the school, supplemented by sponsorships, grants, and donations.',
      '- Authored the team business plan, sponsorship programme, handbook, EDI plan, branding guide, and the 2023 Entrepreneurship Award submission.',
      '- Pitched the team to funders and industry partners including the YMCA Youth Empowerment Fund and Swope Design Solutions.',
      '- Team awards: Highest Rookie Seed, Highest Seeded Rookie twice, Rookie Inspiration, Imagery twice, Team Spirit, Judges’ Award, and Regional Finalists twice.',
      '',
      '### Academy of Volleyball, Redwood City, CA',
      'Assistant coach, U12 girls premier :: December 2024 to May 2025',
      '',
      '- Planned and ran practice drills, and supported tournament warm ups and in match coaching across a competitive club season.',
      '',
      '### Archbishop Riordan High School and Healthy Cities Tutoring',
      'Volunteer tutor :: December 2022 to May 2025',
      '',
      '- Tutored high school mathematics and science, and elementary and junior high subjects for students in underserved communities.',
      '',
      '## Technical Skills',
      '',
      'CAD and mechanical :: Onshape, Fusion 360, SolidWorks (in progress). Part and assembly modelling, mechanism and drivetrain design, dimensioned drawings, bills of materials, and tolerance and fit checks.',
      '',
      'Manufacturing :: CNC milling, FDM 3D printing, laser cutting, drill press, band saw, and shop safety practice.',
      '',
      'Electrical :: Wiring harness fabrication, crimping and connectorisation, through hole assembly standards, 12V high current distribution, breakers and fusing, motor controllers, CAN bus, PWM, encoders and limit switches, and multimeter troubleshooting.',
      '',
      'Languages :: Java, JavaScript, Python, MATLAB, HTML, and CSS. Working knowledge of TypeScript and SQL.',
      '',
      'Robotics and controls :: WPILib, CTRE Phoenix 6, REVLib, PathPlanner, Choreo, AdvantageKit, PhotonVision, Limelight and MegaTag2, AprilTag localisation, swerve kinematics, odometry and pose estimation, PID and closed loop control, sensor fusion, autonomous path planning, and VEX V5 and IQ.',
      '',
      'Software and tools :: Node.js, React, Fastify, Express, SQLite, Firebase, WebSockets, REST APIs, Playwright, unit testing, Git, Gradle, Android Studio, and Google Workspace administration.',
      '',
      'Business :: Fundraising and sponsorship development, grant writing, budgeting, business planning, SWOT and risk analysis, brand development, event operations, and volunteer coordination.',
      '',
      'AI-assisted development :: Claude Code in production software work. Specification first, work split into reviewable milestones, adversarial design review, then code review, testing, and verification by hand.',
      '',
      '## Leadership',
      '',
      '- Mentor, Pumpkin Bots 8793 (FRC), Mercy Mechs 18233 (FTC), White Hat Hackers 11230 (FRC), 2025 to present. Reviewing student Java, running build and off-season training, and providing design expertise.',
      '- Student advisor, Pumpkin Bots 8793, 2024 to 2025. Advised team leadership on technical direction and build season planning.',
      '- Competition volunteer, FIRST FRC, FTC, and FLL Challenge, 2023 to present.',
      '',
      '## Awards and Certifications',
      '',
      '- Dean’s List Semi-Finalist, FIRST Robotics Competition, 2023 and 2024',
      '- Gracious Professionalism, five recognitions, FIRST California, 2023 and 2024',
      '- AP Scholar with Distinction, College Board, 2024 and 2025',
      '- National Merit Commended Student, 2024',
      '- Academic Award in AP Statistics, 2025',
      '- President’s Honor Roll, 2023 to 2025; National Honor Society and California Scholarship Federation, 2022 to 2025',
      '- President’s Volunteer Service Award, Gold, AmeriCorps, 2023',
      '- Certified Onshape Associate (in progress)',
      '- PADI Advanced Open Water, Enriched Air; First Aid, CPR, and AED, American Red Cross',
      '- Conversational in American Sign Language',
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

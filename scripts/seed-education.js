'use strict';

/*
 * Seed the education record.
 *
 *   node scripts/seed-education.js           insert what is missing
 *   node scripts/seed-education.js --force   overwrite the schools too
 *
 * Every line below comes from the resume already in this repository
 * (scripts/seed-pages.js) and from the /now block in scripts/seed.js. Nothing
 * here was inferred from a LinkedIn profile or a CV, because neither is
 * readable from this machine: LinkedIn has no public profile API without a
 * partner agreement and blocks automated reads, and a CV file has never been
 * uploaded. The resume is stated to match both, so it is the source.
 *
 * Two things are deliberately incomplete rather than invented:
 *
 *   - Terms for completed classes. The resume lists coursework without terms,
 *     so those rows have none. The page shows a term only where one exists.
 *   - The title of MSE 104. The /now block names the class by its code and no
 *     source in this repository gives its catalogue title, so the row carries
 *     the code and the department name and is flagged for the operator.
 *
 * Both are one edit each at /admin/education.
 */

const db = require('../src/db');
const repo = require('../src/repo');

db.assertEnvironment();
db.migrate();

const FORCE = process.argv.includes('--force');

const SCHOOLS = [
  {
    slug: 'ucla',
    name: 'University Of California, Los Angeles',
    kind: 'university',
    credential: 'BS Mechanical Engineering, Expected June 2029',
    location: 'Los Angeles, CA',
    started_on: '2025-09',
    blurb:
      'Mechanical engineering, with the coursework weighted toward mechanics, '
      + 'materials and computation. The classes below are the record; the projects '
      + 'are on the work index.',
  },
  {
    slug: 'archbishop-riordan',
    name: 'Archbishop Riordan High School',
    kind: 'high-school',
    credential: 'Diploma, Magna Cum Laude',
    location: 'San Francisco, CA',
    started_on: '2021-08',
    ended_on: '2025-05',
    honours: 'Magna Cum Laude',
    blurb:
      'Eleven Advanced Placement and honours subjects, the maximum the school '
      + 'allows, alongside the four year Engineering Program and its capstone.',
  },
];

/*
 * status is the load bearing field. The three in progress are the ones the
 * /now block names as this term's classes; everything else the resume lists as
 * coursework is completed.
 */
const COURSES = [
  // ---- UCLA, this term -----------------------------------------------------
  { school: 'ucla', code: 'MAE M20', title: 'Computer Programming With MATLAB', term: 'Fall 2026', status: 'in-progress' },
  { school: 'ucla', code: 'MATH 32B', title: 'Calculus Of Several Variables', term: 'Fall 2026', status: 'in-progress' },
  {
    school: 'ucla',
    code: 'MSE 104',
    title: 'Materials Science And Engineering 104',
    term: 'Fall 2026',
    status: 'in-progress',
    note: 'Catalogue title to be filled in at /admin/education.',
  },

  // ---- UCLA, completed -----------------------------------------------------
  { school: 'ucla', title: 'Statics And Strength Of Materials', status: 'completed' },
  { school: 'ucla', title: 'Mechanics And Mechanics Laboratory', status: 'completed' },
  { school: 'ucla', title: 'Oscillations, Waves And Fields', status: 'completed' },
  { school: 'ucla', title: 'Chemical Structure And Energetics', status: 'completed' },
  { school: 'ucla', title: 'Statistical Reasoning', status: 'completed' },

  // ---- high school ---------------------------------------------------------
  { school: 'archbishop-riordan', code: 'AP', title: 'AP Calculus BC', status: 'completed' },
  { school: 'archbishop-riordan', code: 'AP', title: 'AP Physics C: Mechanics', status: 'completed' },
  { school: 'archbishop-riordan', code: 'AP', title: 'AP Computer Science Principles', status: 'completed' },
  { school: 'archbishop-riordan', code: 'AP', title: 'AP Statistics', status: 'completed' },
  {
    school: 'archbishop-riordan',
    title: 'Engineering Program, Four Year Sequence',
    status: 'completed',
    note: 'Completed with a capstone project.',
  },
];

const ACTIVITIES = [
  // ---- UCLA ----------------------------------------------------------------
  { school: 'ucla', title: 'ASME At UCLA', kind: 'activity', role: 'Member', started_on: '2025-09' },
  { school: 'ucla', title: 'Westwood SolidWorks User Group', kind: 'activity', role: 'Member', started_on: '2025-09' },

  // ---- high school ---------------------------------------------------------
  {
    school: 'archbishop-riordan',
    title: 'Armor Robotics 9143',
    kind: 'activity',
    role: 'Co-Founder And Team Captain',
    detail: 'Grew the programme from a school club to a recognised co-ed non-athletic varsity sport across three seasons.',
    started_on: '2022-01',
    ended_on: '2025-06',
  },
  {
    school: 'archbishop-riordan',
    title: 'AP Scholar With Distinction',
    kind: 'award',
    detail: 'College Board',
    started_on: '2024',
    ended_on: '2025',
  },
  {
    school: 'archbishop-riordan',
    title: 'National Merit Commended Student',
    kind: 'award',
    detail: 'National Merit Scholarship Corporation',
    ended_on: '2024',
  },

  // ---- not tied to a school ------------------------------------------------
  {
    school: null,
    title: "Dean's List Semi-Finalist",
    kind: 'award',
    detail: 'FIRST Robotics Competition',
    started_on: '2023',
    ended_on: '2024',
  },
  {
    school: null,
    title: "President's Volunteer Service Award, Gold",
    kind: 'award',
    ended_on: '2023',
  },
  {
    school: null,
    title: 'Certified Onshape Associate',
    kind: 'certification',
    detail: 'In progress',
  },
  {
    school: null,
    title: 'PADI Advanced Open Water, Enriched Air',
    kind: 'certification',
    detail: 'PADI',
  },
  {
    school: null,
    title: 'First Aid, CPR And AED',
    kind: 'certification',
    detail: 'American Red Cross',
  },
];

let schools = 0;
for (const s of SCHOOLS) {
  const existing = repo.getSchool(s.slug);
  if (existing && !FORCE) {
    console.log(`skipped ${s.slug}, already exists. Use --force to overwrite.`);
    continue;
  }
  repo.saveSchool(s.slug, s);
  console.log(`${existing ? 'updated' : 'created'} ${s.slug}`);
  schools += 1;
}

/*
 * Courses and activities are inserted only when missing, keyed on the same
 * columns as the unique index. A reseed must never duplicate a class list that
 * has since been edited by hand.
 */
let courses = 0;
for (const c of COURSES) {
  const dupe = db.get(
    `SELECT id FROM course WHERE school_slug = ? AND title = ? COLLATE NOCASE
       AND (term IS ? OR term = ? COLLATE NOCASE)`,
    c.school, c.title, c.term || null, c.term || null
  );
  if (dupe) continue;
  repo.saveCourse({ ...c, school_slug: c.school });
  courses += 1;
}

let activities = 0;
for (const a of ACTIVITIES) {
  const dupe = db.get('SELECT id FROM activity WHERE title = ? COLLATE NOCASE', a.title);
  if (dupe) continue;
  repo.saveActivity({ ...a, school_slug: a.school });
  activities += 1;
}

console.log(`\nschools: ${schools} written, courses: ${courses} added, activities: ${activities} added.`);

const flagged = db.all("SELECT code, title FROM course WHERE note LIKE '%to be filled in%'");
if (flagged.length) {
  console.log('\nNeeds a human before launch:');
  for (const f of flagged) console.log(`  ${f.code || ''} ${f.title}`);
  console.log('Terms for completed classes are also blank, by design rather than by omission.');
}

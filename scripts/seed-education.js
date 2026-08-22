'use strict';

/*
 * Seed the education record.
 *
 *   node scripts/seed-education.js             insert what is missing
 *   node scripts/seed-education.js --force     overwrite the schools too
 *   node scripts/seed-education.js --replace   rebuild the class and activity
 *                                              lists from this file
 *
 * Every line below comes from the CV, the resume, and the LinkedIn profile
 * record, which were uploaded and read directly. Where they differ, the CV
 * wins: it is the longest and the most recent, and the other two are summaries
 * of it. Course codes and catalogue titles are the CV's own.
 *
 * Two things are still incomplete rather than invented:
 *
 *   - Terms for completed classes. None of the three sources gives a term per
 *     class, so those rows have none and the page shows a term only where one
 *     exists.
 *   - MSE 104. It is named as a current class in the /now block and appears in
 *     none of the three documents, so it keeps its flag until somebody
 *     confirms the catalogue title.
 *
 * --replace exists because a corrected title is not a new class. Without it a
 * reseed adds "Statics and Strength of Materials" beside the older
 * "Statics And Strength Of Materials" and the page shows the class twice.
 */

const db = require('../src/db');
const repo = require('../src/repo');

db.assertEnvironment();
db.migrate();

const FORCE = process.argv.includes('--force');
const REPLACE = process.argv.includes('--replace');

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
      + 'materials, and computation, and an entrepreneurship minor planned. The '
      + 'classes below are the record; the projects are on the work index.',
  },
  {
    slug: 'archbishop-riordan',
    name: 'Archbishop Riordan High School',
    kind: 'high-school',
    credential: 'Diploma, Magna Cum Laude',
    location: 'San Francisco, CA',
    started_on: '2021-08',
    ended_on: '2025-05',
    honours: 'Magna Cum Laude · 4.321 weighted, 3.968 unweighted',
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
  { school: 'ucla', code: 'MECH&AE M20', title: 'Introduction to Computer Programming with MATLAB', term: 'Fall 2026', status: 'in-progress' },
  { school: 'ucla', code: 'MATH 32B', title: 'Calculus of Several Variables', term: 'Fall 2026', status: 'in-progress' },
  {
    school: 'ucla',
    code: 'MSE 104',
    title: 'Materials Science and Engineering 104',
    term: 'Fall 2026',
    status: 'in-progress',
    note: 'Named in the /now block and in none of the three documents. Catalogue title to be confirmed at /admin/education.',
  },

  // ---- UCLA, completed -----------------------------------------------------
  { school: 'ucla', code: 'CHEM 20A', title: 'Chemical Structure', status: 'completed' },
  { school: 'ucla', code: 'CHEM 20B', title: 'Chemical Energetics and Change', status: 'completed' },
  { school: 'ucla', code: 'EPS SCI 17', title: 'Dinosaurs and Their Relatives', status: 'completed' },
  { school: 'ucla', code: 'GEOG 4', title: 'Regional Development and World Economy', status: 'completed' },
  { school: 'ucla', code: 'MATH 31A', title: 'Differential and Integral Calculus', status: 'completed' },
  { school: 'ucla', code: 'MATH 31B', title: 'Integration and Infinite Series', status: 'completed' },
  { school: 'ucla', code: 'MATH 32A', title: 'Calculus of Several Variables', status: 'completed' },
  { school: 'ucla', code: 'MECH&AE 101', title: 'Statics and Strength of Materials', status: 'completed' },
  { school: 'ucla', code: 'PHYSICS 1A', title: 'Mechanics', status: 'completed' },
  { school: 'ucla', code: 'PHYSICS 1B', title: 'Oscillations, Waves, Electric and Magnetic Fields', status: 'completed' },
  { school: 'ucla', code: 'PHYSICS 4AL', title: 'Physics Laboratory: Mechanics', status: 'completed' },
  { school: 'ucla', code: 'STATS 10', title: 'Introduction to Statistical Reasoning', status: 'completed' },

  // ---- high school, Advanced Placement -------------------------------------
  // Eleven AP and honours subjects, which the CV notes is the maximum the
  // school allows a student to take.
  { school: 'archbishop-riordan', code: 'AP', title: 'AP Calculus AB', status: 'completed' },
  { school: 'archbishop-riordan', code: 'AP', title: 'AP Calculus BC', status: 'completed' },
  { school: 'archbishop-riordan', code: 'AP', title: 'AP Physics C: Mechanics', status: 'completed' },
  { school: 'archbishop-riordan', code: 'AP', title: 'AP Computer Science Principles', status: 'completed' },
  { school: 'archbishop-riordan', code: 'AP', title: 'AP Statistics', status: 'completed' },
  { school: 'archbishop-riordan', code: 'AP', title: 'AP Biology', status: 'completed' },
  { school: 'archbishop-riordan', code: 'AP', title: 'AP English Language and Composition', status: 'completed' },
  { school: 'archbishop-riordan', code: 'AP', title: 'AP United States History', status: 'completed' },
  { school: 'archbishop-riordan', code: 'AP', title: 'AP World History: Modern', status: 'completed' },

  // ---- high school, honours ------------------------------------------------
  { school: 'archbishop-riordan', code: 'Honours', title: 'World Literature Honors', status: 'completed' },
  { school: 'archbishop-riordan', code: 'Honours', title: 'Introduction to Composition and Literature Honors', status: 'completed' },

  // ---- high school, the four year Engineering Program ----------------------
  { school: 'archbishop-riordan', code: 'Engineering', title: 'Engineering Essentials', status: 'completed' },
  { school: 'archbishop-riordan', code: 'Engineering', title: 'Introduction to Engineering Design', status: 'completed' },
  { school: 'archbishop-riordan', code: 'Engineering', title: 'Civil Engineering and Architecture', status: 'completed' },
  { school: 'archbishop-riordan', code: 'Engineering', title: 'Engineering Capstone', status: 'completed' },
];

const ACTIVITIES = [
  // ---- UCLA ----------------------------------------------------------------
  { school: 'ucla', title: 'ASME at UCLA', kind: 'activity', role: 'Member',
    detail: 'American Society of Mechanical Engineers.', started_on: '2025' },
  { school: 'ucla', title: 'Westwood SolidWorks User Group', kind: 'activity', role: 'Member',
    detail: 'Dassault Systèmes.', started_on: '2025' },

  // ---- high school, what he did --------------------------------------------
  {
    school: 'archbishop-riordan',
    title: 'Armor Robotics 9143',
    kind: 'activity',
    role: 'Co-Founder and Team Captain',
    detail: 'Grew the programme from a school club to a recognised co-ed non-athletic varsity sport across three seasons.',
    started_on: '2022-01',
    ended_on: '2025-06',
  },
  { school: 'archbishop-riordan', title: 'READI Club', kind: 'activity', role: 'Co-Vice President',
    started_on: '2023-08', ended_on: '2025-06' },
  { school: 'archbishop-riordan', title: 'Comic Book Club', kind: 'activity', role: 'Vice President',
    started_on: '2023-08', ended_on: '2024-06' },
  { school: 'archbishop-riordan', title: 'Volunteer Tutor, Archbishop Riordan', kind: 'activity',
    detail: 'Mathematics and science, as National Honor Society service hours.',
    started_on: '2023-01', ended_on: '2025-05' },
  { school: 'archbishop-riordan', title: 'National Honor Society', kind: 'activity',
    started_on: '2022', ended_on: '2025' },
  { school: 'archbishop-riordan', title: 'California Scholarship Federation', kind: 'activity',
    started_on: '2022', ended_on: '2025' },
  { school: 'archbishop-riordan', title: 'Business Club', kind: 'activity', started_on: '2024', ended_on: '2025' },
  { school: 'archbishop-riordan', title: 'Math Circle', kind: 'activity', started_on: '2024', ended_on: '2025' },
  { school: 'archbishop-riordan', title: 'Junior Prom Planning Committee', kind: 'activity', started_on: '2024', ended_on: '2024' },
  { school: 'archbishop-riordan', title: 'D&D Club', kind: 'activity', started_on: '2023', ended_on: '2024' },
  { school: 'archbishop-riordan', title: 'Boys Volleyball Club', kind: 'activity', role: 'Setter',
    started_on: '2023', ended_on: '2023' },
  { school: 'archbishop-riordan', title: 'Varsity Tennis', kind: 'activity', started_on: '2022', ended_on: '2022' },
  { school: 'archbishop-riordan', title: 'Robotics Club', kind: 'activity', started_on: '2021', ended_on: '2022' },
  { school: 'archbishop-riordan', title: 'Voltaire Scholars Society', kind: 'activity', started_on: '2021', ended_on: '2022' },

  // ---- high school, what he was given --------------------------------------
  { school: 'archbishop-riordan', title: 'AP Scholar with Distinction', kind: 'award',
    detail: 'College Board.', started_on: '2024', ended_on: '2025' },
  { school: 'archbishop-riordan', title: 'National Merit Commended Student', kind: 'award',
    detail: 'National Merit Scholarship Corporation.', ended_on: '2024' },
  { school: 'archbishop-riordan', title: 'Academic Award in AP Statistics', kind: 'award', ended_on: '2025' },
  { school: 'archbishop-riordan', title: "President's Honor Roll", kind: 'award',
    started_on: '2023', ended_on: '2025' },
  { school: 'archbishop-riordan', title: 'St. Francis Scholar', kind: 'award',
    started_on: '2021', ended_on: '2025' },

  // ---- FIRST, which is not a school ----------------------------------------
  { school: null, title: 'Pumpkin Bots 8793', kind: 'activity', role: 'Mentor',
    detail: 'FIRST Robotics Competition. Student advisor 2024 to 2025, mentor since.', started_on: '2023' },
  { school: null, title: 'Mercy Mechs 18233', kind: 'activity', role: 'Mentor',
    detail: 'FIRST Tech Challenge.', started_on: '2026-07' },
  { school: null, title: 'White Hat Hackers 11230', kind: 'activity', role: 'Mentor',
    detail: 'FIRST Robotics Competition.', started_on: '2025-08', ended_on: '2026-04' },
  { school: null, title: 'Competition Volunteer, FIRST', kind: 'activity',
    detail: 'FRC, FTC, and FLL Challenge.', started_on: '2023-02' },
  { school: null, title: 'LGBTQ+ of FIRST', kind: 'activity', started_on: '2023', ended_on: '2025' },
  { school: null, title: 'FIRST For All Student Fellowship', kind: 'activity',
    detail: 'Armor Robotics 9143, FIRST California.', started_on: '2023', ended_on: '2024' },

  // ---- volleyball ----------------------------------------------------------
  { school: null, title: 'Academy of Volleyball', kind: 'activity', role: 'Setter, U18',
    detail: 'Assistant coach, U12 girls premier, December 2024 to May 2025.',
    started_on: '2024', ended_on: '2025' },
  { school: null, title: 'SF Elite Volleyball Club', kind: 'activity', role: 'Setter, U15 and U16',
    detail: 'Team captain, U15.', started_on: '2022', ended_on: '2024' },
  { school: null, title: 'Red Rock Volleyball Club', kind: 'activity', role: 'Setter, U14',
    detail: 'Team captain.', started_on: '2021', ended_on: '2022' },

  // ---- tutoring ------------------------------------------------------------
  { school: null, title: 'Healthy Cities Tutoring', kind: 'activity', role: 'Volunteer Tutor',
    detail: 'Elementary and junior high students in underserved communities.',
    started_on: '2022-12', ended_on: '2025-05' },

  // ---- awards that belong to no school -------------------------------------
  {
    school: null,
    title: "Dean's List Semi-Finalist",
    kind: 'award',
    detail: 'FIRST Robotics Competition.',
    started_on: '2023',
    ended_on: '2024',
  },
  { school: null, title: 'Gracious Professionalism, Five Recognitions', kind: 'award',
    detail: 'FIRST California.', started_on: '2023', ended_on: '2024' },
  {
    school: null,
    title: "President's Volunteer Service Award, Gold",
    kind: 'award',
    detail: 'AmeriCorps.',
    ended_on: '2023',
  },
  { school: null, title: 'Gold Medal, NCVA Boys Far Western National Qualifier', kind: 'award',
    detail: '16 USA.', ended_on: '2023' },
  { school: null, title: 'Gold Medal, Far Western No Dinx Boys Qualifier', kind: 'award',
    detail: '15 USA.', ended_on: '2023' },
  { school: null, title: 'Silver Medal, USA Volleyball National Championship', kind: 'award',
    detail: '15 USA.', ended_on: '2023' },

  // ---- certifications ------------------------------------------------------
  {
    school: null,
    title: 'Certified Onshape Associate',
    kind: 'certification',
    detail: 'In progress.',
  },
  {
    school: null,
    title: 'PADI Advanced Open Water, Enriched Air',
    kind: 'certification',
    detail: 'PADI.',
  },
  {
    school: null,
    title: 'First Aid, CPR, and AED',
    kind: 'certification',
    detail: 'American Red Cross.',
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
/*
 * --replace: a corrected title is not a new class. Without this a reseed leaves
 * both spellings on the page, and the reader cannot tell which one is current.
 */
if (REPLACE) {
  db.run('DELETE FROM course');
  db.run('DELETE FROM activity');
  console.log('cleared the class and activity lists');
}

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

'use strict';

/*
 * Seed the education record.
 *
 *   node scripts/seed-education.js             insert what is missing
 *   node scripts/seed-education.js --force     overwrite the schools too
 *   node scripts/seed-education.js --replace   rebuild the class and activity
 *                                              lists from this file
 *
 * The class lists come from the two official records: the UCLA degree audit
 * prepared 11 August 2026, and the Archbishop Riordan transcript printed 23
 * July 2025. Those replace what was here before, which was assembled from the
 * CV, the resume, and the LinkedIn profile record and had the current term
 * wrong: it named MECH&AE M20 and MATH 32B as in progress when both were taken
 * in Spring 2026, listed MSE 104, which appears nowhere in the audit and was
 * never enrolled, and marked the four classes actually enrolled for Fall 2026
 * as already completed.
 *
 * What is deliberately NOT carried across from those documents: grades, grade
 * point averages per class, unit counts per requirement, the student number,
 * the date of birth, and the home address. A transcript is a private record
 * that happens to contain a class list; only the class list belongs on a public
 * page. The one grade point average on this page is the high school one, which
 * was already published on the CV.
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
    name: 'University of California, Los Angeles',
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
      + 'allows, alongside the four year Engineering Program and its capstone. '
      + 'The list below is the whole transcript, not a selection from it.',
  },
];

/*
 * status is the load bearing field: in-progress is what the page puts first and
 * what the /now block quotes. It comes from the audit's own IP marker, so it is
 * the registrar's view of the current term rather than a hand-maintained list
 * that goes stale the moment a quarter ends.
 *
 * Terms are the audit's, mapped from its FA25/WI26/SP26/FA26 codes. The high
 * school transcript groups by academic year rather than by term, so those are
 * years.
 */
const COURSES = [
  // ---- UCLA, Fall 2026, enrolled -------------------------------------------
  { school: 'ucla', code: 'MECH&AE 101', title: 'Statics and Strength of Materials', term: 'Fall 2026', units: 4, status: 'in-progress' },
  { school: 'ucla', code: 'PHYSICS 1B', title: 'Oscillations, Waves, Electric and Magnetic Fields', term: 'Fall 2026', units: 5, status: 'in-progress' },
  { school: 'ucla', code: 'PHYSICS 4AL', title: 'Physics Laboratory: Mechanics', term: 'Fall 2026', units: 2, status: 'in-progress' },
  { school: 'ucla', code: 'STATS 10', title: 'Introduction to Statistical Reasoning', term: 'Fall 2026', units: 5, status: 'in-progress' },

  // ---- UCLA, Spring 2026 ---------------------------------------------------
  { school: 'ucla', code: 'MATH 32B', title: 'Calculus of Several Variables', term: 'Spring 2026', units: 4, status: 'completed' },
  { school: 'ucla', code: 'MECH&AE M20', title: 'Introduction to Computer Programming with MATLAB', term: 'Spring 2026', units: 4, status: 'completed' },
  { school: 'ucla', code: 'PHYSICS 1A', title: 'Mechanics', term: 'Spring 2026', units: 5, status: 'completed' },

  // ---- UCLA, Winter 2026 ---------------------------------------------------
  { school: 'ucla', code: 'CHEM 20B', title: 'Chemical Energetics and Change', term: 'Winter 2026', units: 4, status: 'completed' },
  { school: 'ucla', code: 'GEOG 4', title: 'Regional Development and World Economy', term: 'Winter 2026', units: 5, status: 'completed' },
  { school: 'ucla', code: 'MATH 31B', title: 'Integration and Infinite Series', term: 'Winter 2026', units: 4, status: 'completed' },
  { school: 'ucla', code: 'MATH 32A', title: 'Calculus of Several Variables', term: 'Winter 2026', units: 4, status: 'completed' },

  // ---- UCLA, Fall 2025, the first term -------------------------------------
  { school: 'ucla', code: 'CHEM 20A', title: 'Chemical Structure', term: 'Fall 2025', units: 4, status: 'completed' },
  { school: 'ucla', code: 'EPS SCI 17', title: 'Dinosaurs and Their Relatives', term: 'Fall 2025', units: 5, status: 'completed' },
  { school: 'ucla', code: 'MATH 31A', title: 'Differential and Integral Calculus', term: 'Fall 2025', units: 4, status: 'completed' },
  { school: 'ucla', code: 'MECH&AE 1', title: 'Undergraduate Seminar', term: 'Fall 2025', units: 1, status: 'completed' },

  /*
   * ---- high school ---------------------------------------------------------
   *
   * The complete transcript, all thirty three entries across four years, in the
   * school's own course titles. An earlier version listed only the Advanced
   * Placement subjects, the honours ones, and the Engineering Program, on the
   * argument that a portfolio is not a copy of the registrar's file. It reads
   * better complete: the religion sequence, the language sequence, and the arts
   * are what four years actually looked like, and leaving them out made the
   * record look curated rather than reported.
   *
   * Units are not carried. Riordan awards 10.00 for a year long class on its own
   * scale, which is not comparable to a UCLA quarter unit, and printing both in
   * the same column would invite the comparison.
   */

  // ---- 2024-25, senior year ------------------------------------------------
  { school: 'archbishop-riordan', code: 'AP', title: 'AP Calculus BC', term: '2024\u201325', status: 'completed' },
  { school: 'archbishop-riordan', code: 'AP', title: 'AP Computer Science Principles', term: '2024\u201325', status: 'completed' },
  { school: 'archbishop-riordan', code: 'AP', title: 'AP Physics C: Mechanics', term: '2024\u201325', status: 'completed' },
  { school: 'archbishop-riordan', code: 'AP', title: 'AP Statistics', term: '2024\u201325', status: 'completed' },
  { school: 'archbishop-riordan', code: 'Engineering', title: 'Engineering Capstone', term: '2024\u201325', status: 'completed' },
  { school: 'archbishop-riordan', code: 'Language', title: 'American Sign Language IV', term: '2024\u201325', status: 'completed' },
  { school: 'archbishop-riordan', code: 'English', title: 'California Dreaming', term: '2024\u201325', status: 'completed',
    note: 'A UC a-g approved English course.' },
  { school: 'archbishop-riordan', code: 'Religious Studies', title: 'World Religions of the East and West', term: '2024\u201325', status: 'completed' },
  { school: 'archbishop-riordan', code: 'Advisory', title: 'R-Time', term: '2024\u201325', status: 'completed' },

  // ---- 2023-24, junior year ------------------------------------------------
  { school: 'archbishop-riordan', code: 'AP', title: 'AP Biology', term: '2023\u201324', status: 'completed' },
  { school: 'archbishop-riordan', code: 'AP', title: 'AP Calculus AB', term: '2023\u201324', status: 'completed' },
  { school: 'archbishop-riordan', code: 'AP', title: 'AP English Language and Composition', term: '2023\u201324', status: 'completed' },
  { school: 'archbishop-riordan', code: 'AP', title: 'AP United States History', term: '2023\u201324', status: 'completed' },
  { school: 'archbishop-riordan', code: 'Engineering', title: 'Civil Engineering and Architecture', term: '2023\u201324', status: 'completed' },
  { school: 'archbishop-riordan', code: 'Language', title: 'American Sign Language III', term: '2023\u201324', status: 'completed' },
  { school: 'archbishop-riordan', code: 'Religious Studies', title: 'Life Issues: Ethics and Social Ethics', term: '2023\u201324', status: 'completed' },

  // ---- 2022-23, sophomore year ---------------------------------------------
  { school: 'archbishop-riordan', code: 'AP', title: 'AP World History: Modern', term: '2022\u201323', status: 'completed' },
  { school: 'archbishop-riordan', code: 'Honours', title: 'World Literature Honors', term: '2022\u201323', status: 'completed' },
  { school: 'archbishop-riordan', code: 'Engineering', title: 'Introduction to Engineering Design', term: '2022\u201323', status: 'completed' },
  { school: 'archbishop-riordan', code: 'Computing', title: 'Computer Programming with Python', term: '2022\u201323', status: 'completed' },
  { school: 'archbishop-riordan', code: 'Mathematics', title: 'Math Analysis', term: '2022\u201323', status: 'completed' },
  { school: 'archbishop-riordan', code: 'Science', title: 'Chemistry', term: '2022\u201323', status: 'completed' },
  { school: 'archbishop-riordan', code: 'Language', title: 'American Sign Language II', term: '2022\u201323', status: 'completed' },
  { school: 'archbishop-riordan', code: 'Religious Studies', title: 'Scripture and Church 2K', term: '2022\u201323', status: 'completed' },

  // ---- 2021-22, freshman year ----------------------------------------------
  { school: 'archbishop-riordan', code: 'Honours', title: 'Introduction to Composition and Literature Honors', term: '2021\u201322', status: 'completed' },
  { school: 'archbishop-riordan', code: 'Engineering', title: 'Engineering Essentials', term: '2021\u201322', status: 'completed' },
  { school: 'archbishop-riordan', code: 'Mathematics', title: 'Algebra II and Trigonometry', term: '2021\u201322', status: 'completed' },
  { school: 'archbishop-riordan', code: 'Science', title: 'Biology', term: '2021\u201322', status: 'completed' },
  { school: 'archbishop-riordan', code: 'Language', title: 'American Sign Language I', term: '2021\u201322', status: 'completed' },
  { school: 'archbishop-riordan', code: 'Social Studies', title: 'Global Ethnic Studies', term: '2021\u201322', status: 'completed' },
  { school: 'archbishop-riordan', code: 'Religious Studies', title: 'Marianist Education and Sacraments, and Hebrew Scripture', term: '2021\u201322', status: 'completed' },
  { school: 'archbishop-riordan', code: 'Arts', title: 'Dance I', term: '2021\u201322', status: 'completed' },
  { school: 'archbishop-riordan', code: 'Seminar', title: 'Lyceum: An Examination of Truth', term: '2021\u201322', status: 'completed' },
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

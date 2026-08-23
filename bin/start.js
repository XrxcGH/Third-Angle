#!/usr/bin/env node
'use strict';

/*
 * The entry point for a machine with no disk.
 *
 * `node server.js` is still the entry point everywhere else and is unchanged.
 * This one adds the two steps a container needs around it: pull the last
 * snapshot down before anything opens the database, and push snapshots back up
 * while running and once more on the way out.
 *
 * The ordering is the reason this is a separate file rather than a flag.
 * src/db opens the SQLite file at require time, and server.js requires it at
 * the top, so a restore inside server.js would be replacing a file that is
 * already open. Here the restore is awaited before server.js is required at
 * all.
 */

const backup = require('../src/backup');

async function main() {
  const started = Date.now();

  try {
    const result = await backup.restore();
    console.log('restore:', JSON.stringify(result), `${Date.now() - started}ms`);
  } catch (err) {
    /*
     * A failed restore is fatal, deliberately.
     *
     * Carrying on would open an empty database, run the migrations against it,
     * and serve an empty site — and then the first snapshot would push that
     * empty database over the real one. Exiting means the container restarts
     * and tries again, which is recoverable; the alternative is not.
     */
    console.error('restore failed, refusing to start:', err.message);
    process.exit(1);
  }

  const app = require('../server.js');
  const server = app.start();
  backup.schedule();

  /*
   * The container is sent SIGTERM when it goes to sleep, which happens after a
   * few minutes of no traffic — so this is the normal path, not the exceptional
   * one, and everything written since the last timer tick is only on a disk
   * that is about to be discarded.
   */
  let leaving = false;
  const drain = (signal) => async () => {
    if (leaving) return;
    leaving = true;
    console.log(`${signal} received, snapshotting before exit.`);
    backup.stop();
    try {
      console.log('final snapshot:', JSON.stringify(await backup.snapshot({ force: true })));
    } catch (err) {
      console.error('final snapshot failed:', err.message);
    }
    server.close(() => process.exit(0));
    setTimeout(() => process.exit(1), 15_000).unref();
  };

  /* Added before the handlers server.js installs would run to completion; both
     fire, and the first one to call process.exit wins. Ours does the upload. */
  process.on('SIGTERM', drain('SIGTERM'));
  process.on('SIGINT', drain('SIGINT'));
}

main();

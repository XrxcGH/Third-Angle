/*
 * The Worker in front of the container.
 *
 * Cloudflare Containers are driven by a Worker: the Worker receives the request
 * at the edge, and forwards it to a container instance backed by a Durable
 * Object. This file is that Worker, and it is deliberately almost empty. Every
 * decision the site makes — routing, rendering, sessions, security headers —
 * belongs to the Express app inside the container, so that the application is
 * identical whether it runs here, on a VPS, or on a laptop. Anything clever
 * added here would be behaviour that only exists in production.
 *
 * The one thing it does decide is WHICH container, and there is exactly one.
 */

import { Container } from '@cloudflare/containers';

/*
 * One instance, always.
 *
 * The site is a single SQLite file on the container's own disk. Two instances
 * would be two writers against two different copies of that file, and the
 * second one to snapshot would overwrite the first one's work. `getByName`
 * with a constant maps every request in the world to the same Durable Object,
 * and therefore to the same container.
 *
 * This is not a scaling limitation worth solving. The app is server-rendered
 * HTML with no client JavaScript; one small instance serves far more traffic
 * than a personal portfolio receives, and Cloudflare's cache sits in front of
 * it for the static assets.
 */
const INSTANCE = 'main';

export class ThirdAngle extends Container {
  defaultPort = 8080;

  /*
   * Long enough that a reader clicking through several pages never pays a cold
   * start, short enough that an idle site is not billed for memory it is not
   * using. Every request renews it.
   */
  sleepAfter = '15m';

  envVars = {};

  onStart() {
    console.log('container started');
  }

  onStop() {
    /*
     * The container has been sent SIGTERM and bin/start.js is uploading its
     * final snapshot to R2. Nothing to do here; it is logged so a lost write
     * can be correlated with a sleep in the logs.
     */
    console.log('container stopping');
  }

  onError(error) {
    console.error('container error:', error);
    throw error;
  }
}

export default {
  async fetch(request, env) {
    return env.THIRD_ANGLE.getByName(INSTANCE).fetch(request);
  },
};

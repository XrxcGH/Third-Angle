/*
 * Signature Version 4, against Amazon's own published examples.
 *
 * Signing is the part of the R2 client that cannot be checked by looking at it:
 * a mistake in the canonical request or the string to sign produces a
 * SignatureDoesNotMatch that names nothing, at deploy time, against a live
 * bucket. Amazon documents two complete worked examples with their expected
 * signatures, so the whole path — canonical request, string to sign, signing
 * key, signature — is verifiable offline.
 *
 * Source: AWS S3 API Reference, "Examples: Signature Calculations".
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createRequire } from 'node:module';

const require = createRequire(import.meta.url);
const s3 = require('../src/s3.js');

const KEY_ID = 'AKIAIOSFODNN7EXAMPLE';
const SECRET = 'wJalrXUtnFEMI/K7MDENG/bPxRfiCYEXAMPLEKEY';
const WHEN = new Date('2013-05-24T00:00:00Z');

test('GET Object matches the documented signature', () => {
  const r = s3.sign({
    method: 'GET',
    url: 'https://examplebucket.s3.amazonaws.com/test.txt',
    headers: { range: 'bytes=0-9' },
    body: '',
    accessKeyId: KEY_ID,
    secretAccessKey: SECRET,
    region: 'us-east-1',
    now: WHEN,
  });

  assert.equal(r.canonicalRequest, [
    'GET',
    '/test.txt',
    '',
    'host:examplebucket.s3.amazonaws.com',
    'range:bytes=0-9',
    'x-amz-content-sha256:e3b0c44298fc1c149afbf4c8996fb92427ae41e4649b934ca495991b7852b855',
    'x-amz-date:20130524T000000Z',
    '',
    'host;range;x-amz-content-sha256;x-amz-date',
    'e3b0c44298fc1c149afbf4c8996fb92427ae41e4649b934ca495991b7852b855',
  ].join('\n'));

  assert.equal(r.signature, 'f0e8bdb87c964420e857bd35b5d6ed310bd44f0170aba48dd91039c6036bdb41');
  assert.match(r.headers.authorization, /^AWS4-HMAC-SHA256 Credential=AKIAIOSFODNN7EXAMPLE\/20130524\/us-east-1\/s3\/aws4_request, /);
});

test('PUT Object with a body matches the documented signature', () => {
  const r = s3.sign({
    method: 'PUT',
    url: 'https://examplebucket.s3.amazonaws.com/test%24file.text',
    headers: { date: 'Fri, 24 May 2013 00:00:00 GMT', 'x-amz-storage-class': 'REDUCED_REDUNDANCY' },
    body: 'Welcome to Amazon S3.',
    accessKeyId: KEY_ID,
    secretAccessKey: SECRET,
    region: 'us-east-1',
    now: WHEN,
  });

  // The payload hash is computed from the body, not passed in.
  assert.match(r.canonicalRequest,
    /44ce7dd67c959e0d3524ffac1771dfbba87d2b6b4b4e99e42034a8b803f8b072$/);
  assert.equal(r.signature, '98ad721746da40c64f1a55b78f14c238d841ea1380cd77a1b5971af0ece108bd');
});

test('a query string is sorted and encoded the way the specification says', () => {
  // Sorted by key, then by value, and every reserved character encoded.
  const r = s3.sign({
    method: 'GET',
    url: 'https://examplebucket.s3.amazonaws.com/?prefix=docs%2F&max-keys=2&list-type=2',
    accessKeyId: KEY_ID, secretAccessKey: SECRET, region: 'us-east-1', now: WHEN,
  });
  const line = r.canonicalRequest.split('\n')[2];
  assert.equal(line, 'list-type=2&max-keys=2&prefix=docs%2F');
});

test('a key with characters encodeURIComponent leaves alone is still encoded', () => {
  /*
   * encodeURIComponent leaves ! ' ( ) * unescaped and SigV4 does not. A key
   * containing one of them would then be signed one way and sent another, and
   * the only symptom is a signature mismatch that says nothing about the key.
   */
  assert.equal(s3.uriEncode("photos/it's (2024)*.jpg", false),
    'photos/it%27s%20%282024%29%2A.jpg');
  assert.equal(s3.uriEncode('a/b', true), 'a%2Fb');
  assert.equal(s3.uriEncode('a/b', false), 'a/b');
});

test('the client is absent rather than broken when R2 is not configured', () => {
  // Development and a machine with its own disk both run without R2, and must
  // not have to special-case it beyond a null check.
  assert.equal(s3.fromEnv({}), null);
  assert.equal(s3.fromEnv({ R2_ACCOUNT_ID: 'x', R2_BUCKET: 'y' }), null);
  const b = s3.fromEnv({
    R2_ACCOUNT_ID: 'acct', R2_BUCKET: 'bucket',
    R2_ACCESS_KEY_ID: 'k', R2_SECRET_ACCESS_KEY: 's',
  });
  assert.ok(b);
  assert.equal(b.url('data/third-angle.db'),
    'https://acct.r2.cloudflarestorage.com/bucket/data/third-angle.db');
});

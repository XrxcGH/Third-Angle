'use strict';

/*
 * A minimal S3 client, for R2.
 *
 * Four operations — GET, PUT, DELETE, and list — signed with AWS Signature
 * Version 4 on node:crypto. The official SDK is 15 MB and several hundred
 * transitive packages to do this, and it is the only dependency in the tree
 * that would need a native binary on a platform this has to be portable to.
 * The same argument that produced the scrypt, TOTP, CSRF, and SMTP code in this
 * project applies here; see DESIGN.md, "no native dependencies".
 *
 * SigV4 is fiddly but it is completely specified, and the specification ships
 * with test vectors. tests/s3.test.mjs runs them, so a mistake in the canonical
 * request or the string to sign fails a test rather than a deploy.
 *
 * R2 specifics: the region is always "auto", the service is "s3", and the
 * endpoint is https://<account-id>.r2.cloudflarestorage.com. Requests are
 * path-style, because virtual-host style needs a DNS name per bucket.
 */

const crypto = require('node:crypto');

const sha256 = (data) => crypto.createHash('sha256').update(data).digest('hex');
const hmac = (key, data) => crypto.createHmac('sha256', key).update(data).digest();

const EMPTY_SHA256 = sha256('');

/*
 * Percent-encode for a canonical URI.
 *
 * encodeURIComponent leaves ! ' ( ) * alone and SigV4 does not, so a key
 * containing any of them signs one way and is sent another, and the request is
 * rejected with a signature mismatch that says nothing about why.
 */
function uriEncode(str, encodeSlash) {
  let out = '';
  for (const ch of Buffer.from(String(str), 'utf8')) {
    const c = String.fromCharCode(ch);
    if (/[A-Za-z0-9_.~-]/.test(c)) out += c;
    else if (c === '/') out += encodeSlash ? '%2F' : '/';
    else out += '%' + ch.toString(16).toUpperCase().padStart(2, '0');
  }
  return out;
}

/**
 * Sign one request. Exported so a test can check it against the AWS vectors
 * without a network call.
 *
 * `now` is injectable for the same reason.
 */
function sign({ method, url, headers = {}, body = '', accessKeyId, secretAccessKey, region = 'auto', service = 's3', now = new Date() }) {
  const u = new URL(url);
  const amzDate = now.toISOString().replace(/[:-]|\.\d{3}/g, '');
  const dateStamp = amzDate.slice(0, 8);

  const payloadHash = body === '' || body == null
    ? EMPTY_SHA256
    : sha256(Buffer.isBuffer(body) ? body : Buffer.from(body));

  const all = {
    ...headers,
    host: u.host,
    'x-amz-content-sha256': payloadHash,
    'x-amz-date': amzDate,
  };

  /* Canonical headers are lowercase, sorted, whitespace-collapsed. */
  const names = Object.keys(all).map((k) => k.toLowerCase()).sort();
  const canonicalHeaders = names
    .map((n) => `${n}:${String(all[Object.keys(all).find((k) => k.toLowerCase() === n)]).trim().replace(/\s+/g, ' ')}\n`)
    .join('');
  const signedHeaders = names.join(';');

  /* Query parameters are sorted by key, then by value, both encoded. */
  const query = [...u.searchParams.entries()]
    .map(([k, v]) => [uriEncode(k, true), uriEncode(v, true)])
    .sort((a, b) => (a[0] === b[0] ? (a[1] < b[1] ? -1 : 1) : (a[0] < b[0] ? -1 : 1)))
    .map(([k, v]) => `${k}=${v}`)
    .join('&');

  const canonicalRequest = [
    method,
    uriEncode(decodeURIComponent(u.pathname), false),
    query,
    canonicalHeaders,
    signedHeaders,
    payloadHash,
  ].join('\n');

  const scope = `${dateStamp}/${region}/${service}/aws4_request`;
  const stringToSign = [
    'AWS4-HMAC-SHA256',
    amzDate,
    scope,
    sha256(canonicalRequest),
  ].join('\n');

  const signingKey = hmac(hmac(hmac(hmac(`AWS4${secretAccessKey}`, dateStamp), region), service), 'aws4_request');
  const signature = crypto.createHmac('sha256', signingKey).update(stringToSign).digest('hex');

  return {
    headers: {
      ...all,
      authorization: `AWS4-HMAC-SHA256 Credential=${accessKeyId}/${scope}, `
        + `SignedHeaders=${signedHeaders}, Signature=${signature}`,
    },
    canonicalRequest,
    stringToSign,
    signature,
  };
}

/**
 * A bucket, configured from the environment.
 *
 * Returns null when R2 is not configured, which is the normal case in
 * development and on a machine with its own disk. Every caller treats null as
 * "no remote store" rather than as an error, so the app runs unchanged without
 * it.
 */
function fromEnv(env = process.env) {
  const account = env.R2_ACCOUNT_ID;
  const bucket = env.R2_BUCKET;
  const accessKeyId = env.R2_ACCESS_KEY_ID;
  const secretAccessKey = env.R2_SECRET_ACCESS_KEY;
  if (!account || !bucket || !accessKeyId || !secretAccessKey) return null;
  return new Bucket({
    endpoint: env.R2_ENDPOINT || `https://${account}.r2.cloudflarestorage.com`,
    bucket, accessKeyId, secretAccessKey,
  });
}

class Bucket {
  constructor({ endpoint, bucket, accessKeyId, secretAccessKey, region = 'auto' }) {
    this.endpoint = endpoint.replace(/\/+$/, '');
    this.bucket = bucket;
    this.accessKeyId = accessKeyId;
    this.secretAccessKey = secretAccessKey;
    this.region = region;
  }

  url(key = '', search = '') {
    const path = key ? `/${this.bucket}/${uriEncode(key, false)}` : `/${this.bucket}`;
    return `${this.endpoint}${path}${search}`;
  }

  async request(method, key, { body, headers, search } = {}) {
    const url = this.url(key, search);
    const signed = sign({
      method, url, headers, body,
      accessKeyId: this.accessKeyId,
      secretAccessKey: this.secretAccessKey,
      region: this.region,
    });
    const res = await fetch(url, { method, headers: signed.headers, body: body || undefined });
    return res;
  }

  /** The object's bytes, or null if it is not there. */
  async get(key) {
    const res = await this.request('GET', key);
    if (res.status === 404) return null;
    if (!res.ok) throw new Error(`R2 GET ${key}: ${res.status} ${await res.text()}`);
    return Buffer.from(await res.arrayBuffer());
  }

  async put(key, body, contentType = 'application/octet-stream') {
    const buf = Buffer.isBuffer(body) ? body : Buffer.from(body);
    const res = await this.request('PUT', key, {
      body: buf,
      headers: { 'content-type': contentType, 'content-length': String(buf.length) },
    });
    if (!res.ok) throw new Error(`R2 PUT ${key}: ${res.status} ${await res.text()}`);
    return true;
  }

  async delete(key) {
    const res = await this.request('DELETE', key);
    if (!res.ok && res.status !== 404) throw new Error(`R2 DELETE ${key}: ${res.status}`);
    return true;
  }

  /**
   * Every key under a prefix, following continuation tokens.
   *
   * The response is XML. Parsing it with a regex is normally a mistake, but
   * ListObjectsV2 returns a flat, machine-generated document whose <Key>
   * elements contain XML-escaped text and nothing else, and the alternative is
   * a parser dependency for one call site.
   */
  async list(prefix = '') {
    const keys = [];
    let token = null;
    do {
      const search = `?list-type=2&prefix=${uriEncode(prefix, true)}&max-keys=1000`
        + (token ? `&continuation-token=${uriEncode(token, true)}` : '');
      const res = await this.request('GET', '', { search });
      if (!res.ok) throw new Error(`R2 LIST ${prefix}: ${res.status} ${await res.text()}`);
      const xml = await res.text();
      for (const m of xml.matchAll(/<Key>([\s\S]*?)<\/Key>/g)) keys.push(unescapeXml(m[1]));
      const next = /<NextContinuationToken>([\s\S]*?)<\/NextContinuationToken>/.exec(xml);
      token = /<IsTruncated>true<\/IsTruncated>/.test(xml) && next ? unescapeXml(next[1]) : null;
    } while (token);
    return keys;
  }
}

const unescapeXml = (s) => s
  .replace(/&lt;/g, '<').replace(/&gt;/g, '>')
  .replace(/&quot;/g, '"').replace(/&apos;/g, "'")
  .replace(/&amp;/g, '&');

module.exports = { Bucket, fromEnv, sign, uriEncode };

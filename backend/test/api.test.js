import { test, before, after, beforeEach } from 'node:test';
import assert from 'node:assert/strict';
import request from 'supertest';
import { io as ioClient } from 'socket.io-client';
import { pool, resetDb, makeUser, startServer, HANIFAH, DESERT, jitter } from './helpers.js';

let srv;
before(async () => { srv = await startServer(); });
after(async () => { await srv.close(); await pool.end(); });
beforeEach(resetDb);

const api = () => request(srv.url);
const report = (pos, extra = {}) => ({ title: 'سيل جارف', intensity: 4, ...pos, ...extra });

test('register + login + me', async () => {
  const reg = await api().post('/api/auth/register').send({ email: 'Ali@Example.com', password: 'password123' });
  assert.equal(reg.status, 201);
  assert.equal(reg.body.user.email, 'ali@example.com');
  assert.equal(reg.body.user.role, 'reporter');

  assert.equal((await api().post('/api/auth/register').send({ email: 'ali@example.com', password: 'password123' })).status, 409);
  assert.equal((await api().post('/api/auth/login').send({ email: 'ali@example.com', password: 'wrong-pass' })).status, 401);

  const login = await api().post('/api/auth/login').send({ email: 'ali@example.com', password: 'password123' });
  assert.equal(login.status, 200);
  const me = await api().get('/api/auth/me').set('Authorization', `Bearer ${login.body.token}`);
  assert.equal(me.body.trust_score, 0.5);
});

test('validation: rejects bad input and locations outside Saudi Arabia', async () => {
  const res = await api().post('/api/reports').send({ title: 'x', intensity: 9, latitude: 51.5, longitude: -0.1 });
  assert.equal(res.status, 400);
  assert.deepEqual(Object.keys(res.body.details).sort(), ['intensity', 'location', 'title']);
});

test('report on a valley scores higher than one in open desert', async () => {
  const onValley = await api().post('/api/reports').send(report(HANIFAH));
  const desert = await api().post('/api/reports').send(report(DESERT));
  assert.equal(onValley.status, 201);
  assert.equal(onValley.body.valley_name_ar, 'وادي حنيفة');
  assert.equal(desert.body.valley_name_ar, null);
  assert.ok(onValley.body.confidence_score > desert.body.confidence_score);
  // public response must not leak internals
  assert.equal(onValley.body.user_id, undefined);
  assert.equal(onValley.body.reporter_email, undefined);
});

test('same user reporting the same spot twice is a duplicate', async () => {
  const u = await makeUser('dup@x.com');
  const auth = { Authorization: `Bearer ${u.token}` };
  assert.equal((await api().post('/api/reports').set(auth).send(report(HANIFAH))).status, 201);
  const second = await api().post('/api/reports').set(auth).send(report(jitter(HANIFAH, 0.0005)));
  assert.equal(second.status, 409);
  assert.equal(second.body.error, 'duplicate_report');
});

test('corroboration from independent reporters auto-verifies, admin sockets get live events + cluster alert', async (t) => {
  const admin = await makeUser('admin@x.com', 'admin');
  const users = await Promise.all([1, 2, 3, 4, 5].map((i) => makeUser(`u${i}@x.com`)));

  const sock = ioClient(srv.url, { auth: { token: admin.token }, transports: ['websocket'] });
  await new Promise((r) => sock.on('connect', r));
  const events = { new: [], updated: [], alerts: [] };
  sock.on('report:new', (r) => events.new.push(r));
  sock.on('report:updated', (r) => events.updated.push(r));
  sock.on('cluster:alert', (c) => events.alerts.push(c));

  const publicSock = ioClient(srv.url, { transports: ['websocket'] });
  t.after(() => { sock.close(); publicSock.close(); });   // close even if an assertion fails
  await new Promise((r) => publicSock.on('connect', r));
  const publicVerified = [];
  publicSock.on('report:verified', (r) => publicVerified.push(r));
  publicSock.on('report:new', () => assert.fail('public socket must not receive admin events'));

  for (const [i, u] of users.entries()) {
    const res = await api().post('/api/reports')
      .set('Authorization', `Bearer ${u.token}`)
      .send(report(jitter(HANIFAH, i * 0.001)));
    assert.equal(res.status, 201);
  }
  await srv.realtime.checkClusters();
  await new Promise((r) => setTimeout(r, 100));

  const { rows } = await pool.query('SELECT status, auto_verified, corroboration_count FROM reports ORDER BY id');
  assert.ok(rows.every((r) => r.status === 'verified' && r.auto_verified), JSON.stringify(rows));
  // the first report auto-verifies once 3 others corroborate it (verified reports are not re-scored)
  assert.ok(rows[0].corroboration_count >= 3);
  assert.equal(rows.at(-1).corroboration_count, 4);

  assert.equal(events.new.length, 5);
  assert.ok(events.updated.length > 0, 'neighbours were re-scored and broadcast');
  assert.equal(events.alerts.length, 1);
  assert.equal(events.alerts[0].reporter_count, 5);
  assert.equal(events.alerts[0].valley_name_ar, 'وادي حنيفة');
  assert.ok(publicVerified.length >= 5);
  assert.equal(publicVerified[0].user_id, undefined);

});

test('admin review updates reporter trust; non-admins are blocked', async () => {
  const admin = await makeUser('admin@x.com', 'admin');
  const u = await makeUser('liar@x.com');
  const created = await api().post('/api/reports').set('Authorization', `Bearer ${u.token}`).send(report(DESERT));

  assert.equal((await api().patch(`/api/reports/${created.body.id}/status`)
    .set('Authorization', `Bearer ${u.token}`).send({ status: 'verified' })).status, 403);

  const res = await api().patch(`/api/reports/${created.body.id}/status`)
    .set('Authorization', `Bearer ${admin.token}`).send({ status: 'rejected' });
  assert.equal(res.status, 200);
  assert.equal(res.body.status, 'rejected');
  assert.equal(res.body.reporter_trust, 0.4); // (0+2)/(0+1+2+2)
});

test('viewport: public sees verified only; admin can list pending, sorted and filtered', async () => {
  const admin = await makeUser('admin@x.com', 'admin');
  await api().post('/api/reports').send(report(HANIFAH));
  const riyadhBbox = '46.4,24.4,47.0,25.0';

  const pub = await api().get(`/api/reports/viewport?bbox=${riyadhBbox}`);
  assert.equal(pub.status, 200);
  assert.equal(pub.body.length, 0);

  const adm = await api().get(`/api/reports/viewport?bbox=${riyadhBbox}&status=pending`)
    .set('Authorization', `Bearer ${admin.token}`);
  assert.equal(adm.body.length, 1);

  const outside = await api().get('/api/reports/viewport?bbox=39,21,40,22&status=pending')
    .set('Authorization', `Bearer ${admin.token}`);
  assert.equal(outside.body.length, 0);

  const list = await api().get('/api/reports?status=pending&sort=confidence&search=حنيفة')
    .set('Authorization', `Bearer ${admin.token}`);
  assert.equal(list.body.total, 1);
  assert.equal(list.body.reports[0].valley_name_ar, 'وادي حنيفة');

  assert.equal((await api().get('/api/reports')).status, 401);
  assert.equal((await api().get('/api/reports/viewport?bbox=bad')).status, 400);
});

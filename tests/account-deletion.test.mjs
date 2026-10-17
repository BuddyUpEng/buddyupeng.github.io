import test from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { DeletionController, DeletionError, PhoneVerificationCleanup, safeError } from '../static/delete-account/deletion-core.mjs';

const op = '11111111-1111-4111-8111-111111111111';
const nextOp = '22222222-2222-4222-8222-222222222222';
const a = () => ({ uid: 'synthetic-a', isAnonymous: false });
const b = () => ({ uid: 'synthetic-b', isAnonymous: false });
const deferred = () => { let resolve; const promise = new Promise((r) => { resolve = r; }); return { promise, resolve }; };
function harness(overrides = {}) {
  let user = a(); let refreshes = 0; let signsOut = 0; const requests = [];
  const controller = new DeletionController({ currentUser: () => user,
    refreshToken: async () => { refreshes++; },
    request: async (payload) => { requests.push(payload); return { status: 'deleting', requestId: payload.operationId }; },
    signOut: async () => { signsOut++; user = null; controller.authChanged(null); },
    uuid: () => op, ...overrides });
  return { controller, requests, get refreshes() { return refreshes; }, get signsOut() { return signsOut; },
    get user() { return user; }, change(value) { user = value; controller.authChanged(value); } };
}
test('explicit confirmation is required before token refresh or callable dispatch', async () => {
  const h = harness(); await assert.rejects(h.controller.submit(false), { code: 'confirmation-required' });
  assert.equal(h.refreshes, 0); assert.deepEqual(h.requests, []);
});
test('signed-out and anonymous sessions cannot request deletion', async () => {
  for (const user of [null, { uid: 'anonymous', isAnonymous: true }]) {
    const h = harness(); h.change(user); await assert.rejects(h.controller.submit(true), { code: 'account-changed' });
    assert.deepEqual(h.requests, []);
  }
});
test('refresh precedes exact owner-bound request; accepted deletion signs out', async () => {
  const h = harness(); const result = await h.controller.submit(true);
  assert.equal(h.refreshes, 1); assert.equal(h.signsOut, 1);
  assert.deepEqual(h.requests, [{ expectedUid: 'synthetic-a', operationId: op, confirmed: true }]);
  assert.equal(result.status, 'deleting'); assert.equal(result.signedOut, true);
});
test('owner change during token refresh prevents any dispatch', async () => {
  const gate = deferred(); const h = harness({ refreshToken: () => gate.promise });
  const request = h.controller.submit(true); h.change(b()); gate.resolve();
  await assert.rejects(request, { code: 'account-changed' }); assert.deepEqual(h.requests, []);
});
test('A-to-B-to-A change remains invalidated during token refresh', async () => {
  const gate = deferred(); const h = harness({ refreshToken: () => gate.promise }); const original = h.user;
  const request = h.controller.submit(true); h.change(b()); h.change(original); gate.resolve();
  await assert.rejects(request, { code: 'account-changed' }); assert.deepEqual(h.requests, []);
});
test('late response cannot accept or sign out a different account', async () => {
  const gate = deferred(); const h = harness({ request: () => gate.promise });
  const request = h.controller.submit(true); await Promise.resolve(); h.change(b());
  gate.resolve({ status: 'complete', requestId: op });
  await assert.rejects(request, { code: 'account-changed' }); assert.equal(h.signsOut, 0); assert.equal(h.controller.accepted, null);
});
test('uncertain transport retry reuses operation ID and the valid cached session', async () => {
  const payloads = []; let attempts = 0;
  const h = harness({ request: async (payload) => { payloads.push(payload); if (++attempts === 1) throw { code: 'functions/unavailable' }; return { status: 'deleting', requestId: op }; } });
  await assert.rejects(h.controller.submit(true)); assert.equal(h.signsOut, 0);
  await h.controller.submit(true); assert.equal(h.refreshes, 1); assert.deepEqual(payloads[0], payloads[1]);
});
test('recent-login recovery refreshes again but preserves the same operation', async () => {
  let attempts = 0; const payloads = [];
  const h = harness({ request: async (payload) => { payloads.push(payload); if (++attempts === 1) throw { code: 'functions/failed-precondition', details: { reason: 'recent-login-required' } }; return { status: 'deleting', requestId: op }; } });
  await assert.rejects(h.controller.submit(true), { code: 'recent-login-required' });
  h.change(null); h.change(a()); await h.controller.submit(true);
  assert.equal(h.refreshes, 2); assert.deepEqual(payloads[0], payloads[1]);
});
test('another account cannot inherit the original operation ID', async () => {
  let sequence = 0; const payloads = [];
  const h = harness({ uuid: () => ++sequence === 1 ? op : nextOp,
    request: async (payload) => { payloads.push(payload); throw { code: 'functions/unavailable' }; } });
  await assert.rejects(h.controller.submit(true)); h.change(b()); await assert.rejects(h.controller.submit(true));
  assert.equal(payloads[1].expectedUid, 'synthetic-b'); assert.equal(payloads[1].operationId, nextOp);
});
test('malformed success remains uncertain and never signs out', async () => {
  for (const result of [{ status: 'queued', requestId: op }, { status: 'complete', requestId: 'invalid' }]) {
    const h = harness({ request: async () => result });
    await assert.rejects(h.controller.submit(true), { code: 'uncertain-result' }); assert.equal(h.signsOut, 0);
  }
});
test('existing server request may return its original request ID', async () => {
  const h = harness({ request: async () => ({ status: 'complete', requestId: nextOp }) });
  assert.equal((await h.controller.submit(true)).requestId, nextOp);
});
test('a local sign-out failure does not erase accepted deletion or claim sign-out', async () => {
  const h = harness({ signOut: async () => { throw new Error('synthetic'); } });
  const result = await h.controller.submit(true); assert.equal(result.status, 'deleting'); assert.equal(result.signedOut, false);
});
test('duplicate click cannot dispatch another request', async () => {
  const gate = deferred(); let count = 0;
  const h = harness({ request: () => { count++; return gate.promise; } });
  const first = h.controller.submit(true); await Promise.resolve();
  await assert.rejects(h.controller.submit(true), { code: 'busy' });
  gate.resolve({ status: 'deleting', requestId: op }); await first; assert.equal(count, 1);
});
test('raw server error text and unknown details never appear in user copy', () => {
  const message = safeError({ code: 'functions/unavailable', message: '<script>private-token</script>', details: { token: 'private-token' } });
  assert.match(message, /may already be processing/); assert.doesNotMatch(message, /private-token|script/);
});
function phoneHarness(overrides = {}) {
  let user = a(); let generation = 1; let signsOut = 0; const removals = [];
  const change = (next) => { if (user !== next) generation++; user = next; };
  const cleanup = new PhoneVerificationCleanup({ currentUser: () => user,
    generation: () => generation,
    removeUser: async (target) => { removals.push(target); change(null); },
    signOut: async () => { signsOut++; change(null); }, ...overrides });
  return { cleanup, removals, change, get user() { return user; }, get signsOut() { return signsOut; } };
}
test('a verified new phone record is removed without any app-deletion request', async () => {
  const h = phoneHarness(); const user = h.user;
  assert.equal(h.cleanup.capture(user, true), false);
  await h.cleanup.cleanup();
  assert.deepEqual(h.removals, [user]); assert.equal(h.user, null);
  assert.equal(h.cleanup.pending, null); assert.equal(h.signsOut, 0);
});
test('an existing phone account never enters verification rollback', async () => {
  const h = phoneHarness(); assert.equal(h.cleanup.capture(h.user, false), true);
  await assert.rejects(h.cleanup.cleanup(), { code: 'account-changed' });
  assert.deepEqual(h.removals, []); assert.equal(h.signsOut, 0);
});
test('missing phone classification fails closed without deleting any record', async () => {
  for (const classification of [null, undefined, 'true', 1]) {
    const h = phoneHarness();
    assert.throws(() => h.cleanup.capture(h.user, classification), { code: 'unverified-login-result' });
    assert.deepEqual(h.removals, []); assert.equal(h.cleanup.pending, null);
  }
});
test('a changed owner cannot be captured or deleted as a new phone record', async () => {
  const h = phoneHarness(); const old = h.user; h.change(b());
  assert.throws(() => h.cleanup.capture(old, true), { code: 'account-changed' });
  assert.deepEqual(h.removals, []);
});
test('new-phone rollback is invalidated by an A-to-B-to-A switch before dispatch', async () => {
  const h = phoneHarness(); const old = h.user; h.cleanup.capture(old, true);
  h.change(b()); h.change(old);
  assert.equal(h.cleanup.canRetry, false);
  await assert.rejects(h.cleanup.cleanup(), { code: 'account-changed' });
  assert.deepEqual(h.removals, []); assert.equal(h.signsOut, 0);
});
test('identity change during rollback never signs out a later account or reports cleanup success', async () => {
  const gate = deferred(); const targets = [];
  const h = phoneHarness({ removeUser: (user) => { targets.push(user); return gate.promise; } });
  const original = h.user; h.cleanup.capture(original, true);
  const result = h.cleanup.cleanup(); const next = b(); h.change(next); gate.resolve();
  await assert.rejects(result, { code: 'account-changed' });
  assert.deepEqual(targets, [original]); assert.equal(h.signsOut, 0);
  assert.equal(h.user, next); assert.equal(h.cleanup.canRetry, false);
});
test('uncertain new-phone removal retains the exact record for guarded retry', async () => {
  let attempts = 0; const targets = [];
  const h = phoneHarness({ removeUser: async (user) => {
    targets.push(user); if (++attempts === 1) throw { code: 'auth/network-request-failed' };
    h.change(null);
  } });
  const original = h.user; h.cleanup.capture(original, true);
  await assert.rejects(h.cleanup.cleanup(), { code: 'verification-cleanup-unconfirmed' });
  assert.equal(h.cleanup.pending.removed, false); assert.equal(h.cleanup.canRetry, true);
  assert.equal(h.signsOut, 0);
  await h.cleanup.cleanup(); assert.deepEqual(targets, [original, original]);
  assert.equal(h.cleanup.pending, null);
  const message = safeError({ code: 'verification-cleanup-unconfirmed', message: 'private-token' });
  assert.match(message, /could not confirm/); assert.match(message, /No BuddysCo app deletion was requested/);
  assert.doesNotMatch(message, /private-token|was removed/);
});
test('retry after rollback failure cannot remove a newly selected account', async () => {
  let attempts = 0;
  const h = phoneHarness({ removeUser: async () => { attempts++; throw new Error('synthetic'); } });
  h.cleanup.capture(h.user, true);
  await assert.rejects(h.cleanup.cleanup(), { code: 'verification-cleanup-unconfirmed' }); h.change(b());
  await assert.rejects(h.cleanup.cleanup(), { code: 'account-changed' });
  assert.equal(attempts, 1); assert.equal(h.signsOut, 0);
});
test('sign-out retry never repeats a confirmed new-record removal', async () => {
  let removals = 0; let signsOut = 0;
  const h = phoneHarness({ removeUser: async () => { removals++; }, signOut: async () => {
    if (++signsOut === 1) throw new Error('synthetic'); h.change(null);
  } });
  h.cleanup.capture(h.user, true);
  await assert.rejects(h.cleanup.cleanup(), { code: 'verification-cleanup-unconfirmed' });
  assert.equal(h.cleanup.pending.removed, true);
  await h.cleanup.cleanup(); assert.equal(removals, 1); assert.equal(signsOut, 2);
});
async function pageHarness({ newPhone = false, phoneResultGate = null, cleanupError = false } = {}) {
  const html = await readFile(new URL('../static/delete-account/index.html', import.meta.url), 'utf8');
  const source = await readFile(new URL('../static/delete-account/delete-account.mjs', import.meta.url), 'utf8');
  const elements = new Map([...html.matchAll(/id="([^"]+)"/g)].map(([, id]) => [id, {
    hidden: false, disabled: false, checked: false, value: '', textContent: '', handlers: {},
    addEventListener(name, handler) { this.handlers[name] = handler; }, focus() {},
  }]));
  const auth = { currentUser: null }; let observer; let removals = 0; const requests = [];
  const user = { ...a(), phoneNumber: '+15555550100', getIdToken: async () => 'synthetic-token' };
  const change = (next) => { auth.currentUser = next; observer?.(next); };
  const testSdk = {
    initializeApp: () => ({}), initializeAuth: () => auth, inMemoryPersistence: {}, getFunctions: () => ({}),
    onAuthStateChanged: (_, callback) => { observer = callback; callback(null); },
    RecaptchaVerifier: class { clear() {} },
    signInWithPhoneNumber: async () => ({ confirm: async () => {
      change(user); if (phoneResultGate) await phoneResultGate.promise; return { user };
    } }),
    signInWithEmailAndPassword: async () => { change(user); return { user }; },
    getAdditionalUserInfo: () => ({ isNewUser: newPhone }),
    deleteUser: async (target) => { assert.equal(target, user); removals++; if (cleanupError) throw new Error('synthetic'); change(null); },
    signOut: async () => change(null),
    httpsCallable: () => async (payload) => { requests.push(payload); return { data: { status: 'deleting', requestId: op } }; },
  };
  // Replace module imports only in this local test evaluation. The shipped
  // source has no runtime switch or reachable synthetic authentication path.
  const body = source.replace(/^import .* from '\.\/deletion-core\.mjs';$/m,
    'const { DeletionController, DeletionError, PhoneVerificationCleanup, safeError } = testCore;')
    .replace(/import\('https:\/\/www\.gstatic\.com\/firebasejs\/12\.19\.0\/firebase-[a-z]+\.js'\)/g, 'Promise.resolve(testSdk)');
  const AsyncFunction = Object.getPrototypeOf(async function () {}).constructor;
  await new AsyncFunction('testSdk', 'testCore', 'document', 'crypto', body)(testSdk,
    { DeletionController, DeletionError, PhoneVerificationCleanup, safeError },
    { getElementById: (id) => elements.get(id) }, { randomUUID: () => op });
  const settle = async () => { for (let i = 0; i < 20; i++) await Promise.resolve(); };
  const emit = async (id, event = 'submit') => { elements.get(id).handlers[event]({ preventDefault() {} }); await settle(); };
  return { elements, emit, settle, change, requests, user, get removals() { return removals; } };
}
test('page keeps a new phone account hidden before classification and rolls it back without a callable', async () => {
  const gate = deferred(); const h = await pageHarness({ newPhone: true, phoneResultGate: gate });
  await h.emit('phone-form'); await h.emit('code-form');
  assert.equal(h.elements.get('confirmation-section').hidden, true);
  assert.equal(h.elements.get('delete-button').disabled, true);
  h.elements.get('confirm').checked = true; await h.emit('delete-button', 'click');
  assert.deepEqual(h.requests, []);
  gate.resolve(); await h.settle();
  assert.equal(h.removals, 1); assert.deepEqual(h.requests, []);
  assert.equal(h.elements.get('confirmation-section').hidden, true);
  assert.match(h.elements.get('status').textContent, /No existing account was found.*No BuddysCo app data was deleted/);
});
test('page offers only cleanup retry when new-phone rollback is uncertain', async () => {
  const h = await pageHarness({ newPhone: true, cleanupError: true });
  await h.emit('phone-form'); await h.emit('code-form');
  assert.equal(h.elements.get('confirmation-section').hidden, true);
  assert.equal(h.elements.get('verification-section').hidden, false);
  assert.equal(h.elements.get('retry-verification').disabled, false);
  assert.match(h.elements.get('status').textContent, /could not confirm/);
  await h.emit('retry-verification', 'click'); assert.equal(h.removals, 2); assert.deepEqual(h.requests, []);
  h.change(b()); await h.settle(); assert.equal(h.elements.get('retry-verification').disabled, true);
  await h.emit('retry-verification', 'click'); assert.equal(h.removals, 2);
});
test('page invalidates a delayed phone result after A-to-B-to-A without rollback or confirmation', async () => {
  const gate = deferred(); const h = await pageHarness({ newPhone: true, phoneResultGate: gate });
  await h.emit('phone-form'); await h.emit('code-form');
  h.change(b()); h.change(h.user); gate.resolve(); await h.settle();
  assert.equal(h.removals, 0); assert.deepEqual(h.requests, []);
  assert.equal(h.elements.get('confirmation-section').hidden, true);
  assert.equal(h.elements.get('unverified-section').hidden, false);
  assert.match(h.elements.get('status').textContent, /account changed/);
});
test('existing phone users still explicitly confirm before the owner-bound app-deletion callable', async () => {
  const h = await pageHarness(); await h.emit('phone-form'); await h.emit('code-form');
  assert.equal(h.removals, 0); assert.equal(h.elements.get('confirmation-section').hidden, false);
  await h.emit('delete-button', 'click'); assert.deepEqual(h.requests, []);
  h.elements.get('confirm').checked = true; await h.emit('delete-button', 'click');
  assert.deepEqual(h.requests, [{ expectedUid: 'synthetic-a', operationId: op, confirmed: true }]);
});
test('shipped page has no emulator/test mode, persistent auth, analytics, or signup API', async () => {
  const source = await readFile(new URL('../static/delete-account/delete-account.mjs', import.meta.url), 'utf8');
  const html = await readFile(new URL('../static/delete-account/index.html', import.meta.url), 'utf8');
  assert.match(source, /12\.19\.0\/firebase-auth\.js/); assert.match(source, /persistence: authSdk\.inMemoryPersistence/);
  assert.doesNotMatch(source, /connectAuthEmulator|connectFunctionsEmulator|localStorage|sessionStorage|createUserWith|firebase-analytics|console\./);
  assert.match(html, /Content-Security-Policy/); assert.match(html, /referrer" content="no-referrer/);
  assert.match(html, /id="email-fields" disabled/); assert.match(html, /id="delete-button"[^>]*disabled/);
  assert.match(source, /getAdditionalUserInfo\(result\)\?\.isNewUser/);
  assert.match(source, /auth\.currentUser !== verifiedUser \|\| phoneCleanup\?\.pending/);
  assert.match(html, /id="verification-section"[^>]*hidden/);
});

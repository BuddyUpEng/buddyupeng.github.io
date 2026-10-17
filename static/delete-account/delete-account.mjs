import { DeletionController, DeletionError, PhoneVerificationCleanup, safeError } from './deletion-core.mjs';

const byId = (id) => document.getElementById(id);
const status = (text) => { byId('status').textContent = text; };
let auth;
let controller;
let phoneCleanup;
let verifiedUser = null;
let working = false;
let confirmation = null;
let verifier = null;
let authGeneration = 0;
let lastUser = null;
let sdk;

function render() {
  const accepted = controller?.accepted;
  const user = auth?.currentUser;
  const busy = working || Boolean(controller?.busy || phoneCleanup?.busy);
  const cleanupPending = Boolean(phoneCleanup?.pending);
  const existingUser = user && user === verifiedUser && !cleanupPending;
  byId('login-section').hidden = Boolean(user || accepted || cleanupPending);
  byId('confirmation-section').hidden = !existingUser || Boolean(accepted);
  byId('verification-section').hidden = !cleanupPending;
  byId('retry-verification').disabled = busy || !phoneCleanup?.canRetry;
  byId('unverified-section').hidden = !user || Boolean(existingUser || accepted || cleanupPending || busy);
  byId('accepted-section').hidden = !accepted;
  for (const id of ['email-fields', 'phone-fields', 'code-fields']) byId(id).disabled = busy || !sdk || Boolean(user || accepted || cleanupPending);
  byId('delete-button').disabled = busy || !existingUser || !byId('confirm').checked;
  byId('sign-out').disabled = busy;
  byId('confirm').disabled = busy;
  if (user) byId('account-label').textContent = `Signed in as ${user.email || user.phoneNumber || 'your BuddysCo account'}.`;
  if (accepted) {
    byId('accepted-message').textContent = accepted.status === 'complete'
      ? 'Removal from active BuddysCo systems is complete. The retention and shared-record limits above still apply.'
      : 'Your deletion request was accepted. Removal from active BuddysCo systems is processing; completion time depends on the amount of data. The retention and shared-record limits above still apply.';
    byId('accepted-message').textContent += accepted.signedOut ? ' You are signed out.' : ' Close this tab to clear its sign-in session.';
    byId('request-reference').textContent = `Request reference: ${accepted.requestId}`;
  }
}
function clearSensitiveFields() {
  byId('password').value = '';
  byId('code').value = '';
}
function resetCaptcha() {
  confirmation = null;
  byId('code-form').hidden = true;
  if (verifier) { verifier.clear(); verifier = null; }
}
function observeUser(user) {
  if (user !== lastUser) {
    authGeneration += 1; lastUser = user;
    verifiedUser = null;
    byId('confirm').checked = false;
    clearSensitiveFields(); resetCaptcha();
  }
  controller.authChanged(user);
  render();
}
function signedInOwner(result, generation) {
  if (!result?.user || result.user.isAnonymous || auth.currentUser !== result.user) {
    throw new DeletionError('account-changed');
  }
  // The one expected transition is signed-out -> this result's User. An
  // intermediate identity change cannot be hidden by switching back later.
  observeUser(result.user);
  if (authGeneration !== generation + 1) throw new DeletionError('account-changed');
  return result.user;
}
async function cleanPhoneVerification() {
  status('Removing the temporary phone-verification record…');
  try {
    await phoneCleanup.cleanup();
    status('No existing account was found for this phone number. No BuddysCo app data was deleted.');
  } catch (error) {
    status(error?.code === 'account-changed'
      ? 'The signed-in account changed. We could not confirm verification cleanup, and no BuddysCo app deletion was requested. Close this tab and contact admin@buddysco.com.'
      : safeError(error));
  }
}
async function runLogin(action) {
  if (working || controller?.busy || auth?.currentUser || phoneCleanup?.pending || !sdk) return;
  working = true;
  status('Signing in…'); render();
  try { await action(); }
  catch (error) { status(safeError(error)); }
  finally { clearSensitiveFields(); working = false; render(); }
}

// Attach handlers before enabling any input. No credentials enter a URL or log.
byId('email-form').addEventListener('submit', (event) => {
  event.preventDefault();
  runLogin(async () => {
    const generation = authGeneration;
    const result = await sdk.signInWithEmailAndPassword(auth, byId('email').value.trim(), byId('password').value);
    verifiedUser = signedInOwner(result, generation);
    status('Signed in. Review the details and confirm below.');
  });
});
byId('phone-form').addEventListener('submit', (event) => {
  event.preventDefault();
  runLogin(async () => {
    resetCaptcha();
    const generation = authGeneration;
    verifier = new sdk.RecaptchaVerifier(auth, 'recaptcha-container', { size: 'normal' });
    const sent = await sdk.signInWithPhoneNumber(auth, byId('phone').value.trim(), verifier);
    if (generation !== authGeneration || auth.currentUser) return;
    confirmation = sent;
    byId('code-form').hidden = false;
    status('Verification code sent. Enter it below.');
    byId('code').focus();
  });
});
byId('code-form').addEventListener('submit', (event) => {
  event.preventDefault();
  runLogin(async () => {
    if (!confirmation) { status('Request a new verification code first.'); return; }
    const generation = authGeneration;
    const result = await confirmation.confirm(byId('code').value.trim());
    const user = signedInOwner(result, generation);
    if (phoneCleanup.capture(user, sdk.getAdditionalUserInfo(result)?.isNewUser)) {
      verifiedUser = user;
      status('Signed in. Review the details and confirm below.');
    } else {
      await cleanPhoneVerification();
    }
  });
});
byId('retry-verification').addEventListener('click', async () => {
  if (working || controller?.busy || !phoneCleanup?.canRetry) return;
  working = true; render();
  try { await cleanPhoneVerification(); }
  finally { working = false; render(); }
});
byId('confirm').addEventListener('change', render);
byId('sign-out').addEventListener('click', async () => {
  if (working || controller?.busy || !sdk) return;
  working = true; render();
  try { await sdk.signOut(auth); status('Signed out. Sign in again to continue.'); }
  catch (error) { status(safeError(error)); }
  finally { working = false; render(); }
});
byId('delete-button').addEventListener('click', async () => {
  if (working || !controller || !verifiedUser ||
      auth.currentUser !== verifiedUser || phoneCleanup?.pending) return;
  status('Submitting your deletion request…');
  try {
    await controller.submit(byId('confirm').checked);
    status('Deletion request accepted.');
  } catch (error) { status(safeError(error)); }
  render();
});

try {
  const [appSdk, authSdk, functionsSdk] = await Promise.all([
    import('https://www.gstatic.com/firebasejs/12.19.0/firebase-app.js'),
    import('https://www.gstatic.com/firebasejs/12.19.0/firebase-auth.js'),
    import('https://www.gstatic.com/firebasejs/12.19.0/firebase-functions.js'),
  ]);
  // Public Firebase web registration, matched to the production mobile app.
  // No Analytics import, persistent browser auth, sign-up form, or test switch.
  const app = appSdk.initializeApp({
    apiKey: 'AIzaSyAFK_Y5pNJ0qp0BWM8HmvqK2EQbzT6KuoM',
    appId: '1:758049611687:web:e040c66f212d5c4acda082',
    projectId: 'buddysco-mobile-app',
    authDomain: 'buddysco-mobile-app.firebaseapp.com',
  }, 'account-deletion');
  auth = authSdk.initializeAuth(app, { persistence: authSdk.inMemoryPersistence });
  const callable = functionsSdk.httpsCallable(functionsSdk.getFunctions(app, 'us-central1'),
    'requestAccountDeletion', { timeout: 60000 });
  controller = new DeletionController({
    currentUser: () => auth.currentUser,
    refreshToken: (user) => user.getIdToken(true),
    request: async (payload) => (await callable(payload)).data,
    signOut: () => authSdk.signOut(auth),
    uuid: () => crypto.randomUUID(),
    changed: render,
  });
  phoneCleanup = new PhoneVerificationCleanup({
    currentUser: () => auth.currentUser,
    generation: () => authGeneration,
    removeUser: (user) => authSdk.deleteUser(user),
    signOut: () => authSdk.signOut(auth),
    changed: render,
  });
  authSdk.onAuthStateChanged(auth, observeUser);
  sdk = authSdk;
  status('Sign in to your existing BuddysCo account to continue.');
  render();
} catch {
  status('Secure sign-in could not load. Check your connection or contact admin@buddysco.com for account-deletion help. Never send a password or verification code.');
}

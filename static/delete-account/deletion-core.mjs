const acceptedStatuses = new Set(['deleting', 'complete']);
const uuidPattern = /^[0-9a-f]{8}(-[0-9a-f]{4}){3}-[0-9a-f]{12}$/i;

export class DeletionError extends Error {
  constructor(code) { super(code); this.code = code; }
}

// Phone sign-in can create a new Firebase Auth record. Only a result explicitly
// classified by Firebase as new may enter this rollback, never an app deletion.
export class PhoneVerificationCleanup {
  constructor({ currentUser, generation, removeUser, signOut, changed = () => {} }) {
    Object.assign(this, { currentUser, generation, removeUser, signOut, changed });
    this.pending = null;
    this.busy = false;
  }
  capture(user, isNewUser) {
    if (!user || user.isAnonymous || this.currentUser() !== user) {
      throw new DeletionError('account-changed');
    }
    if (typeof isNewUser !== 'boolean') throw new DeletionError('unverified-login-result');
    if (isNewUser) {
      this.pending = { user, generation: this.generation(), removed: false };
      this.changed();
    }
    return !isNewUser;
  }
  ownsPending() {
    const pending = this.pending;
    return Boolean(pending && this.currentUser() === pending.user &&
      this.generation() === pending.generation);
  }
  removalSignedOut() {
    const pending = this.pending;
    // deleteUser signs out its current user. Allow just that transition to null,
    // including when Firebase's auth notification has not arrived yet.
    return Boolean(pending?.removed && !this.currentUser() &&
      [pending.generation, pending.generation + 1].includes(this.generation()));
  }
  get canRetry() { return !this.busy && (this.ownsPending() || this.removalSignedOut()); }
  async cleanup() {
    if (this.busy) throw new DeletionError('busy');
    if (!this.canRetry) throw new DeletionError('account-changed');
    const pending = this.pending;
    this.busy = true;
    this.changed();
    try {
      if (!pending.removed) {
        // Dispatch against the exact new User object, not a later currentUser.
        if (!this.ownsPending()) throw new DeletionError('account-changed');
        await this.removeUser(pending.user);
        pending.removed = true;
      }
      if (this.ownsPending()) await this.signOut();
      if (!this.removalSignedOut()) throw new DeletionError('account-changed');
      this.pending = null;
    } catch (error) {
      if (error?.code === 'account-changed' ||
          (!this.ownsPending() && !this.removalSignedOut())) {
        throw new DeletionError('account-changed');
      }
      // The network may have lost the successful response. Retain this exact
      // record for retry and never claim it was removed on an uncertain result.
      throw new DeletionError('verification-cleanup-unconfirmed');
    } finally {
      this.busy = false;
      this.changed();
    }
  }
}

// This controller accepts an injected transport for synthetic tests. The shipped
// page supplies Firebase only; there is no query-string or browser test bypass.
export class DeletionController {
  constructor({ currentUser, refreshToken, request, signOut, uuid, changed = () => {} }) {
    Object.assign(this, { currentUser, refreshToken, request, signOut, uuid, changed });
    this.user = currentUser();
    this.generation = 0;
    this.pending = null;
    this.busy = false;
    this.accepted = null;
  }
  authChanged(user) {
    if (this.user === user) return;
    this.generation += 1; // Sticky invalidation includes A -> B -> A.
    this.user = user;
    if (user && this.pending && user.uid !== this.pending.uid) this.pending = null;
    if (user) this.accepted = null;
    this.changed();
  }
  assertOwner(user, generation) {
    if (generation !== this.generation || this.user !== user ||
        this.currentUser() !== user || !user || user.isAnonymous) {
      throw new DeletionError('account-changed');
    }
  }
  async submit(confirmed) {
    if (this.busy) throw new DeletionError('busy');
    if (confirmed !== true) throw new DeletionError('confirmation-required');
    const user = this.user;
    const generation = this.generation;
    this.assertOwner(user, generation);
    if (!this.pending || this.pending.uid !== user.uid) {
      const operationId = this.uuid();
      if (!uuidPattern.test(operationId)) throw new DeletionError('unsupported-browser');
      this.pending = { uid: user.uid, operationId, dispatched: false };
    }
    const pending = this.pending;
    this.busy = true;
    this.changed();
    try {
      // Refresh before the first dispatch. An uncertain retry may need the
      // still-valid cached ID token after the server has disabled this account.
      if (!pending.dispatched) {
        await this.refreshToken(user);
        this.assertOwner(user, generation);
      }
      pending.dispatched = true;
      const result = await this.request({ expectedUid: user.uid,
        operationId: pending.operationId, confirmed: true });
      this.assertOwner(user, generation);
      if (!acceptedStatuses.has(result?.status) || !uuidPattern.test(result?.requestId ?? '')) {
        throw new DeletionError('uncertain-result');
      }
      this.accepted = { status: result.status, requestId: result.requestId, signedOut: false };
      this.changed();
      // Do not turn a successful deletion request into a failure if local
      // sign-out fails. No subsequent account may be signed out by this request.
      if (this.currentUser() === user && this.generation === generation) {
        try {
          await this.signOut();
          if (!this.currentUser() && this.accepted) this.accepted.signedOut = true;
        } catch { /* acceptance remains authoritative */ }
      }
      return this.accepted;
    } catch (error) {
      this.assertOwner(user, generation);
      if (error?.code === 'functions/failed-precondition' &&
          error?.details?.reason === 'recent-login-required') {
        pending.dispatched = false;
        throw new DeletionError('recent-login-required');
      }
      throw error;
    } finally {
      this.busy = false;
      this.changed();
    }
  }
}

export function safeError(error) {
  const code = error?.code ?? '';
  if (code === 'account-changed') return 'The signed-in account changed. Sign in again and review the deletion request.';
  if (code === 'verification-cleanup-unconfirmed') return 'We could not confirm removal of the temporary phone-verification record. No BuddysCo app deletion was requested. Retry verification cleanup below, or contact admin@buddysco.com.';
  if (code === 'unverified-login-result') return 'We could not verify whether this is an existing account. No deletion was requested. Close this tab and contact admin@buddysco.com for help.';
  if (code === 'confirmation-required') return 'Select the confirmation checkbox before requesting deletion.';
  if (code === 'recent-login-required' || code === 'auth/requires-recent-login') return 'For your security, sign out and sign in again, then retry. Your request ID will be kept in this tab.';
  if (code === 'busy') return 'A request is already in progress.';
  if (['auth/invalid-credential', 'auth/user-not-found', 'auth/wrong-password', 'auth/invalid-email'].includes(code)) return 'Sign-in failed. Check your existing account details and try again.';
  if (['auth/invalid-verification-code', 'auth/code-expired', 'auth/session-expired'].includes(code)) return 'The verification code is invalid or expired. Request a new code and try again.';
  if (code === 'auth/invalid-phone-number') return 'Enter your phone number with its country code, such as +1 or +91.';
  if (code === 'auth/user-disabled') return 'This account is disabled or deletion may already be processing. Contact admin@buddysco.com if you need help.';
  if (code === 'auth/admin-restricted-operation') return 'Use an existing BuddysCo account. New account registration is not available on this page.';
  if (['auth/too-many-requests', 'functions/resource-exhausted'].includes(code)) return 'Too many attempts. Please wait before retrying.';
  if (['auth/unauthorized-domain', 'auth/operation-not-allowed', 'auth/captcha-check-failed'].includes(code)) return 'This sign-in method is unavailable here. Try again or contact admin@buddysco.com.';
  if (code === 'functions/unauthenticated') return 'Please sign in again. If deletion may already be processing, contact admin@buddysco.com.';
  if (code.startsWith('functions/') || code === 'uncertain-result') return 'We could not confirm the result. Deletion may already be processing. Keep this tab open and retry the same request, or contact admin@buddysco.com.';
  if (code === 'unsupported-browser') return 'Use a current browser over HTTPS, or contact admin@buddysco.com.';
  return 'The request could not be completed. Try again or contact admin@buddysco.com. Never send a password or verification code to support.';
}

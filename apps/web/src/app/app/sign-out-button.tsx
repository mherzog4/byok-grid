'use client';

import { authClient } from '@/lib/auth-client';
import { useRouter } from 'next/navigation';
import { useState } from 'react';

type PendingAction = 'other-sessions' | 'sign-out';

export function SignOutButton({
  otherSessionCount,
}: {
  otherSessionCount: number;
}) {
  const router = useRouter();
  const [error, setError] = useState<string>();
  const [pending, setPending] = useState<PendingAction>();

  async function revokeOtherSessions() {
    setError(undefined);
    setPending('other-sessions');
    const result = await authClient.revokeOtherSessions();
    if (result.error) {
      setError('Other sessions could not be signed out. Try again.');
      setPending(undefined);
      return;
    }
    router.refresh();
    setPending(undefined);
  }

  async function signOut() {
    setError(undefined);
    setPending('sign-out');
    const result = await authClient.signOut();
    if (result.error) {
      setError('This session could not be signed out. Try again.');
      setPending(undefined);
      return;
    }
    router.push('/');
    router.refresh();
  }

  return (
    <>
      {otherSessionCount > 0 ? (
        <button
          disabled={pending !== undefined}
          onClick={revokeOtherSessions}
          type="button"
        >
          {pending === 'other-sessions'
            ? 'Signing out others…'
            : `Sign out ${otherSessionCount} other ${otherSessionCount === 1 ? 'session' : 'sessions'}`}
        </button>
      ) : null}
      <button disabled={pending !== undefined} onClick={signOut} type="button">
        {pending === 'sign-out' ? 'Signing out…' : 'Sign out'}
      </button>
      {error ? (
        <small className="account-error" role="alert">
          {error}
        </small>
      ) : null}
    </>
  );
}

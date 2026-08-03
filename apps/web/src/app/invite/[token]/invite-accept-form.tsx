'use client';

import { useRouter } from 'next/navigation';
import { useState } from 'react';

export function InviteAcceptForm({ token }: { token: string }) {
  const router = useRouter();
  const [pending, setPending] = useState(false);
  const [error, setError] = useState<string>();

  async function accept() {
    setPending(true);
    setError(undefined);
    try {
      const response = await fetch('/api/invitations/accept', {
        body: JSON.stringify({ token }),
        headers: { 'content-type': 'application/json' },
        method: 'POST',
      });
      const body = (await response.json()) as { error?: string; id?: string };
      if (!response.ok || !body.id) {
        throw new Error(body.error ?? 'The invitation could not be accepted.');
      }
      router.replace(`/app?workspace=${encodeURIComponent(body.id)}`);
      router.refresh();
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : 'The request failed.');
      setPending(false);
    }
  }

  return (
    <section className="auth-card">
      <h2>Join this workspace</h2>
      <p>
        Acceptance is tied to your signed-in email address. Invitation links
        expire after seven days and can only be used once.
      </p>
      {error ? (
        <p className="form-error" role="alert">
          {error}
        </p>
      ) : null}
      <button
        className="primary-action"
        disabled={pending}
        onClick={() => void accept()}
        type="button"
      >
        {pending ? 'Joining…' : 'Accept invitation'}
      </button>
    </section>
  );
}

'use client';

import { authClient } from '@/lib/auth-client';
import Link from 'next/link';
import { type FormEvent, useState } from 'react';

export function ResetPasswordForm({ token }: { token: string | undefined }) {
  const [error, setError] = useState<string>();
  const [pending, setPending] = useState(false);
  const [succeeded, setSucceeded] = useState(false);

  if (!token) {
    return (
      <section className="auth-card">
        <div className="auth-result">
          <h2>This reset link is invalid or expired.</h2>
          <p>Request a new link to continue.</p>
          <Link className="primary-action" href="/forgot-password">
            Request another link
          </Link>
        </div>
      </section>
    );
  }

  async function submit(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    setError(undefined);
    const form = new FormData(event.currentTarget);
    const newPassword = String(form.get('newPassword') ?? '');
    const confirmation = String(form.get('confirmation') ?? '');
    if (newPassword !== confirmation) {
      setError('The password confirmation does not match.');
      return;
    }
    setPending(true);
    const result = await authClient.resetPassword({ newPassword, token });
    setPending(false);
    if (result.error) {
      setError('This reset link is invalid, expired, or already used.');
      return;
    }
    setSucceeded(true);
  }

  return (
    <section className="auth-card">
      {succeeded ? (
        <div className="auth-result" role="status">
          <h2>Your password has been changed.</h2>
          <p>Every existing session was signed out for your protection.</p>
          <Link className="primary-action" href="/sign-in">
            Sign in with the new password
          </Link>
        </div>
      ) : (
        <form method="post" onSubmit={submit}>
          <label>
            New password
            <input
              autoComplete="new-password"
              maxLength={128}
              minLength={12}
              name="newPassword"
              required
              type="password"
            />
            <span>Use at least 12 characters.</span>
          </label>
          <label>
            Confirm new password
            <input
              autoComplete="new-password"
              maxLength={128}
              minLength={12}
              name="confirmation"
              required
              type="password"
            />
          </label>
          {error ? <p className="form-error">{error}</p> : null}
          <button className="primary-action" disabled={pending} type="submit">
            {pending ? 'Changing…' : 'Change password'}
          </button>
        </form>
      )}
    </section>
  );
}

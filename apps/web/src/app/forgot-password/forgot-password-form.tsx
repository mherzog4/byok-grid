'use client';

import { authClient } from '@/lib/auth-client';
import Link from 'next/link';
import { type FormEvent, useState } from 'react';

export function ForgotPasswordForm() {
  const [error, setError] = useState<string>();
  const [pending, setPending] = useState(false);
  const [submitted, setSubmitted] = useState(false);

  async function submit(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    setError(undefined);
    setPending(true);
    const form = new FormData(event.currentTarget);
    const result = await authClient.requestPasswordReset({
      email: String(form.get('email') ?? ''),
      redirectTo: '/reset-password',
    });
    setPending(false);
    if (result.error) {
      setError('The reset request could not be processed. Try again later.');
      return;
    }
    setSubmitted(true);
  }

  return (
    <section className="auth-card">
      {submitted ? (
        <div className="auth-result" role="status">
          <h2>Check your email.</h2>
          <p>
            If that address belongs to an account, a one-hour reset link is on
            its way.
          </p>
          <Link className="primary-action" href="/sign-in">
            Return to sign in
          </Link>
        </div>
      ) : (
        <form method="post" onSubmit={submit}>
          <label>
            Account email
            <input
              autoComplete="email"
              name="email"
              placeholder="you@example.com"
              required
              type="email"
            />
          </label>
          <p className="auth-form-copy">
            We will send a single-use link if the account exists.
          </p>
          {error ? <p className="form-error">{error}</p> : null}
          <button className="primary-action" disabled={pending} type="submit">
            {pending ? 'Requesting…' : 'Send reset link'}
          </button>
          <Link className="auth-secondary-link" href="/sign-in">
            Return to sign in
          </Link>
        </form>
      )}
    </section>
  );
}

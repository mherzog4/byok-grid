'use client';

import { authClient } from '@/lib/auth-client';
import type { EmailMode } from '@/lib/email-policy';
import type { SignupMode } from '@/lib/signup-policy';
import Link from 'next/link';
import { useRouter } from 'next/navigation';
import { type FormEvent, useState } from 'react';

type Mode = 'sign-in' | 'sign-up';

export function AuthForm({
  nextPath = '/app',
  emailMode,
  signupMode,
}: {
  nextPath?: string;
  emailMode: EmailMode;
  signupMode: SignupMode;
}) {
  const router = useRouter();
  const [mode, setMode] = useState<Mode>('sign-in');
  const [error, setError] = useState<string>();
  const [notice, setNotice] = useState<string>();
  const [pending, setPending] = useState(false);

  async function submit(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    setError(undefined);
    setNotice(undefined);
    setPending(true);

    const formElement = event.currentTarget;
    const form = new FormData(formElement);
    const email = String(form.get('email') ?? '');
    const password = String(form.get('password') ?? '');

    const result =
      mode === 'sign-up'
        ? await authClient.signUp.email({
            email,
            name: String(form.get('name') ?? ''),
            password,
            ...(emailMode === 'smtp' ? { callbackURL: nextPath } : {}),
          })
        : await authClient.signIn.email({ email, password });

    if (result.error) {
      setError(
        result.error.code === 'EMAIL_NOT_VERIFIED'
          ? 'Check your email for a verification link before signing in.'
          : (result.error.message ?? 'Authentication failed.')
      );
      setPending(false);
      return;
    }

    if (mode === 'sign-up' && emailMode === 'smtp') {
      formElement.reset();
      setMode('sign-in');
      setNotice(
        'Check your email for the verification link before signing in.'
      );
      setPending(false);
      return;
    }

    router.push(nextPath);
    router.refresh();
  }

  return (
    <section className="auth-card">
      <div className="auth-switcher" aria-label="Authentication mode">
        <button
          aria-pressed={mode === 'sign-in'}
          className={mode === 'sign-in' ? 'active' : undefined}
          onClick={() => setMode('sign-in')}
          type="button"
        >
          Sign in
        </button>
        {signupMode !== 'disabled' ? (
          <button
            aria-pressed={mode === 'sign-up'}
            className={mode === 'sign-up' ? 'active' : undefined}
            onClick={() => setMode('sign-up')}
            type="button"
          >
            Create account
          </button>
        ) : null}
      </div>

      {signupMode === 'allowlist' ? (
        <p className="auth-policy-note">
          Account creation is limited to operator-approved email addresses.
        </p>
      ) : null}

      <form method="post" onSubmit={submit}>
        {mode === 'sign-up' ? (
          <label>
            Name
            <input
              autoComplete="name"
              minLength={1}
              name="name"
              placeholder="Ada Lovelace"
              required
            />
          </label>
        ) : null}

        <label>
          Email
          <input
            autoComplete="email"
            name="email"
            placeholder="you@example.com"
            required
            type="email"
          />
        </label>

        <label>
          Password
          <input
            autoComplete={
              mode === 'sign-up' ? 'new-password' : 'current-password'
            }
            minLength={12}
            maxLength={128}
            name="password"
            required
            type="password"
          />
          {mode === 'sign-up' ? <span>Use at least 12 characters.</span> : null}
        </label>

        {error ? <p className="form-error">{error}</p> : null}
        {notice ? <p className="form-success">{notice}</p> : null}

        <button className="primary-action" disabled={pending} type="submit">
          {pending
            ? 'Working…'
            : mode === 'sign-up'
              ? 'Create account'
              : 'Sign in'}
        </button>
        {mode === 'sign-in' && emailMode === 'smtp' ? (
          <Link className="auth-secondary-link" href="/forgot-password">
            Forgot your password?
          </Link>
        ) : null}
      </form>
    </section>
  );
}

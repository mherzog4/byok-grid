import { emailPolicy } from '@/lib/auth';
import Link from 'next/link';
import { notFound } from 'next/navigation';
import { ResetPasswordForm } from './reset-password-form';

export default async function ResetPasswordPage({
  searchParams,
}: {
  searchParams: Promise<{ error?: string; token?: string }>;
}) {
  if (emailPolicy.mode === 'disabled') notFound();
  const parameters = await searchParams;
  const token = validResetToken(parameters.token)
    ? parameters.token
    : undefined;

  return (
    <main className="auth-page">
      <Link className="back-link" href="/sign-in">
        ← Sign in
      </Link>
      <div className="auth-intro">
        <p className="eyebrow">ACCOUNT RECOVERY</p>
        <h1>Choose a new password.</h1>
        <p>
          Completing this reset invalidates the link and signs out every active
          session.
        </p>
      </div>
      <ResetPasswordForm
        token={parameters.error === undefined ? token : undefined}
      />
    </main>
  );
}

function validResetToken(value: string | undefined): value is string {
  return Boolean(
    value && value.length >= 16 && value.length <= 512 && !/\s/u.test(value)
  );
}

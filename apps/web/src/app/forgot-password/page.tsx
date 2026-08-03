import { emailPolicy } from '@/lib/auth';
import Link from 'next/link';
import { notFound } from 'next/navigation';
import { ForgotPasswordForm } from './forgot-password-form';

export default function ForgotPasswordPage() {
  if (emailPolicy.mode === 'disabled') notFound();

  return (
    <main className="auth-page">
      <Link className="back-link" href="/sign-in">
        ← Sign in
      </Link>
      <div className="auth-intro">
        <p className="eyebrow">ACCOUNT RECOVERY</p>
        <h1>Reset your password.</h1>
        <p>
          Recovery links are single-use, expire after one hour, and never reveal
          whether an address has an account.
        </p>
      </div>
      <ForgotPasswordForm />
    </main>
  );
}

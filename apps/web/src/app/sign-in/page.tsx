import { auth, signupPolicy } from '@/lib/auth';
import { headers } from 'next/headers';
import Link from 'next/link';
import { redirect } from 'next/navigation';
import { AuthForm } from './auth-form';
import { safeInternalPath } from '@/lib/navigation';

export default async function SignInPage({
  searchParams,
}: {
  searchParams: Promise<{ next?: string }>;
}) {
  const session = await auth.api.getSession({ headers: await headers() });
  const nextPath = safeInternalPath((await searchParams).next);

  if (session) redirect(nextPath);

  return (
    <main className="auth-page">
      <Link className="back-link" href="/">
        ← BYOK Grid
      </Link>
      <div className="auth-intro">
        <p className="eyebrow">LOCAL-FIRST IDENTITY</p>
        <h1>Enter your workspace.</h1>
        <p>
          Authentication data stays in your SQLite or libSQL database. Connector
          keys are encrypted separately and are never placed in session data.
        </p>
      </div>
      <AuthForm nextPath={nextPath} signupMode={signupPolicy.mode} />
    </main>
  );
}

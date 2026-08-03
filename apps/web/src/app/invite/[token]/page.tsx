import { auth } from '@/lib/auth';
import { headers } from 'next/headers';
import Link from 'next/link';
import { redirect } from 'next/navigation';
import { InviteAcceptForm } from './invite-accept-form';

export default async function InvitationPage({
  params,
}: {
  params: Promise<{ token: string }>;
}) {
  const { token } = await params;
  const invitationPath = `/invite/${encodeURIComponent(token)}`;
  const session = await auth.api.getSession({ headers: await headers() });
  if (!session) {
    redirect(`/sign-in?next=${encodeURIComponent(invitationPath)}`);
  }

  return (
    <main className="auth-page">
      <Link className="back-link" href="/app">
        ← BYOK Grid
      </Link>
      <div className="auth-intro">
        <p className="eyebrow">WORKSPACE INVITATION</p>
        <h1>Collaborate in one shared grid.</h1>
        <p>
          You are signed in as {session.user.email}. The workspace will only be
          joined if this is the invited address.
        </p>
      </div>
      <InviteAcceptForm token={token} />
    </main>
  );
}

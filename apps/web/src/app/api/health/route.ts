import { sqliteDatabase } from '@/lib/sqlite-database';
import { NextResponse } from 'next/server';

export const dynamic = 'force-dynamic';

export async function GET() {
  try {
    await sqliteDatabase.client.execute(
      'select 1 from __drizzle_migrations limit 1'
    );
    return NextResponse.json({ database: 'sqlite', status: 'ok' });
  } catch {
    return NextResponse.json(
      { database: 'sqlite_unready', status: 'degraded' },
      { status: 503 }
    );
  }
}

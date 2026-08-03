import { assertSqliteMigrationsReady } from '@byok-grid/db';
import { sqliteDatabase } from '@/lib/sqlite-database';
import { assertWebRuntimeConfiguration } from '@/lib/runtime-config';
import { NextResponse } from 'next/server';

export const dynamic = 'force-dynamic';

export async function GET() {
  try {
    assertWebRuntimeConfiguration();
    await assertSqliteMigrationsReady(sqliteDatabase.client);
    return NextResponse.json({
      configuration: 'valid',
      database: 'sqlite',
      status: 'ok',
    });
  } catch {
    return NextResponse.json(
      {
        configuration: 'invalid_or_unready',
        database: 'sqlite_unready',
        status: 'degraded',
      },
      { status: 503 }
    );
  }
}

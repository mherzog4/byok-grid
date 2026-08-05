import { assertSqliteMigrationsReady } from '@byok-grid/db';
import { sqliteDatabase } from '@/lib/sqlite-database';
import { assertWebRuntimeConfiguration } from '@/lib/runtime-config';
import { NextResponse } from 'next/server';

export const dynamic = 'force-dynamic';

const DRAIN_PROBE_DELAY_MILLISECONDS = 750;

export async function GET(request?: Request) {
  try {
    assertWebRuntimeConfiguration();
    await assertSqliteMigrationsReady(sqliteDatabase.client);
    await delayDrainProbe(request);
    return NextResponse.json(
      {
        configuration: 'valid',
        database: 'sqlite',
        status: 'ok',
      },
      { headers: { 'Cache-Control': 'no-store' } }
    );
  } catch {
    return NextResponse.json(
      {
        configuration: 'invalid_or_unready',
        database: 'sqlite_unready',
        status: 'degraded',
      },
      { headers: { 'Cache-Control': 'no-store' }, status: 503 }
    );
  }
}

async function delayDrainProbe(request?: Request): Promise<void> {
  if (
    process.env.BYOK_GRID_WEB_DRAIN_DRILL !== '1' ||
    request?.headers.get('x-byok-grid-drain-probe') !== '1'
  ) {
    return;
  }

  await new Promise((resolve) =>
    setTimeout(resolve, DRAIN_PROBE_DELAY_MILLISECONDS)
  );
}

import {
  rewrapWorkspaceKey,
  type MasterKeyRing,
  unwrapWorkspaceKeyFromRing,
} from '@byok-grid/security';
import { and, asc, count, eq, gt, ne, sql } from 'drizzle-orm';
import { type SqliteDatabase, withSqliteWriteTransaction } from './client';
import { workspaceKeys } from './schema';

const DEFAULT_ROTATION_BATCH_SIZE = 100;
const MAXIMUM_ROTATION_BATCH_SIZE = 500;
const INSPECTION_BATCH_SIZE = 500;

export interface SqliteMasterKeyRotationInspection {
  pending: number;
  total: number;
}

export interface SqliteMasterKeyRotationBatchResult {
  remaining: number;
  rotated: number;
}

export async function inspectSqliteMasterKeyRotation(
  db: SqliteDatabase,
  masterKeys: MasterKeyRing
): Promise<SqliteMasterKeyRotationInspection> {
  return db.transaction(async (tx) => {
    let cursor: string | undefined;
    let pending = 0;
    let total = 0;

    for (;;) {
      const rows = await tx
        .select({
          keyId: workspaceKeys.keyId,
          workspaceId: workspaceKeys.workspaceId,
          wrappedKey: workspaceKeys.wrappedKey,
        })
        .from(workspaceKeys)
        .where(cursor ? gt(workspaceKeys.workspaceId, cursor) : undefined)
        .orderBy(asc(workspaceKeys.workspaceId))
        .limit(INSPECTION_BATCH_SIZE);

      for (const row of rows) {
        assertStoredEnvelopeIdentity(row.keyId, row.wrappedKey.keyId);
        const workspaceKey = unwrapWorkspaceKeyFromRing(
          row.workspaceId,
          row.wrappedKey,
          masterKeys
        );
        workspaceKey.fill(0);
        total += 1;
        if (row.keyId !== masterKeys.current.id) pending += 1;
      }
      if (rows.length < INSPECTION_BATCH_SIZE) break;
      cursor = rows.at(-1)!.workspaceId;
    }

    return { pending, total };
  });
}

export async function rotateSqliteMasterKeysBatch(
  db: SqliteDatabase,
  masterKeys: MasterKeyRing,
  batchSize = DEFAULT_ROTATION_BATCH_SIZE
): Promise<SqliteMasterKeyRotationBatchResult> {
  if (
    !Number.isSafeInteger(batchSize) ||
    batchSize < 1 ||
    batchSize > MAXIMUM_ROTATION_BATCH_SIZE
  ) {
    throw new Error(
      `Master-key rotation batch size must be between 1 and ${MAXIMUM_ROTATION_BATCH_SIZE}.`
    );
  }

  return withSqliteWriteTransaction(db, async (tx) => {
    const [inconsistent] = await tx
      .select({ workspaceId: workspaceKeys.workspaceId })
      .from(workspaceKeys)
      .where(
        sql`${workspaceKeys.keyId} is not json_extract(${workspaceKeys.wrappedKey}, '$.keyId')`
      )
      .limit(1);
    if (inconsistent) {
      throw new Error(
        'A stored workspace key has inconsistent key identifiers; rotation was stopped.'
      );
    }

    const rows = await tx
      .select({
        keyId: workspaceKeys.keyId,
        workspaceId: workspaceKeys.workspaceId,
        wrappedKey: workspaceKeys.wrappedKey,
      })
      .from(workspaceKeys)
      .where(ne(workspaceKeys.keyId, masterKeys.current.id))
      .orderBy(asc(workspaceKeys.workspaceId))
      .limit(batchSize);

    let rotated = 0;
    for (const row of rows) {
      assertStoredEnvelopeIdentity(row.keyId, row.wrappedKey.keyId);
      const wrappedKey = rewrapWorkspaceKey(
        row.workspaceId,
        row.wrappedKey,
        masterKeys
      );
      const [updated] = await tx
        .update(workspaceKeys)
        .set({
          keyId: masterKeys.current.id,
          updatedAt: new Date(),
          wrappedKey,
        })
        .where(
          and(
            eq(workspaceKeys.workspaceId, row.workspaceId),
            eq(workspaceKeys.keyId, row.keyId)
          )
        )
        .returning({ workspaceId: workspaceKeys.workspaceId });
      if (!updated) {
        throw new Error(
          'A workspace key changed concurrently during master-key rotation.'
        );
      }
      rotated += 1;
    }

    const [remaining] = await tx
      .select({ value: count() })
      .from(workspaceKeys)
      .where(ne(workspaceKeys.keyId, masterKeys.current.id));
    return { remaining: remaining?.value ?? 0, rotated };
  });
}

function assertStoredEnvelopeIdentity(
  storedKeyId: string,
  envelopeKeyId: string
): void {
  if (storedKeyId !== envelopeKeyId) {
    throw new Error(
      'A stored workspace key has inconsistent key identifiers; rotation was stopped.'
    );
  }
}

import {
  createSqliteBackup,
  restoreSqliteBackupToNewFile,
  verifySqliteBackup,
} from './backup';

const [command, ...arguments_] = process.argv.slice(2);

try {
  let result;
  switch (command) {
    case 'backup': {
      const [outputPath] = arguments_;
      const databaseUrl = process.env.SQLITE_DATABASE_URL;
      if (!databaseUrl || !outputPath) usage();
      result = await createSqliteBackup({ databaseUrl, outputPath });
      break;
    }
    case 'restore': {
      const [backupPath, outputPath] = arguments_;
      if (!backupPath || !outputPath) usage();
      result = await restoreSqliteBackupToNewFile({
        backupPath,
        outputPath,
      });
      break;
    }
    case 'verify': {
      const [backupPath] = arguments_;
      if (!backupPath) usage();
      result = await verifySqliteBackup(backupPath);
      break;
    }
    default:
      usage();
  }
  process.stdout.write(`${JSON.stringify(result, null, 2)}\n`);
} catch (error) {
  process.stderr.write(
    `${error instanceof Error ? error.message : 'SQLite backup command failed.'}\n`
  );
  process.exitCode = 1;
}

function usage(): never {
  throw new Error(
    'Usage: backup-cli.ts backup <output.sqlite> | verify <backup.sqlite> | restore <backup.sqlite> <new-output.sqlite>'
  );
}

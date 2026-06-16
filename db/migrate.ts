import { existsSync, mkdirSync, readFileSync, readdirSync } from "node:fs";
import { dirname, join } from "node:path";
import { DatabaseSync } from "node:sqlite";

export const defaultDatabasePath = join(process.cwd(), "data", "loopboard.sqlite");

export const databasePathFromEnv = (): string =>
  process.env.LOOPBOARD_DATABASE_PATH ?? defaultDatabasePath;

export const openLoopBoardDatabase = (databasePath = databasePathFromEnv()) => {
  mkdirSync(dirname(databasePath), { recursive: true });
  const database = new DatabaseSync(databasePath);
  database.exec("PRAGMA foreign_keys = ON;");
  return database;
};

export const applyMigrations = (
  database: DatabaseSync,
  migrationsDirectory = join(process.cwd(), "db", "migrations"),
): string[] => {
  if (!existsSync(migrationsDirectory)) {
    throw new Error(`Migration directory does not exist: ${migrationsDirectory}`);
  }

  database.exec(`
    PRAGMA foreign_keys = ON;
    CREATE TABLE IF NOT EXISTS __loopboard_migrations (
      id TEXT PRIMARY KEY NOT NULL,
      applied_at TEXT NOT NULL
    );
  `);

  const applied = new Set(
    database
      .prepare("SELECT id FROM __loopboard_migrations")
      .all()
      .map((row) => String((row as { id: unknown }).id)),
  );
  const migrationFiles = readdirSync(migrationsDirectory)
    .filter((fileName) => fileName.endsWith(".sql"))
    .sort();
  const newlyApplied: string[] = [];

  for (const fileName of migrationFiles) {
    if (applied.has(fileName)) {
      continue;
    }

    const sql = readFileSync(join(migrationsDirectory, fileName), "utf8");
    database.exec("BEGIN;");
    try {
      database.exec(sql);
      database
        .prepare(
          "INSERT INTO __loopboard_migrations (id, applied_at) VALUES (?, ?)",
        )
        .run(fileName, new Date().toISOString());
      database.exec("COMMIT;");
      newlyApplied.push(fileName);
    } catch (error) {
      database.exec("ROLLBACK;");
      throw error;
    }
  }

  return newlyApplied;
};

if (import.meta.url === `file://${process.argv[1]}`) {
  const database = openLoopBoardDatabase();
  const applied = applyMigrations(database);
  database.close();
  console.log(
    applied.length === 0
      ? "LoopBoard database is already migrated."
      : `Applied migrations: ${applied.join(", ")}`,
  );
}

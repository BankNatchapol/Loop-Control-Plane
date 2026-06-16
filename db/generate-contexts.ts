import { applyMigrations, openLoopBoardDatabase } from "@/db/migrate";
import {
  TaskContextService,
  taskContextRootFromEnv,
} from "@/lib/context/task-context-service";
import { LoopBoardRepository } from "@/lib/db/loopboard-repository";

export const generateTaskContextsFromDatabase = (
  rootDirectory = taskContextRootFromEnv(),
) => {
  const database = openLoopBoardDatabase();

  try {
    applyMigrations(database);
    const repository = new LoopBoardRepository(database);
    const service = new TaskContextService(rootDirectory);
    return service.generateBoardContexts(repository.listBoardData());
  } finally {
    database.close();
  }
};

if (import.meta.url === `file://${process.argv[1]}`) {
  const rootDirectory = taskContextRootFromEnv();
  const generated = generateTaskContextsFromDatabase(rootDirectory);

  console.log(
    generated.length === 0
      ? `No task contexts generated under ${rootDirectory}.`
      : `Generated ${generated.length} task context folders under ${rootDirectory}.`,
  );
}

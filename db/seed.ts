import type { DatabaseSync } from "node:sqlite";

import {
  seedFeatures,
  seedProject,
  seedTasks,
  seedWorkflows,
  type TaskEvent,
} from "@/lib/loopboard";

import { applyMigrations, openLoopBoardDatabase } from "./migrate";

const json = (value: unknown): string => JSON.stringify(value);

export const seedDatabase = (database: DatabaseSync): void => {
  database.exec("PRAGMA foreign_keys = ON; BEGIN;");

  try {
    database
      .prepare(
        `
          INSERT INTO projects (
            id, name, description, repository, repo_path, is_git_repository,
            current_branch, default_branch, github_remote_url, github_repository, spec_kit_root,
            specs_path, tasks_path, workflows_path, handoffs_path, automation_policy,
            engine_settings, created_at, updated_at
          )
          VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
          ON CONFLICT(id) DO UPDATE SET
            name = excluded.name,
            description = excluded.description,
            repository = excluded.repository,
            repo_path = excluded.repo_path,
            is_git_repository = excluded.is_git_repository,
            current_branch = excluded.current_branch,
            default_branch = excluded.default_branch,
            github_remote_url = excluded.github_remote_url,
            github_repository = excluded.github_repository,
            spec_kit_root = excluded.spec_kit_root,
            specs_path = excluded.specs_path,
            tasks_path = excluded.tasks_path,
            workflows_path = excluded.workflows_path,
            handoffs_path = excluded.handoffs_path,
            automation_policy = excluded.automation_policy,
            engine_settings = excluded.engine_settings,
            created_at = excluded.created_at,
            updated_at = excluded.updated_at
        `,
      )
      .run(
        seedProject.id,
        seedProject.name,
        seedProject.description,
        seedProject.repository,
        seedProject.repoPath,
        seedProject.isGitRepository ? "true" : "false",
        seedProject.currentBranch,
        seedProject.defaultBranch,
        seedProject.githubRemoteUrl,
        seedProject.githubRepository,
        seedProject.specKitRoot,
        seedProject.specsPath,
        seedProject.tasksPath,
        seedProject.workflowsPath,
        seedProject.handoffsPath,
        json(seedProject.automationPolicy),
        json(seedProject.engineSettings),
        seedProject.createdAt,
        seedProject.updatedAt,
      );

    const featureStatement = database.prepare(`
      INSERT INTO features (
        id, project_id, name, summary, source, artifact_folder_path, prd_path,
        spec_path, plan_path, tasks_path, decisions_path, status, artifacts,
        created_at, updated_at
      )
      VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
      ON CONFLICT(id) DO UPDATE SET
        project_id = excluded.project_id,
        name = excluded.name,
        summary = excluded.summary,
        source = excluded.source,
        artifact_folder_path = excluded.artifact_folder_path,
        prd_path = excluded.prd_path,
        spec_path = excluded.spec_path,
        plan_path = excluded.plan_path,
        tasks_path = excluded.tasks_path,
        decisions_path = excluded.decisions_path,
        status = excluded.status,
        artifacts = excluded.artifacts,
        created_at = excluded.created_at,
        updated_at = excluded.updated_at
    `);

    for (const feature of seedFeatures) {
      featureStatement.run(
        feature.id,
        feature.projectId,
        feature.name,
        feature.summary,
        feature.source,
        feature.artifactFolderPath,
        feature.prdPath,
        feature.specPath,
        feature.planPath,
        feature.tasksPath,
        feature.decisionsPath,
        feature.status,
        json(feature.artifacts),
        feature.createdAt,
        feature.updatedAt,
      );
    }

    const taskStatement = database.prepare(`
      INSERT INTO tasks (
        id, project_id, feature_id, title, description, status, owner, mode,
        risk, source, labels, acceptance_criteria, dependencies, branch,
        worktree, github, handoff, created_at, updated_at
      )
      VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
      ON CONFLICT(id) DO UPDATE SET
        project_id = excluded.project_id,
        feature_id = excluded.feature_id,
        title = excluded.title,
        description = excluded.description,
        status = excluded.status,
        owner = excluded.owner,
        mode = excluded.mode,
        risk = excluded.risk,
        source = excluded.source,
        labels = excluded.labels,
        acceptance_criteria = excluded.acceptance_criteria,
        dependencies = excluded.dependencies,
        branch = excluded.branch,
        worktree = excluded.worktree,
        github = excluded.github,
        handoff = excluded.handoff,
        created_at = excluded.created_at,
        updated_at = excluded.updated_at
    `);

    for (const task of seedTasks) {
      taskStatement.run(
        task.id,
        task.projectId,
        task.featureId,
        task.title,
        task.description,
        task.status,
        task.owner,
        task.mode,
        task.risk,
        task.source,
        json(task.labels),
        json(task.acceptanceCriteria),
        json([]),
        task.branch,
        task.worktree,
        json(task.github),
        json(task.handoff),
        task.createdAt,
        task.updatedAt,
      );
    }

    const eventStatement = database.prepare(`
      INSERT INTO task_events (
        id, task_id, type, actor, message, from_status, to_status, from_owner,
        to_owner, payload, created_at
      )
      VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
      ON CONFLICT(id) DO UPDATE SET
        task_id = excluded.task_id,
        type = excluded.type,
        actor = excluded.actor,
        message = excluded.message,
        from_status = excluded.from_status,
        to_status = excluded.to_status,
        from_owner = excluded.from_owner,
        to_owner = excluded.to_owner,
        payload = excluded.payload,
        created_at = excluded.created_at
    `);

    for (const task of seedTasks) {
      for (const event of task.events) {
        const payload: TaskEvent["metadata"] = event.metadata ?? {};
        eventStatement.run(
          event.id,
          event.taskId,
          event.type,
          event.actor,
          event.message,
          event.fromStatus ?? null,
          event.toStatus ?? null,
          event.fromOwner ?? null,
          event.toOwner ?? null,
          json(payload),
          event.createdAt,
        );
      }
    }

    const workflowStatement = database.prepare(`
      INSERT INTO workflows (
        id, project_id, name, description, version, config, created_at, updated_at
      )
      VALUES (?, ?, ?, ?, ?, ?, ?, ?)
      ON CONFLICT(id) DO UPDATE SET
        project_id = excluded.project_id,
        name = excluded.name,
        description = excluded.description,
        version = excluded.version,
        config = excluded.config,
        created_at = excluded.created_at,
        updated_at = excluded.updated_at
    `);

    const workflowNodeStatement = database.prepare(`
      INSERT INTO workflow_nodes (
        id, workflow_id, type, name, mode, position, input_artifacts,
        output_artifacts, require_approval, max_retries, risk_policy, config,
        current_state, created_at, updated_at
      )
      VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
      ON CONFLICT(id) DO UPDATE SET
        workflow_id = excluded.workflow_id,
        type = excluded.type,
        name = excluded.name,
        mode = excluded.mode,
        position = excluded.position,
        input_artifacts = excluded.input_artifacts,
        output_artifacts = excluded.output_artifacts,
        require_approval = excluded.require_approval,
        max_retries = excluded.max_retries,
        risk_policy = excluded.risk_policy,
        config = excluded.config,
        current_state = excluded.current_state,
        created_at = excluded.created_at,
        updated_at = excluded.updated_at
    `);

    const workflowEdgeStatement = database.prepare(`
      INSERT INTO workflow_edges (
        id, workflow_id, source_node_id, target_node_id, label, condition,
        created_at, updated_at
      )
      VALUES (?, ?, ?, ?, ?, ?, ?, ?)
      ON CONFLICT(id) DO UPDATE SET
        workflow_id = excluded.workflow_id,
        source_node_id = excluded.source_node_id,
        target_node_id = excluded.target_node_id,
        label = excluded.label,
        condition = excluded.condition,
        created_at = excluded.created_at,
        updated_at = excluded.updated_at
    `);

    for (const workflow of seedWorkflows) {
      workflowStatement.run(
        workflow.id,
        workflow.projectId,
        workflow.name,
        workflow.description,
        String(workflow.version),
        json(workflow.config),
        workflow.createdAt,
        workflow.updatedAt,
      );

      for (const node of workflow.nodes) {
        workflowNodeStatement.run(
          node.id,
          node.workflowId,
          node.type,
          node.name,
          node.mode,
          json(node.position),
          json(node.inputArtifacts),
          json(node.outputArtifacts),
          node.requireApproval ? "true" : "false",
          String(node.maxRetries),
          node.riskPolicy,
          json(node.config),
          node.currentState,
          node.createdAt,
          node.updatedAt,
        );
      }

      for (const edge of workflow.edges) {
        workflowEdgeStatement.run(
          edge.id,
          edge.workflowId,
          edge.sourceNodeId,
          edge.targetNodeId,
          edge.label,
          json(edge.condition),
          edge.createdAt,
          edge.updatedAt,
        );
      }
    }

    database
      .prepare(
        `
          INSERT INTO engine_jobs (
            id, kind, status, backend, project_id, task_id, workflow_run_id,
            workflow_node_id, payload, result, execution_logs, error, attempt,
            max_attempts, queued_at, started_at, completed_at, created_at, updated_at
          )
          VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
          ON CONFLICT(id) DO UPDATE SET
            kind = excluded.kind,
            status = excluded.status,
            backend = excluded.backend,
            project_id = excluded.project_id,
            payload = excluded.payload,
            result = excluded.result,
            execution_logs = excluded.execution_logs,
            error = excluded.error,
            attempt = excluded.attempt,
            max_attempts = excluded.max_attempts,
            queued_at = excluded.queued_at,
            started_at = excluded.started_at,
            completed_at = excluded.completed_at,
            updated_at = excluded.updated_at
        `,
      )
      .run(
        "engine-job-seed-demo-ping",
        "demo-ping",
        "completed",
        "stub",
        seedProject.id,
        null,
        null,
        null,
        json({ message: "Historical demo ping from seed data." }),
        json({ ok: true, stdoutSummary: "[redacted] stub completed deterministically" }),
        json([
          {
            timestamp: "2026-06-15T18:00:00.000Z",
            level: "info",
            message: "Stub executor completed demo-ping deterministically.",
          },
        ]),
        null,
        "1",
        "3",
        "2026-06-15T18:00:00.000Z",
        "2026-06-15T18:00:01.000Z",
        "2026-06-15T18:00:02.000Z",
        "2026-06-15T18:00:00.000Z",
        "2026-06-15T18:00:02.000Z",
      );

    database.exec("COMMIT;");
  } catch (error) {
    database.exec("ROLLBACK;");
    throw error;
  }
};

if (import.meta.url === `file://${process.argv[1]}`) {
  const database = openLoopBoardDatabase();
  const applied = applyMigrations(database);
  seedDatabase(database);
  database.close();
  console.log(
    `Seeded Loop Control Plane demo data${applied.length > 0 ? ` after ${applied.length} migration(s)` : ""}.`,
  );
}

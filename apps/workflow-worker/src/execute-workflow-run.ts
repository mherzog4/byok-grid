import {
  claimSqliteWorkflowSteps,
  completeSqliteWorkflowStep,
  failSqliteWorkflowStep,
  getClaimedSqliteWorkflowStepExecution,
} from '@byok-grid/db';
import {
  workflowRunDispatchInputSchema,
  type WorkflowRunDispatchInput,
} from '@byok-grid/domain';
import { NonRetryableError } from '@hatchet-dev/typescript-sdk/v1';
import { randomUUID } from 'node:crypto';
import { workflowDb } from './database';
import { executeClaimedWorkflowStep } from './execute-step';
import { workflowHatchet } from './hatchet';

export const executeWorkflowRunTask = workflowHatchet.task({
  name: 'execute-workflow-run',
  retries: 2,
  backoff: { factor: 2, maxSeconds: 30 },
  executionTimeout: '30m',
  idempotency: {
    expression: 'input.runId',
    fallbackTtlMs: 86_400_000,
    strategy: 'status',
  },
  inputValidator: workflowRunDispatchInputSchema,
  fn: (input) =>
    executeWorkflowRun(workflowRunDispatchInputSchema.parse(input)),
});

export async function executeWorkflowRun(input: WorkflowRunDispatchInput) {
  let completedSteps = 0;
  for (;;) {
    const claimId = randomUUID();
    const [claim] = await claimSqliteWorkflowSteps(workflowDb, {
      claimId,
      limit: 1,
      runId: input.runId,
      workspaceId: input.workspaceId,
    });
    if (!claim) {
      return { completedSteps, runId: input.runId, status: 'drained' as const };
    }

    try {
      const execution = await getClaimedSqliteWorkflowStepExecution(
        workflowDb,
        {
          claimId,
          runId: claim.runId,
          stepId: claim.stepId,
          workspaceId: claim.workspaceId,
        }
      );
      const result = await executeClaimedWorkflowStep(
        workflowDb,
        claim,
        execution
      );
      await completeSqliteWorkflowStep(workflowDb, {
        activeOutputHandles: result.activeOutputHandles,
        claimId,
        output: result.output,
        runId: claim.runId,
        stepId: claim.stepId,
        workspaceId: claim.workspaceId,
      });
      completedSteps += 1;
    } catch (error) {
      const message =
        error instanceof Error ? error.message : 'The workflow step failed.';
      await failSqliteWorkflowStep(workflowDb, {
        claimId,
        errorCode: 'workflow_step_failed',
        errorMessage: message,
        runId: claim.runId,
        stepId: claim.stepId,
        workspaceId: claim.workspaceId,
      });
      throw new NonRetryableError(message);
    }
  }
}

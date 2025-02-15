import * as workerpool from 'workerpool';
import { IntegTestConfig } from '../../runner/integ-tests';
import { IntegSnapshotRunner, IntegTestRunner } from '../../runner/runners';
import { DiagnosticReason, IntegTestWorkerConfig } from '../common';
import { IntegTestBatchRequest } from '../integ-test-worker';

/**
 * Runs a single integration test batch request.
 * If the test does not have an existing snapshot,
 * this will first generate a snapshot and then execute
 * the integration tests.
 *
 * If the tests succeed it will then save the snapshot
 */
export function integTestWorker(request: IntegTestBatchRequest): IntegTestWorkerConfig[] {
  const failures: IntegTestConfig[] = [];
  for (const test of request.tests) {
    const runner = new IntegTestRunner({
      fileName: test.fileName,
      profile: request.profile,
      env: {
        AWS_REGION: request.region,
      },
    }, test.destructiveChanges);
    const start = Date.now();
    try {
      if (!runner.hasSnapshot()) {
        runner.generateSnapshot();
      }

      if (!runner.tests || Object.keys(runner.tests).length === 0) {
        throw new Error(`No tests defined for ${runner.testName}`);
      }
      for (const [testName, testCase] of Object.entries(runner.tests)) {
        try {
          runner.runIntegTestCase({
            testCase: testCase,
            clean: request.clean,
            dryRun: request.dryRun,
            updateWorkflow: request.updateWorkflow,
          });
          workerpool.workerEmit({
            reason: DiagnosticReason.TEST_SUCCESS,
            testName: testName,
            message: 'Success',
            duration: (Date.now() - start) / 1000,
          });
        } catch (e) {
          failures.push(test);
          workerpool.workerEmit({
            reason: DiagnosticReason.TEST_FAILED,
            testName: testName,
            message: `Integration test failed: ${e}`,
            duration: (Date.now() - start) / 1000,
          });
        }
      }
    } catch (e) {
      failures.push(test);
      workerpool.workerEmit({
        reason: DiagnosticReason.TEST_FAILED,
        testName: test.fileName,
        message: `Integration test failed: ${e}`,
        duration: (Date.now() - start) / 1000,
      });
    }
  }

  return failures;
}

/**
 * Runs a single snapshot test batch request.
 * For each integration test this will check to see
 * if there is an existing snapshot, and if there is will
 * check if there are any changes
 */
export function snapshotTestWorker(test: IntegTestConfig): IntegTestWorkerConfig[] {
  const failedTests = new Array<IntegTestWorkerConfig>();
  const runner = new IntegSnapshotRunner({ fileName: test.fileName });
  const start = Date.now();
  try {
    if (!runner.hasSnapshot()) {
      workerpool.workerEmit({
        reason: DiagnosticReason.NO_SNAPSHOT,
        testName: runner.testName,
        message: 'No Snapshot',
        duration: (Date.now() - start) / 1000,
      });
      failedTests.push(test);
    } else {
      const { diagnostics, destructiveChanges } = runner.testSnapshot();
      if (diagnostics.length > 0) {
        diagnostics.forEach(diagnostic => workerpool.workerEmit({
          ...diagnostic,
          duration: (Date.now() - start) / 1000,
        }));
        failedTests.push({
          fileName: test.fileName,
          destructiveChanges,
        });
      } else {
        workerpool.workerEmit({
          reason: DiagnosticReason.SNAPSHOT_SUCCESS,
          testName: runner.testName,
          message: 'Success',
          duration: (Date.now() - start) / 1000,
        });
      }
    }
  } catch (e) {
    failedTests.push(test);
    workerpool.workerEmit({
      message: e.message,
      testName: runner.testName,
      reason: DiagnosticReason.SNAPSHOT_FAILED,
      duration: (Date.now() - start) / 1000,
    });
  }

  return failedTests;
}

workerpool.worker({
  snapshotTestWorker,
  integTestWorker,
});

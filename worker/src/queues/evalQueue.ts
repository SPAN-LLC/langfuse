import { Job, Queue, Worker } from "bullmq";
import { ApiError, BaseError } from "@langfuse/shared";
import { evaluate, createEvalJobs } from "../features/evaluation/eval-service";
import { kyselyPrisma } from "@langfuse/shared/src/db";
import logger from "../logger";
import { sql } from "kysely";
import {
  redis,
  QueueName,
  TQueueJobTypes,
  traceException,
  instrument,
  recordIncrement,
  recordHistogram,
  recordGauge,
  getTraceUpsertQueue,
} from "@langfuse/shared/src/server";
import { SpanKind } from "@opentelemetry/api";
import { env } from "../env";

export const evalQueue = redis
  ? new Queue<TQueueJobTypes[QueueName.EvaluationExecution]>(
      QueueName.EvaluationExecution,
      {
        connection: redis,
      }
    )
  : null;

export const evalJobCreator = redis
  ? new Worker<TQueueJobTypes[QueueName.TraceUpsert]>(
      QueueName.TraceUpsert,
      async (job: Job<TQueueJobTypes[QueueName.TraceUpsert]>) => {
        return instrument(
          {
            name: "evalJobCreator",
            rootSpan: true,
            spanKind: SpanKind.CONSUMER,
          },
          async () => {
            try {
              const startTime = Date.now();

              const waitTime = Date.now() - job.timestamp;

              recordIncrement("trace_upsert_queue_request");
              recordHistogram("trace_upsert_queue_wait_time", waitTime, {
                unit: "milliseconds",
              });

              await createEvalJobs({ event: job.data.payload });

              await getTraceUpsertQueue()
                ?.count()
                .then((count) => {
                  logger.info(`Eval creation queue length: ${count}`);
                  recordGauge("trace_upsert_queue_length", count, {
                    unit: "records",
                  });
                  return count;
                })
                .catch();
              recordHistogram(
                "trace_upsert_queue_processing_time",
                Date.now() - startTime,
                { unit: "milliseconds" }
              );
              return true;
            } catch (e) {
              logger.error(
                e,
                `Failed job Evaluation for traceId ${job.data.payload.traceId} ${e}`
              );
              traceException(e);
              throw e;
            }
          }
        );
      },
      {
        connection: redis,
        concurrency: env.LANGFUSE_EVAL_CREATOR_WORKER_CONCURRENCY,
      }
    )
  : null;

export const evalJobExecutor = redis
  ? new Worker<TQueueJobTypes[QueueName.EvaluationExecution]>(
      QueueName.EvaluationExecution,
      async (job: Job<TQueueJobTypes[QueueName.EvaluationExecution]>) => {
        return instrument(
          {
            name: "evalJobExecutor",
            spanKind: SpanKind.CONSUMER,
          },
          async () => {
            try {
              logger.info("Executing Evaluation Execution Job", job.data);
              const startTime = Date.now();

              const waitTime = Date.now() - job.timestamp;

              recordIncrement("eval_execution_queue_request");
              recordHistogram("eval_execution_queue_wait_time", waitTime, {
                unit: "milliseconds",
              });

              await evaluate({ event: job.data.payload });

              await evalQueue
                ?.count()
                .then((count) => {
                  logger.info(`Eval execution queue length: ${count}`);
                  recordGauge("eval_execution_queue_length", count, {
                    unit: "records",
                  });
                  return count;
                })
                .catch();
              recordHistogram(
                "eval_execution_queue_processing_time",
                Date.now() - startTime,
                { unit: "milliseconds" }
              );

              return true;
            } catch (e) {
              const displayError =
                e instanceof BaseError
                  ? e.message
                  : "An internal error occurred";

              await kyselyPrisma.$kysely
                .updateTable("job_executions")
                .set("status", sql`'ERROR'::"JobExecutionStatus"`)
                .set("end_time", new Date())
                .set("error", displayError)
                .where("id", "=", job.data.payload.jobExecutionId)
                .where("project_id", "=", job.data.payload.projectId)
                .execute();

              // do not log expected errors (api failures + missing api keys not provided by the user)
              if (
                !(e instanceof ApiError) &&
                !(
                  e instanceof BaseError &&
                  e.message.includes("API key for provider")
                )
              ) {
                traceException(e);
                logger.error(
                  e,
                  `Failed Evaluation_Execution job for id ${job.data.payload.jobExecutionId} ${e}`
                );
              }

              throw e;
            }
          }
        );
      },
      {
        connection: redis,
        concurrency: env.LANGFUSE_EVAL_EXECUTION_WORKER_CONCURRENCY,
      }
    )
  : null;

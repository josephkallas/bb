import { afterEach, describe, expect, it, vi } from "vitest";
import { eq } from "drizzle-orm";
import {
  createHostId,
  environments,
  getEnvironment,
  getHost,
  getQueuedThreadMessage,
  hosts,
  listSweepItemFailures,
} from "@bb/db";
import { createMigratedConnection } from "@bb/db/testing";
import type { PluginHookName } from "@get-bb/plugin-sdk";
import { validatePluginEnvironmentProviderDeclaration } from "@get-bb/plugin-sdk/internal/host-policy";
import { z } from "zod";
import { sweepProviderLifecycles } from "../../src/services/environments/environment-engine.js";
import { sweepMachineLifecycles } from "../../src/services/machines/provider-orchestration.js";
import { setPluginEnvironmentProviderBridge } from "../../src/services/plugins/plugin-environment-provider-registry.js";
import {
  setPluginHookProvider,
  type PluginHookRegistration,
} from "../../src/services/plugins/plugin-hook-registry.js";
import { setPluginMachineProviderBridge } from "../../src/services/plugins/plugin-machine-provider-registry.js";
import { defineItemSweep } from "../../src/services/system/item-sweep.js";
import { runQueuedMessageDispatch } from "../../src/services/threads/queued-message-dispatch.js";
import { toThreadQueuedMessage } from "../../src/services/threads/thread-queued-messages.js";
import { readJson } from "../helpers/json.js";
import { installMachineProvider } from "../helpers/machine-provider.js";
import { textInput } from "../helpers/prompt-input.js";
import {
  seedEnvironment,
  seedHostSession,
  seedProjectWithSource,
  seedQueuedMessage,
  seedThread,
} from "../helpers/seed.js";
import { withTestHarness, type TestAppHarness } from "../helpers/test-app.js";

const SCHEDULE_COLUMN = /(^|_)(retry|retire|next_attempt)_at$/u;
const MAX_ROUNDS = 40;
const LONG_AFTER_MS = 30 * 24 * 60 * 60_000;

interface RetryScenario {
  schedule(): number | null;
  attempts(): number;
  operationCalls(): number;
  runOwner(now: number): Promise<void>;
  needsRecoveryShown(): Promise<boolean>;
}

interface PersistedRetrySchedule {
  attemptColumn: string;
  arrange(harness: TestAppHarness): Promise<RetryScenario>;
}

const PERSISTED_RETRY_SCHEDULES: Record<string, PersistedRetrySchedule> = {
  "environments.retire_at": {
    attemptColumn: "teardown_attempt",
    arrange: arrangeEnvironmentTeardown,
  },
  "hosts.remove_retry_at": {
    attemptColumn: "teardown_attempt",
    arrange: arrangeMachineTeardown,
  },
  "sweep_item_failures.retry_at": {
    attemptColumn: "attempts",
    arrange: arrangeSweepItem,
  },
  "queued_thread_messages.next_attempt_at": {
    attemptColumn: "failure_count",
    arrange: arrangeQueuedMessage,
  },
};

afterEach(() => {
  vi.useRealTimers();
  setPluginMachineProviderBridge(undefined);
  setPluginEnvironmentProviderBridge(undefined);
  setPluginHookProvider(undefined);
});

function migratedColumns(): Array<{ table: string; column: string }> {
  const db = createMigratedConnection();
  try {
    const tables = db.$client
      .prepare<[], { name: string }>(
        "SELECT name FROM sqlite_master WHERE type = 'table' AND name NOT LIKE 'sqlite_%' AND name NOT LIKE '__drizzle%'",
      )
      .all();
    return tables.flatMap(({ name }) =>
      db.$client
        .prepare<[], { name: string }>(`PRAGMA table_info("${name}")`)
        .all()
        .map((column) => ({ table: name, column: column.name })),
    );
  } finally {
    db.$client.close();
  }
}

async function arrangeEnvironmentTeardown(
  harness: TestAppHarness,
): Promise<RetryScenario> {
  const { host } = seedHostSession(harness.deps, { id: "retry-env-host" });
  const { project } = seedProjectWithSource(harness.deps, {
    hostId: host.id,
  });
  let calls = 0;
  const record = {
    pluginId: "retry-guard",
    provider: validatePluginEnvironmentProviderDeclaration({
      id: "retry-guard-environment",
      displayName: "Retry guard",
      description: "Prepare a workspace for this thread.",
      icon: "Folder",
      create: async () => ({
        status: "created",
        path: "/tmp/retry-guard",
        ownsPath: false,
      }),
      remove: async () => {
        calls += 1;
        return { status: "failed", message: "provider remove refused" };
      },
    }),
  };
  setPluginEnvironmentProviderBridge({
    listEnvironmentProviders: () => [record],
    getEnvironmentProvider: (id) =>
      id === record.provider.id ? record : undefined,
    invokeProvider: async (_id, _label, run) => ({
      ok: true,
      value: await run(),
    }),
    decisionTimeoutMs: 10_000,
  });
  const environment = seedEnvironment(harness.deps, {
    hostId: host.id,
    projectId: project.id,
    environmentProviderId: record.provider.id,
    environmentProviderPluginId: record.pluginId,
  });
  const row = () => {
    const current = getEnvironment(harness.db, environment.id);
    if (current === null) throw new Error("environment vanished");
    return current;
  };
  harness.db
    .update(environments)
    .set({ retireAt: Date.now() })
    .where(eq(environments.id, environment.id))
    .run();
  return {
    schedule: () => row().retireAt,
    attempts: () => row().teardownAttempt,
    operationCalls: () => calls,
    runOwner: () => sweepProviderLifecycles(harness.deps),
    needsRecoveryShown: async () => {
      const response = await harness.app.request(
        `/api/v1/environments/${environment.id}`,
      );
      const body = z
        .object({
          lifecycle: z.object({
            teardown: z.object({ message: z.string().optional() }).nullable(),
          }),
        })
        .parse(await readJson(response));
      return (
        body.lifecycle.teardown?.message?.startsWith("Needs recovery:") ?? false
      );
    },
  };
}

async function arrangeMachineTeardown(
  harness: TestAppHarness,
): Promise<RetryScenario> {
  let calls = 0;
  installMachineProvider({
    remove: async () => {
      calls += 1;
      return { status: "failed", message: "provider remove refused" };
    },
  });
  const id = createHostId();
  harness.db
    .insert(hosts)
    .values({
      id,
      name: "Retry guard machine",
      type: "ephemeral",
      machineProviderId: "test-machine",
      phase: "active",
      resource: { allocation: "retry-guard" },
      createdAt: 1,
      updatedAt: 1,
    })
    .run();
  const row = () => {
    const current = getHost(harness.db, id);
    if (current === null) throw new Error("machine vanished");
    return current;
  };
  return {
    schedule: () => row().removeRetryAt,
    attempts: () => row().teardownAttempt,
    operationCalls: () => calls,
    runOwner: () => sweepMachineLifecycles(harness.deps),
    needsRecoveryShown: async () => {
      const response = await harness.app.request(`/api/v1/hosts/${id}`);
      const body = z
        .object({
          lifecycle: z.object({
            message: z.string().nullable(),
            teardown: z.object({ status: z.string() }).nullable(),
          }),
        })
        .parse(await readJson(response));
      return (
        body.lifecycle.teardown?.status === "failed" &&
        (body.lifecycle.message?.startsWith("Needs recovery:") ?? false)
      );
    },
  };
}

async function arrangeSweepItem(
  harness: TestAppHarness,
): Promise<RetryScenario> {
  let calls = 0;
  const sweep = defineItemSweep({
    name: "retry-guard-sweep",
    concurrency: 1,
    list: () => ["poison"],
    key: (item) => item,
    process: () => {
      calls += 1;
      throw new Error("item keeps failing");
    },
  });
  const failure = () => listSweepItemFailures(harness.db, sweep.name)[0];
  await sweep.run(harness.deps, Date.now());
  return {
    schedule: () => failure()?.retryAt ?? null,
    attempts: () => failure()?.attempts ?? 0,
    operationCalls: () => calls,
    runOwner: (now) => sweep.run(harness.deps, now),
    needsRecoveryShown: async () => {
      const response = await harness.app.request(
        "/api/v1/system/sweep-failures",
      );
      if (!response.ok) return false;
      const body = z
        .object({
          failures: z.array(
            z.object({
              sweep: z.string(),
              itemKey: z.string(),
              needsRecovery: z.boolean(),
            }),
          ),
        })
        .parse(await readJson(response));
      return body.failures.some(
        (entry) =>
          entry.sweep === sweep.name &&
          entry.itemKey === "poison" &&
          entry.needsRecovery,
      );
    },
  };
}

async function arrangeQueuedMessage(
  harness: TestAppHarness,
): Promise<RetryScenario> {
  const { host } = seedHostSession(harness.deps, { name: "Retry guard" });
  const { project } = seedProjectWithSource(harness.deps, {
    hostId: host.id,
    path: "/tmp/retry-guard-queue",
  });
  const environment = seedEnvironment(harness.deps, {
    hostId: host.id,
    projectId: project.id,
    path: "/tmp/retry-guard-queue",
  });
  const thread = seedThread(harness.deps, {
    projectId: project.id,
    environmentId: environment.id,
  });
  const queued = seedQueuedMessage(harness.deps, {
    threadId: thread.id,
    content: textInput("Send me"),
    waitingOn: { kind: "thread-busy" },
  });
  let calls = 0;
  const registry: {
    [K in PluginHookName]: PluginHookRegistration<K>[];
  } = {
    "message.dispatch": [
      {
        pluginId: "retry-guard",
        handler: () => {
          calls += 1;
          return { action: "reject", message: "Rejected" } as const;
        },
      },
    ],
  };
  setPluginHookProvider({
    listHooks: (hook) => registry[hook],
    invokeHook: async (_pluginId, _label, run) => ({
      ok: true,
      value: await run(),
    }),
    decisionTimeoutMs: 10_000,
  });
  const row = () => {
    const current = getQueuedThreadMessage(harness.db, queued.id);
    if (current === null) throw new Error("queued message vanished");
    return current;
  };
  await runQueuedMessageDispatch(harness.deps, {
    kind: "thread-ready",
    threadId: thread.id,
  });
  return {
    schedule: () => row().nextAttemptAt,
    attempts: () => row().failureCount,
    operationCalls: () => calls,
    runOwner: (now) =>
      runQueuedMessageDispatch(harness.deps, { kind: "failed-retry", now }),
    needsRecoveryShown: async () =>
      toThreadQueuedMessage(row()).state === "failed_exhausted",
  };
}

describe("persisted retry schedules", () => {
  it("registers every persisted retry schedule column with its attempt column", () => {
    const columns = migratedColumns();
    const schedules = columns
      .filter(({ column }) => SCHEDULE_COLUMN.test(column))
      .map(({ table, column }) => `${table}.${column}`)
      .sort();
    expect(schedules).toEqual(Object.keys(PERSISTED_RETRY_SCHEDULES).sort());
    for (const [schedule, { attemptColumn }] of Object.entries(
      PERSISTED_RETRY_SCHEDULES,
    )) {
      const table = schedule.split(".")[0];
      expect(columns).toContainEqual({ table, column: attemptColumn });
    }
  });

  it.each(Object.entries(PERSISTED_RETRY_SCHEDULES))(
    "%s stops retrying and shows needs recovery after its attempt cap",
    async (_schedule, { arrange }) =>
      withTestHarness(async (harness) => {
        vi.useFakeTimers({ toFake: ["Date"] });
        vi.setSystemTime(1_000_000);
        const scenario = await arrange(harness);
        await scenario.runOwner(Date.now());
        for (
          let round = 0;
          round < MAX_ROUNDS && scenario.schedule() !== null;
          round += 1
        ) {
          const due = scenario.schedule();
          if (due === null) break;
          vi.setSystemTime(Math.max(due, Date.now()));
          await scenario.runOwner(Date.now());
        }
        expect(scenario.schedule()).toBeNull();
        expect(scenario.attempts()).toBeGreaterThan(0);
        expect(scenario.operationCalls()).toBe(scenario.attempts());
        expect(await scenario.needsRecoveryShown()).toBe(true);
        const spent = scenario.operationCalls();
        vi.setSystemTime(Date.now() + LONG_AFTER_MS);
        await scenario.runOwner(Date.now());
        expect(scenario.operationCalls()).toBe(spent);
        expect(scenario.schedule()).toBeNull();
      }),
  );
});

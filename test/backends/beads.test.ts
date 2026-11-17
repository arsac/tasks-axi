import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { parseBacklog } from "../../src/backends/markdown-grammar.js";
import { parseConfigToml, resolveConfig } from "../../src/config.js";
import { resolveTasksContext } from "../../src/context.js";
import { AxiError } from "../../src/errors.js";
import {
  BD_AVAILABLE,
  makeBeadsBacklog,
  type TempBeadsBacklog,
} from "../beads-helpers.js";
import { BeadsStore } from "../../src/backends/beads.js";
import { MarkdownStore } from "../../src/backends/markdown.js";
import { mvCommand } from "../../src/commands/state.js";
import { isLocked, withLock } from "../../src/backends/lock.js";
import { execFileSync } from "node:child_process";
import {
  chmodSync,
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  readdirSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

const IT_TIMEOUT = 60_000;
const HOOK_TIMEOUT = 180_000;

// ---------------------------------------------------------------------------
// bd-free tests: config + context wiring
// ---------------------------------------------------------------------------

describe("beads config", () => {
  it("parses the [beads] table", () => {
    const config = parseConfigToml(
      ['backend = "beads"', "[beads]", 'dir = "data"', 'bin = "/opt/bd"'].join(
        "\n",
      ),
    );
    expect(config.backend).toBe("beads");
    expect(config.beads).toEqual({ dir: "data", bin: "/opt/bd" });
  });

  it("resolves beads.dir relative to the project", () => {
    const dir = mkdtempSync(join(tmpdir(), "tasks-axi-beads-config-"));
    try {
      writeFileSync(
        join(dir, ".tasks.toml"),
        ['backend = "beads"', "[beads]", 'dir = "data"'].join("\n"),
        "utf8",
      );
      const config = resolveConfig({ cwd: dir, home: dir, env: {} });
      expect(config.backend).toBe("beads");
      expect(config.beads?.dir).toBe(join(dir, "data"));
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it("resolves a BeadsStore context for backend=beads", () => {
    const dir = mkdtempSync(join(tmpdir(), "tasks-axi-beads-ctx-"));
    try {
      const ctx = resolveTasksContext({
        backend: "beads",
        cwd: dir,
        home: dir,
        env: {},
      });
      expect(ctx.store).toBeInstanceOf(BeadsStore);
      expect(ctx.store.capabilities().backend).toBe("beads");
      expect(ctx.store.capabilities().publicFollowups).toBe(false);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it("threads [beads] prefix into the store, rejecting foreign ids before bd runs", async () => {
    const dir = mkdtempSync(join(tmpdir(), "tasks-axi-beads-prefix-"));
    try {
      writeFileSync(
        join(dir, ".tasks.toml"),
        [
          'backend = "beads"',
          "[beads]",
          'prefix = "task"',
          'bin = "no-such-bd"',
        ].join("\n"),
        "utf8",
      );
      const ctx = resolveTasksContext({ cwd: dir, home: dir, env: {} });
      await expect(
        ctx.store.create({ id: "fix-login-k3", title: "wrong prefix" }),
      ).rejects.toMatchObject({
        code: "VALIDATION_ERROR",
        message: expect.stringContaining('configured beads prefix "task-"'),
      });
      // A matching id gets past the check and reaches the (missing) binary.
      await expect(
        ctx.store.create({ id: "task-fix-login", title: "right prefix" }),
      ).rejects.toMatchObject({
        message: expect.stringContaining("no-such-bd"),
      });
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it("names both backends on an unknown backend", () => {
    expect(() =>
      resolveTasksContext({ backend: "sqlite", cwd: tmpdir(), env: {} }),
    ).toThrowError(/available backends: markdown, beads/);
  });
});

// ---------------------------------------------------------------------------
// Real-bd Store conformance
// ---------------------------------------------------------------------------

describe.skipIf(!BD_AVAILABLE)("BeadsStore CRUD", () => {
  let bl: TempBeadsBacklog;
  beforeAll(() => {
    bl = makeBeadsBacklog();
  }, HOOK_TIMEOUT);
  afterAll(() => bl.cleanup());

  it(
    "round-trips an issue link through the title",
    async () => {
      const url = "https://forgejo.samesies.gay/o/r/issues/12";
      await bl.store.create({
        id: "issue-i1",
        title: "fix the redirect",
        links: [{ kind: "issue", url }],
      });
      const fresh = new BeadsStore({ dir: bl.dir, now: () => "2026-07-01" });
      const task = await fresh.get("issue-i1");
      expect(task?.title).toBe(`fix the redirect ${url}`);
      expect(task?.links).toEqual([{ kind: "issue", url }]);
    },
    IT_TIMEOUT,
  );

  it(
    "create round-trips every field and writes the mirror",
    async () => {
      const created = await bl.store.create({
        id: "alpha-a1",
        title: "ship the widget",
        kind: "ship",
        repo: "widgets",
        priority: 2,
        body: "first paragraph\n\nsecond paragraph",
      });
      expect(created.state).toBe("queued");
      expect(created.created).toBe("2026-07-01");

      const task = await bl.store.get("alpha-a1");
      expect(task).not.toBeNull();
      expect(task?.title).toBe("ship the widget");
      expect(task?.kind).toBe("ship");
      expect(task?.repo).toBe("widgets");
      expect(task?.priority).toBe(2);
      expect(task?.body).toBe("first paragraph\n\nsecond paragraph");
      expect(task?.created).toBe("2026-07-01");

      const mirror = bl.mirror();
      expect(mirror).toContain("## Queued");
      expect(mirror).toContain(
        "- [ ] alpha-a1 - ship the widget (repo: widgets) (kind: ship) (priority: 2) (since 2026-07-01)",
      );
      expect(mirror).toContain("  first paragraph");
    },
    IT_TIMEOUT,
  );

  it(
    "rejects a duplicate id with CONFLICT",
    async () => {
      await expect(
        bl.store.create({ id: "alpha-a1", title: "again" }),
      ).rejects.toMatchObject({ code: "CONFLICT" });
    },
    IT_TIMEOUT,
  );

  it(
    "creates in_flight work under the In flight section",
    async () => {
      await bl.store.create({
        id: "alpha-a2",
        title: "started work",
        state: "in_flight",
      });
      const task = await bl.store.get("alpha-a2");
      expect(task?.state).toBe("in_flight");
      const mirror = bl.mirror();
      const inFlight = mirror.indexOf("## In flight");
      const queued = mirror.indexOf("## Queued");
      const line = mirror.indexOf("- [ ] alpha-a2 - started work");
      expect(line).toBeGreaterThan(inFlight);
      expect(line).toBeLessThan(queued);
    },
    IT_TIMEOUT,
  );

  it(
    "validates create-time deps",
    async () => {
      await expect(
        bl.store.create({
          id: "alpha-a3",
          title: "with dangling dep",
          deps: [{ type: "blocked-by", id: "missing-m1" }],
        }),
      ).rejects.toMatchObject({ code: "VALIDATION_ERROR" });
      await expect(
        bl.store.create({
          id: "alpha-a4",
          title: "self block",
          deps: [{ type: "blocked-by", id: "alpha-a4" }],
        }),
      ).rejects.toMatchObject({ code: "VALIDATION_ERROR" });

      const created = await bl.store.create({
        id: "alpha-a5",
        title: "blocked work",
        deps: [{ type: "blocked-by", id: "alpha-a1", reason: "waits on a1" }],
      });
      expect(created.deps).toEqual([
        { type: "blocked-by", id: "alpha-a1", reason: "waits on a1" },
      ]);
      const task = await bl.store.get("alpha-a5");
      expect(task?.deps).toEqual([
        { type: "blocked-by", id: "alpha-a1", reason: "waits on a1" },
      ]);
      expect(bl.mirror()).toContain(
        "- [ ] alpha-a5 - blocked work (since 2026-07-01) blocked-by: alpha-a1 - waits on a1",
      );
    },
    IT_TIMEOUT,
  );

  it(
    "lists with filters and in_flight-first order",
    async () => {
      const { items, total } = await bl.store.list({});
      expect(total).toBeGreaterThanOrEqual(3);
      expect(items[0].id).toBe("alpha-a2");
      const ships = await bl.store.list({ kind: "ship" });
      expect(ships.items.map((t) => t.id)).toEqual(["alpha-a1"]);
      const limited = await bl.store.list({ limit: 1 });
      expect(limited.items).toHaveLength(1);
      expect(limited.total).toBe(total);
    },
    IT_TIMEOUT,
  );

  it(
    "refuses public-followups as unsupported",
    async () => {
      await expect(
        bl.store.create({
          id: "pf-x1",
          title: "promise",
          kind: "public-followup",
        }),
      ).rejects.toMatchObject({ code: "UNSUPPORTED" });
      await expect(bl.store.updatePublicFollowup()).rejects.toMatchObject({
        code: "UNSUPPORTED",
      });
    },
    IT_TIMEOUT,
  );

  it(
    "removes an unblocking task and protects a blocking one",
    async () => {
      await expect(bl.store.remove("alpha-a1")).rejects.toMatchObject({
        code: "VALIDATION_ERROR",
      });
      const removed = await bl.store.remove("alpha-a5");
      expect(removed.id).toBe("alpha-a5");
      expect(await bl.store.get("alpha-a5")).toBeNull();
      const gone = await bl.store.remove("alpha-a1");
      expect(gone.id).toBe("alpha-a1");
      expect(bl.mirror()).not.toContain("alpha-a1");
    },
    IT_TIMEOUT,
  );
});

describe.skipIf(!BD_AVAILABLE)("BeadsStore update", () => {
  let bl: TempBeadsBacklog;
  beforeAll(async () => {
    bl = makeBeadsBacklog();
    await bl.store.create({
      id: "upd-u1",
      title: "original title",
      body: "original body",
    });
  }, HOOK_TIMEOUT);
  afterAll(() => bl.cleanup());

  it(
    "updates scalar fields and reports changed",
    async () => {
      const result = await bl.store.update("upd-u1", {
        title: "new title",
        repo: "widgets",
        kind: "scout",
        priority: 1,
      });
      expect(result.changed.sort()).toEqual([
        "kind",
        "priority",
        "repo",
        "title",
      ]);
      const task = await bl.store.get("upd-u1");
      expect(task?.title).toBe("new title");
      expect(task?.repo).toBe("widgets");
      expect(task?.kind).toBe("scout");
      expect(task?.priority).toBe(1);
    },
    IT_TIMEOUT,
  );

  it(
    "treats an identical patch as a no-op",
    async () => {
      const result = await bl.store.update("upd-u1", {
        title: "new title",
        repo: "widgets",
      });
      expect(result.changed).toEqual([]);
    },
    IT_TIMEOUT,
  );

  it(
    "adds body lines without duplicating them",
    async () => {
      const first = await bl.store.update("upd-u1", {
        addBodyLines: ["extra line"],
      });
      expect(first.changed).toEqual(["body"]);
      const second = await bl.store.update("upd-u1", {
        addBodyLines: ["extra line"],
      });
      expect(second.changed).toEqual([]);
      const task = await bl.store.get("upd-u1");
      expect(task?.body).toBe("original body\nextra line");
    },
    IT_TIMEOUT,
  );

  it(
    "archives a superseded body on --archive-body, in the file and as a bd comment",
    async () => {
      const result = await bl.store.update("upd-u1", {
        body: "curated replacement",
        archiveBody: true,
      });
      expect(result.changed).toContain("archive");
      const task = await bl.store.get("upd-u1");
      expect(task?.body).toBe("curated replacement");
      const archive = bl.noteArchive();
      expect(archive).toContain("## Archived 2026-07-01");
      expect(archive).toContain("original body");
      const shown = execFileSync("bd", ["show", "upd-u1", "--json"], {
        cwd: bl.dir,
        env: { ...process.env, BEADS_DIR: join(bl.dir, ".beads") },
        timeout: 60_000,
      }).toString("utf8");
      const [issue] = JSON.parse(shown) as { comment_count?: number }[];
      expect(issue.comment_count ?? 0).toBeGreaterThanOrEqual(1);
    },
    IT_TIMEOUT,
  );

  it.skipIf(process.platform === "win32")(
    "keeps the superseded body when its bd comment cannot be posted",
    async () => {
      await bl.store.create({
        id: "upd-arch",
        title: "archive ordering",
        body: "body to preserve",
      });
      const wrapper = join(bl.dir, "bd-no-comment.cjs");
      writeFileSync(
        wrapper,
        [
          "#!/usr/bin/env node",
          'const { spawnSync } = require("node:child_process");',
          'if (process.argv[2] === "comment") {',
          '  process.stderr.write("comment disabled\\n");',
          "  process.exit(1);",
          "}",
          'const r = spawnSync("bd", process.argv.slice(2), { stdio: "inherit" });',
          "process.exit(r.status ?? 1);",
          "",
        ].join("\n"),
        "utf8",
      );
      chmodSync(wrapper, 0o755);
      const flaky = new BeadsStore({
        dir: bl.dir,
        mirrorPath: bl.mirrorPath,
        bin: wrapper,
        now: () => "2026-07-01",
      });
      const before = bl.noteArchive();
      await expect(
        flaky.update("upd-arch", {
          body: "curated replacement",
          archiveBody: true,
        }),
      ).rejects.toBeInstanceOf(AxiError);
      const fresh = new BeadsStore({
        dir: bl.dir,
        mirrorPath: bl.mirrorPath,
        now: () => "2026-07-01",
      });
      const task = await fresh.get("upd-arch");
      expect(task?.body).toBe("body to preserve");
      expect(bl.noteArchive()).toBe(before);
    },
    IT_TIMEOUT,
  );

  it.skipIf(process.platform === "win32")(
    "surfaces a bd update that exits 0 without persisting as a structured error",
    async () => {
      await bl.store.create({
        id: "upd-ver",
        title: "read-back subject",
        body: "unchanged body",
      });
      // A bd whose `update` succeeds without writing anything: the read-back
      // must name the diverged fields instead of reporting a silent success.
      const wrapper = join(bl.dir, "bd-noop-update.cjs");
      writeFileSync(
        wrapper,
        [
          "#!/usr/bin/env node",
          'const { spawnSync } = require("node:child_process");',
          'if (process.argv[2] === "update") process.exit(0);',
          'const r = spawnSync("bd", process.argv.slice(2), { stdio: "inherit" });',
          "process.exit(r.status ?? 1);",
          "",
        ].join("\n"),
        "utf8",
      );
      chmodSync(wrapper, 0o755);
      const silent = new BeadsStore({
        dir: bl.dir,
        mirrorPath: bl.mirrorPath,
        bin: wrapper,
        now: () => "2026-07-01",
      });
      await expect(
        silent.update("upd-ver", { title: "renamed", body: "new body" }),
      ).rejects.toMatchObject({
        code: "UNKNOWN",
        message: expect.stringMatching(
          /bd update did not persist title, body for "upd-ver"/,
        ),
      });
      await expect(
        silent.transition("upd-ver", "in_flight"),
      ).rejects.toMatchObject({
        code: "UNKNOWN",
        message: expect.stringContaining("bd transition did not persist"),
      });
      const task = await bl.store.get("upd-ver");
      expect(task?.title).toBe("read-back subject");
      expect(task?.body).toBe("unchanged body");
      expect(task?.state).toBe("queued");
    },
    IT_TIMEOUT,
  );

  it(
    "sets, renders, and clears structured holds",
    async () => {
      await bl.store.update("upd-u1", {
        hold: {
          reason: "captain decision pending",
          kind: "captain",
          until: "2026-08-01",
        },
      });
      let task = await bl.store.get("upd-u1");
      expect(task?.hold).toEqual({
        reason: "captain decision pending",
        kind: "captain",
        until: "2026-08-01",
      });
      expect(bl.mirror()).toContain(
        "(hold: captain decision pending) (hold-kind: captain) (hold-until: 2026-08-01)",
      );
      const cleared = await bl.store.update("upd-u1", { hold: null });
      expect(cleared.changed).toEqual(["hold"]);
      task = await bl.store.get("upd-u1");
      expect(task?.hold).toBeUndefined();
      expect(bl.mirror()).not.toContain("(hold:");
    },
    IT_TIMEOUT,
  );

  it(
    "folds added links into the title",
    async () => {
      const result = await bl.store.update("upd-u1", {
        addLinks: [{ kind: "doc", url: "https://example.com/spec" }],
      });
      expect(result.changed).toEqual(["links"]);
      const task = await bl.store.get("upd-u1");
      expect(task?.title).toBe("new title https://example.com/spec");
      expect(task?.links).toEqual([
        { kind: "doc", url: "https://example.com/spec" },
      ]);
    },
    IT_TIMEOUT,
  );

  it(
    "round-trips meta through bd metadata",
    async () => {
      const result = await bl.store.update("upd-u1", {
        meta: { home: "main", harness: "claude" },
      });
      expect(result.changed).toEqual(["meta"]);
      const task = await bl.store.get("upd-u1");
      expect(task?.meta).toEqual({ home: "main", harness: "claude" });
    },
    IT_TIMEOUT,
  );

  it(
    "keeps an in-flight task in flight when a hold sets or clears --until",
    async () => {
      await bl.store.create({
        id: "upd-u2",
        title: "held in flight",
        state: "in_flight",
      });
      await bl.store.update("upd-u2", {
        hold: { reason: "captain gate", until: "2026-09-01" },
      });
      let task = await bl.store.get("upd-u2");
      expect(task?.state).toBe("in_flight");
      expect(task?.hold).toEqual({
        reason: "captain gate",
        until: "2026-09-01",
      });
      const mirror = bl.mirror();
      const inFlight = mirror.indexOf("## In flight");
      const queued = mirror.indexOf("## Queued");
      const line = mirror.indexOf("- [ ] upd-u2 - held in flight");
      expect(line).toBeGreaterThan(inFlight);
      expect(line).toBeLessThan(queued);

      await bl.store.update("upd-u2", { hold: null });
      task = await bl.store.get("upd-u2");
      expect(task?.state).toBe("in_flight");
      expect(task?.hold).toBeUndefined();
    },
    IT_TIMEOUT,
  );
});

describe.skipIf(!BD_AVAILABLE)("BeadsStore transitions and deps", () => {
  let bl: TempBeadsBacklog;
  beforeAll(async () => {
    bl = makeBeadsBacklog();
    await bl.store.create({ id: "flow-f1", title: "the work", created: null });
    await bl.store.create({ id: "flow-f2", title: "the blocker" });
  }, HOOK_TIMEOUT);
  afterAll(() => bl.cleanup());

  it(
    "start backfills the created date",
    async () => {
      const task = await bl.store.transition("flow-f1", "in_flight");
      expect(task.state).toBe("in_flight");
      expect(task.created).toBe("2026-07-01");
      expect((await bl.store.get("flow-f1"))?.state).toBe("in_flight");
    },
    IT_TIMEOUT,
  );

  it(
    "done records the pr link and closed date",
    async () => {
      const task = await bl.store.transition("flow-f1", "done", {
        pr: "https://github.com/owner/repo/pull/42",
        note: "landed cleanly",
      });
      expect(task.state).toBe("done");
      expect(task.closed).toBe("2026-07-01");
      expect(task.links).toEqual([
        { kind: "pr", url: "https://github.com/owner/repo/pull/42" },
      ]);
      expect(task.body).toBe("landed cleanly");
      expect(bl.mirror()).toContain(
        "- [x] flow-f1 - the work https://github.com/owner/repo/pull/42 (merged 2026-07-01)",
      );
    },
    IT_TIMEOUT,
  );

  it(
    "reopen clears the closed date",
    async () => {
      const task = await bl.store.transition("flow-f1", "queued");
      expect(task.state).toBe("queued");
      expect(task.closed).toBeUndefined();
      expect((await bl.store.get("flow-f1"))?.closed).toBeUndefined();
    },
    IT_TIMEOUT,
  );

  it(
    "addDep and removeDep are idempotent with reasons preserved",
    async () => {
      const added = await bl.store.addDep("flow-f1", {
        type: "blocked-by",
        id: "flow-f2",
        reason: "waits on the blocker",
      });
      expect(added).toBe(true);
      const again = await bl.store.addDep("flow-f1", {
        type: "blocked-by",
        id: "flow-f2",
      });
      expect(again).toBe(false);
      let task = await bl.store.get("flow-f1");
      expect(task?.deps).toEqual([
        { type: "blocked-by", id: "flow-f2", reason: "waits on the blocker" },
      ]);
      await expect(
        bl.store.addDep("flow-f1", { type: "blocked-by", id: "missing-m9" }),
      ).rejects.toMatchObject({ code: "VALIDATION_ERROR" });

      const removed = await bl.store.removeDep("flow-f1", {
        type: "blocked-by",
        id: "flow-f2",
      });
      expect(removed).toBe(true);
      const removedAgain = await bl.store.removeDep("flow-f1", {
        type: "blocked-by",
        id: "flow-f2",
      });
      expect(removedAgain).toBe(false);
      task = await bl.store.get("flow-f1");
      expect(task?.deps).toEqual([]);
    },
    IT_TIMEOUT,
  );

  it(
    "refuses a second relationship type to the same task pair",
    async () => {
      await bl.store.create({ id: "flow-f3", title: "shared target" });
      await bl.store.addDep("flow-f1", { type: "parent", id: "flow-f3" });
      await expect(
        bl.store.addDep("flow-f1", { type: "blocked-by", id: "flow-f3" }),
      ).rejects.toMatchObject({
        code: "VALIDATION_ERROR",
        message: expect.stringContaining("parent edge"),
      });
      let task = await bl.store.get("flow-f1");
      expect(task?.deps).toEqual([{ type: "parent", id: "flow-f3" }]);
      const removed = await bl.store.removeDep("flow-f1", {
        type: "parent",
        id: "flow-f3",
      });
      expect(removed).toBe(true);
      task = await bl.store.get("flow-f1");
      expect(task?.deps).toEqual([]);
    },
    IT_TIMEOUT,
  );
});

describe.skipIf(!BD_AVAILABLE)("BeadsStore mutation read-back", () => {
  let bl: TempBeadsBacklog;
  let depWrapper: string;
  let archiveWrapper: string;
  let deleteWrapper: string;
  let commentWrapper: string;

  beforeAll(() => {
    bl = makeBeadsBacklog();
    depWrapper = join(bl.dir, "noop-dep.cjs");
    archiveWrapper = join(bl.dir, "noop-archive.cjs");
    deleteWrapper = join(bl.dir, "noop-delete.cjs");
    commentWrapper = join(bl.dir, "noop-comment.cjs");
    writeFileSync(
      depWrapper,
      [
        "#!/usr/bin/env node",
        'const { spawnSync } = require("node:child_process");',
        "const args = process.argv.slice(2);",
        'if (args[0] === "dep") process.exit(0);',
        'const result = spawnSync("bd", args, { stdio: "inherit" });',
        "process.exit(result.status ?? 1);",
        "",
      ].join("\n"),
      "utf8",
    );
    writeFileSync(
      archiveWrapper,
      [
        "#!/usr/bin/env node",
        'const { spawnSync } = require("node:child_process");',
        "const args = process.argv.slice(2);",
        'if (args[0] === "update" && args.includes("--metadata") && args.some((arg) => arg.includes("\\"archived\\":true"))) process.exit(0);',
        'const result = spawnSync("bd", args, { stdio: "inherit" });',
        "process.exit(result.status ?? 1);",
        "",
      ].join("\n"),
      "utf8",
    );
    writeFileSync(
      deleteWrapper,
      [
        "#!/usr/bin/env node",
        'const { spawnSync } = require("node:child_process");',
        "const args = process.argv.slice(2);",
        'if (args[0] === "delete") process.exit(0);',
        'const result = spawnSync("bd", args, { stdio: "inherit" });',
        "process.exit(result.status ?? 1);",
        "",
      ].join("\n"),
      "utf8",
    );
    writeFileSync(
      commentWrapper,
      [
        "#!/usr/bin/env node",
        'const { spawnSync } = require("node:child_process");',
        "const args = process.argv.slice(2);",
        'if (args[0] === "comment") process.exit(0);',
        'const result = spawnSync("bd", args, { stdio: "inherit" });',
        "process.exit(result.status ?? 1);",
        "",
      ].join("\n"),
      "utf8",
    );
    chmodSync(depWrapper, 0o755);
    chmodSync(archiveWrapper, 0o755);
    chmodSync(deleteWrapper, 0o755);
    chmodSync(commentWrapper, 0o755);
  }, HOOK_TIMEOUT);
  afterAll(() => bl.cleanup());

  it(
    "rejects a dependency mutation the configured bd wrapper did not persist",
    async () => {
      await bl.store.create({ id: "rb-a1", title: "dependent" });
      await bl.store.create({ id: "rb-a2", title: "blocker" });
      const noopDeps = new BeadsStore({
        dir: bl.dir,
        bin: depWrapper,
        now: () => "2026-07-01",
      });

      await expect(
        noopDeps.create({
          id: "rb-a3",
          title: "created with a dependency",
          deps: [{ type: "blocked-by", id: "rb-a2" }],
        }),
      ).rejects.toMatchObject({
        message: expect.stringContaining("dependencies"),
      });
      await expect(
        noopDeps.addDep("rb-a1", { type: "blocked-by", id: "rb-a2" }),
      ).rejects.toMatchObject({
        message: expect.stringContaining("dependencies"),
      });

      await bl.store.addDep("rb-a1", { type: "blocked-by", id: "rb-a2" });
      await expect(
        noopDeps.removeDep("rb-a1", { type: "blocked-by", id: "rb-a2" }),
      ).rejects.toMatchObject({
        message: expect.stringContaining("dependencies"),
      });
      expect((await bl.store.get("rb-a1"))?.deps).toEqual([
        { type: "blocked-by", id: "rb-a2" },
      ]);
    },
    IT_TIMEOUT,
  );

  it(
    "rejects a delete the configured bd wrapper did not persist",
    async () => {
      await bl.store.create({ id: "rb-d1", title: "still here" });
      const noopDelete = new BeadsStore({
        dir: bl.dir,
        bin: deleteWrapper,
        now: () => "2026-07-01",
      });

      await expect(noopDelete.remove("rb-d1")).rejects.toMatchObject({
        message: expect.stringContaining("did not remove task"),
      });
      expect(await bl.store.get("rb-d1")).not.toBeNull();
    },
    IT_TIMEOUT,
  );

  it(
    "preserves archive-body content before replacing it without a mirror",
    async () => {
      await bl.store.create({
        id: "rb-c1",
        title: "body preservation",
        body: "original body",
      });
      const noopComment = new BeadsStore({
        dir: bl.dir,
        bin: commentWrapper,
        now: () => "2026-07-01",
      });

      await expect(
        noopComment.update("rb-c1", {
          body: "replacement body",
          archiveBody: true,
        }),
      ).rejects.toMatchObject({
        message: expect.stringContaining(
          "did not preserve the superseded body",
        ),
      });
      expect((await bl.store.get("rb-c1"))?.body).toBe("original body");
      expect(readdirSync(bl.dir)).not.toContain("note-archive.md");
    },
    IT_TIMEOUT,
  );

  it(
    "verifies the archive comment even when a note archive is configured",
    async () => {
      await bl.store.create({
        id: "rb-c2",
        title: "body preservation with a note archive",
        body: "original body",
      });
      const noteArchivePath = join(bl.dir, "rb-note-archive.md");
      const noopComment = new BeadsStore({
        dir: bl.dir,
        bin: commentWrapper,
        noteArchivePath,
        now: () => "2026-07-01",
      });

      await expect(
        noopComment.update("rb-c2", {
          body: "replacement body",
          archiveBody: true,
        }),
      ).rejects.toMatchObject({
        message: expect.stringContaining(
          "did not preserve the superseded body",
        ),
      });
      const fresh = new BeadsStore({ dir: bl.dir, now: () => "2026-07-01" });
      expect((await fresh.get("rb-c2"))?.body).toBe("original body");
      expect(readdirSync(bl.dir)).not.toContain("rb-note-archive.md");
    },
    IT_TIMEOUT,
  );

  it(
    "rejects an unsaved archive comment even when an older comment contains the body",
    async () => {
      await bl.store.create({
        id: "rb-c5",
        title: "body preserved by the exact comment",
        body: "not done yet",
      });
      await bl.store.update("rb-c5", { body: "done", archiveBody: true });
      const noopComment = new BeadsStore({
        dir: bl.dir,
        bin: commentWrapper,
        now: () => "2026-07-02",
      });

      await expect(
        noopComment.update("rb-c5", { body: "final", archiveBody: true }),
      ).rejects.toMatchObject({
        message: expect.stringContaining(
          "did not preserve the superseded body",
        ),
      });
      const fresh = new BeadsStore({ dir: bl.dir, now: () => "2026-07-01" });
      expect((await fresh.get("rb-c5"))?.body).toBe("done");
    },
    IT_TIMEOUT,
  );

  it(
    "archives a multi-line body without a mirror",
    async () => {
      const body = 'first line\nsecond "quoted" line';
      await bl.store.create({ id: "rb-c3", title: "multi-line", body });
      const mirrorless = new BeadsStore({
        dir: bl.dir,
        now: () => "2026-07-01",
      });
      await mirrorless.update("rb-c3", {
        body: "replacement body",
        archiveBody: true,
      });
      expect((await mirrorless.get("rb-c3"))?.body).toBe("replacement body");
    },
    IT_TIMEOUT,
  );

  it(
    "does not archive a task when bd did not persist its archive marker",
    async () => {
      await bl.store.create({ id: "rb-p1", title: "finished", created: null });
      await bl.store.transition("rb-p1", "done", { date: "2026-06-01" });
      const noopArchive = new BeadsStore({
        dir: bl.dir,
        bin: archiveWrapper,
        archivePath: join(bl.dir, "read-back-archive.md"),
        now: () => "2026-07-01",
      });

      await expect(
        noopArchive.prune({ state: "done", keep: 0, archive: true }),
      ).rejects.toMatchObject({
        message: expect.stringContaining("did not archive rb-p1"),
      });
      expect(await bl.store.get("rb-p1")).not.toBeNull();
      expect(readdirSync(bl.dir)).not.toContain("read-back-archive.md");
    },
    IT_TIMEOUT,
  );
});

describe.skipIf(!BD_AVAILABLE)("BeadsStore maintenance and mirror", () => {
  let bl: TempBeadsBacklog;
  beforeAll(async () => {
    bl = makeBeadsBacklog();
    for (const [id, closed] of [
      ["old-o1", "2026-06-01"],
      ["old-o2", "2026-06-02"],
      ["old-o3", "2026-06-03"],
    ] as const) {
      await bl.store.create({ id, title: `finished ${id}`, created: null });
      await bl.store.transition(id, "done", { date: closed });
    }
    await bl.store.create({ id: "live-l1", title: "still queued" });
  }, HOOK_TIMEOUT);
  afterAll(() => bl.cleanup());

  it(
    "prune keeps the newest done tasks and archives the surplus",
    async () => {
      const result = await bl.store.prune({
        state: "done",
        keep: 1,
        archive: true,
      });
      expect(result.archived).toBe(2);
      expect(result.ids.sort()).toEqual(["old-o1", "old-o2"]);
      const { items } = await bl.store.list({ state: "done" });
      expect(items.map((t) => t.id)).toEqual(["old-o3"]);
      expect(await bl.store.get("old-o1")).toBeNull();
      const archive = bl.archive();
      expect(archive).toContain("## Archived 2026-07-01");
      expect(archive).toContain(
        "- [x] old-o1 - finished old-o1 (done 2026-06-01)",
      );
      expect(archive).toContain(
        "- [x] old-o2 - finished old-o2 (done 2026-06-02)",
      );
      expect(bl.mirror()).not.toContain("old-o1");
    },
    IT_TIMEOUT,
  );

  it(
    "render rewrites the mirror and reports the task count",
    async () => {
      const count = await bl.store.render();
      expect(count).toBe(2);
    },
    IT_TIMEOUT,
  );

  it(
    "the mirror parses back into the same tasks",
    async () => {
      const doc = parseBacklog(bl.mirror());
      const parsed = doc.sections.flatMap((section) =>
        section.entries.flatMap((entry) =>
          entry.kind === "task" ? [entry.task] : [],
        ),
      );
      const { items } = await bl.store.list({});
      expect(parsed.map((t) => [t.id, t.state, t.title])).toEqual(
        items.map((t) => [t.id, t.state, t.title]),
      );
    },
    IT_TIMEOUT,
  );

  it(
    "refuses to overwrite a mirror path holding a file it did not generate",
    async () => {
      const backlog = join(bl.dir, "existing-backlog.md");
      const original = "# Backlog\n\n## Queued\n\n- [ ] keep-k1 - not in bd\n";
      writeFileSync(backlog, original, "utf8");
      const store = new BeadsStore({
        dir: bl.dir,
        mirrorPath: backlog,
        now: () => "2026-07-01",
      });
      for (const write of [
        () => store.create({ id: "guard-g1", title: "would clobber" }),
        () => store.render(),
      ]) {
        await expect(write()).rejects.toMatchObject({
          code: "VALIDATION_ERROR",
          message: expect.stringContaining(backlog),
        });
      }
      expect(readFileSync(backlog, "utf8")).toBe(original);
      expect(await bl.store.get("guard-g1")).toBeNull();

      writeFileSync(backlog, "", "utf8");
      expect(await store.render()).toBeGreaterThan(0);
      expect(parseBacklog(readFileSync(backlog, "utf8")).sections).toHaveLength(
        3,
      );
      await expect(store.render()).resolves.toBeGreaterThan(0);
    },
    IT_TIMEOUT,
  );

  it.skipIf(process.platform === "win32")(
    "does not report a bd failure as LOCKED because the task id contains lock",
    async () => {
      await bl.store.create({ id: "ci-lock-a1", title: "raced away" });
      // A raw `bd delete` racing the transition: bd's error echoes the id.
      const wrapper = join(bl.dir, "bd-race-delete.cjs");
      writeFileSync(
        wrapper,
        [
          "#!/usr/bin/env node",
          'const { spawnSync } = require("node:child_process");',
          "const args = process.argv.slice(2);",
          'if (args[0] === "update") spawnSync("bd", ["delete", args[1], "-f"], { stdio: "ignore" });',
          'const r = spawnSync("bd", args, { stdio: "inherit" });',
          "process.exit(r.status ?? 1);",
          "",
        ].join("\n"),
        "utf8",
      );
      chmodSync(wrapper, 0o755);
      const racing = new BeadsStore({
        dir: bl.dir,
        bin: wrapper,
        now: () => "2026-07-01",
      });
      await expect(
        racing.transition("ci-lock-a1", "in_flight"),
      ).rejects.toMatchObject({ code: "UNKNOWN" });
    },
    IT_TIMEOUT,
  );

  // bd 1.3.4's failure while a maintenance operation holds the gate: plain
  // text on stderr, or (under --json) an `{"error": ...}` object on stdout.
  const gateBusy =
    "a maintenance operation is running on this workspace; retry when it completes: " +
    "workspacegate: /ws/.beads/embeddeddolt.gate.lock (shared mode) held by another bd process " +
    "(no holder info recorded): workspace gate busy";
  it.skipIf(process.platform === "win32").each([
    ["stderr", "gate-g1", "process.stderr", `Error: ${gateBusy}\n`],
    [
      "--json stdout",
      "gate-g2",
      "process.stdout",
      `${JSON.stringify({ error: gateBusy, schema_version: 1 }, null, 2)}\n`,
    ],
  ])(
    "reports bd's workspace-gate contention on %s as LOCKED",
    async (_form, id, stream, output) => {
      await bl.store.create({ id, title: "maintenance running" });
      const wrapper = join(bl.dir, "bd-gate-busy.cjs");
      writeFileSync(
        wrapper,
        [
          "#!/usr/bin/env node",
          'const { spawnSync } = require("node:child_process");',
          "const args = process.argv.slice(2);",
          `if (args[0] === "update") { ${stream}.write(${JSON.stringify(output)}); process.exit(1); }`,
          'const r = spawnSync("bd", args, { stdio: "inherit" });',
          "process.exit(r.status ?? 1);",
          "",
        ].join("\n"),
        "utf8",
      );
      chmodSync(wrapper, 0o755);
      const gated = new BeadsStore({
        dir: bl.dir,
        bin: wrapper,
        now: () => "2026-07-01",
      });
      const error = await gated
        .transition(id, "in_flight")
        .catch((e: unknown) => e);
      expect(error).toMatchObject({ code: "LOCKED" });
      expect((error as Error).message).toContain("workspace gate busy");
    },
    IT_TIMEOUT,
  );

  it(
    "reports a missing database as an actionable error",
    async () => {
      const dir = mkdtempSync(join(tmpdir(), "tasks-axi-nodb-"));
      try {
        const store = new BeadsStore({
          dir,
          mirrorPath: join(dir, "backlog.md"),
        });
        await expect(store.list({})).rejects.toSatisfy((error: unknown) => {
          const axi = error as AxiError;
          return (
            axi.code === "VALIDATION_ERROR" &&
            /no beads database found/.test(axi.message)
          );
        });
      } finally {
        rmSync(dir, { recursive: true, force: true });
      }
    },
    IT_TIMEOUT,
  );

  it(
    "gives a bd init hint that works for a subdirectory of a git repo",
    async () => {
      const repo = mkdtempSync(join(tmpdir(), "tasks-axi-nodb-git-"));
      try {
        execFileSync("git", ["init", "-q"], { cwd: repo });
        const dir = join(repo, "data");
        mkdirSync(dir);
        const store = new BeadsStore({ dir, prefix: "hint" });
        const error = await store.list({}).then(
          () => undefined,
          (e: unknown) => e as AxiError,
        );
        const command = error?.suggestions?.join("\n").match(/`([^`]+)`/)?.[1];
        expect(command).toBeDefined();
        // Run the hint as a user would from inside `dir`.
        const tokens = command!.split(" ");
        const env: Record<string, string> = {};
        while (/^[A-Z_]+=/.test(tokens[0]!)) {
          const [key, ...value] = tokens.shift()!.split("=");
          env[key!] = value.join("=");
        }
        const [bin, ...args] = tokens;
        execFileSync(bin!, [...args, "--non-interactive"], {
          cwd: dir,
          env: { ...process.env, ...env },
          stdio: "ignore",
          timeout: 120_000,
        });
        expect(existsSync(join(dir, ".beads"))).toBe(true);
        expect(existsSync(join(repo, ".beads"))).toBe(false);
        await store.create({ id: "hint-a1", title: "after init" });
        expect((await store.get("hint-a1"))?.title).toBe("after init");
      } finally {
        rmSync(repo, { recursive: true, force: true });
      }
    },
    HOOK_TIMEOUT,
  );
});

// ---------------------------------------------------------------------------
// Optional mirror and a config-only binary/workspace swap
// ---------------------------------------------------------------------------

describe.skipIf(!BD_AVAILABLE)("BeadsStore without a mirror", () => {
  let bl: TempBeadsBacklog;
  beforeAll(() => {
    bl = makeBeadsBacklog();
  }, HOOK_TIMEOUT);
  afterAll(() => bl.cleanup());

  it(
    "writes no mirror, archive or lock file when none is configured",
    async () => {
      const store = new BeadsStore({ dir: bl.dir, now: () => "2026-07-01" });
      await store.create({ id: "nm-a1", title: "first", body: "kept body" });
      await store.create({ id: "nm-a2", title: "second", created: null });
      await store.transition("nm-a2", "done", { date: "2026-06-01" });
      await store.transition("nm-a1", "in_flight");
      await store.update("nm-a1", { body: "curated", archiveBody: true });
      const pruned = await store.prune({
        state: "done",
        keep: 0,
        archive: true,
      });
      expect(pruned.ids).toEqual(["nm-a2"]);
      expect(await store.render()).toBe(1);

      const files = readdirSync(bl.dir);
      for (const name of ["backlog.md", "done-archive.md", "note-archive.md"]) {
        expect(files).not.toContain(name);
      }
      // bd >= 1.3 owns `.beads.gate.lock` at the workspace root.
      expect(
        files.filter(
          (name) => name.endsWith(".lock") && name !== ".beads.gate.lock",
        ),
      ).toEqual([]);
      expect((await store.get("nm-a1"))?.body).toBe("curated");
      // The superseded body survives as a bd comment even with no file archive.
      const comments = execFileSync("bd", ["comments", "nm-a1", "--json"], {
        cwd: bl.dir,
        env: { ...process.env, BEADS_DIR: join(bl.dir, ".beads") },
        encoding: "utf8",
      });
      expect(comments).toContain("kept body");
    },
    IT_TIMEOUT,
  );

  it(
    "still writes the archive file when archivePath is configured",
    async () => {
      const archivePath = join(bl.dir, "elsewhere", "done.md");
      const store = new BeadsStore({
        dir: bl.dir,
        archivePath,
        now: () => "2026-07-01",
      });
      await store.create({ id: "nm-b1", title: "old", created: null });
      await store.transition("nm-b1", "done", { date: "2026-06-01" });
      await store.prune({ state: "done", keep: 0, archive: true });
      expect(readFileSync(archivePath, "utf8")).toContain("nm-b1");
      expect(readdirSync(bl.dir)).not.toContain("done-archive.md");
    },
    IT_TIMEOUT,
  );

  it.skipIf(process.platform === "win32")(
    "runs a wrapper binary with no dir, leaving workspace selection to it",
    async () => {
      // A wrapper pins the workspace itself, as a store launcher script would;
      // tasks-axi is configured with nothing but the executable.
      const wrapper = join(bl.dir, "pinned-bd.cjs");
      writeFileSync(
        wrapper,
        [
          "#!/usr/bin/env node",
          'const { spawnSync } = require("node:child_process");',
          "const r = spawnSync(",
          '  "bd",',
          "  process.argv.slice(2),",
          "  {",
          '    stdio: "inherit",',
          `    cwd: ${JSON.stringify(bl.dir)},`,
          `    env: { ...process.env, BEADS_DIR: ${JSON.stringify(join(bl.dir, ".beads"))} },`,
          "  },",
          ");",
          "process.exit(r.status ?? 1);",
          "",
        ].join("\n"),
        "utf8",
      );
      chmodSync(wrapper, 0o755);
      const elsewhere = mkdtempSync(join(tmpdir(), "tasks-axi-nowork-"));
      const previous = process.cwd();
      try {
        process.chdir(elsewhere);
        const store = new BeadsStore({ bin: wrapper, now: () => "2026-07-01" });
        await store.create({ id: "nm-w1", title: "via wrapper" });
        await store.transition("nm-w1", "in_flight");
        expect((await store.get("nm-w1"))?.state).toBe("in_flight");
        expect(readdirSync(elsewhere)).toEqual([]);
      } finally {
        process.chdir(previous);
        rmSync(elsewhere, { recursive: true, force: true });
      }
      expect((await bl.store.get("nm-w1"))?.title).toBe("via wrapper");
    },
    IT_TIMEOUT,
  );
});

/** Resolves once a store holds the workspace mutation lock under `dir`. */
async function waitForWorkspaceLock(dir: string): Promise<void> {
  const lock = join(dir, ".beads", "tasks-axi");
  for (let i = 0; i < 2_000 && !isLocked(lock); i++) {
    await new Promise((resolve) => setTimeout(resolve, 5));
  }
  expect(isLocked(lock)).toBe(true);
}

describe.skipIf(!BD_AVAILABLE)("BeadsStore lock wait", () => {
  let bl: TempBeadsBacklog;
  beforeAll(() => {
    bl = makeBeadsBacklog();
  }, HOOK_TIMEOUT);
  afterAll(() => bl.cleanup());

  it(
    "queues parallel writers on the default wait instead of failing",
    async () => {
      const a = new BeadsStore({ dir: bl.dir, now: () => "2026-07-01" });
      const b = new BeadsStore({ dir: bl.dir, now: () => "2026-07-01" });
      await Promise.all([
        a.create({ id: "lk-a1", title: "from a" }),
        b.create({ id: "lk-b1", title: "from b" }),
        a.create({ id: "lk-a2", title: "also a" }),
      ]);
      // A fresh store: `a`'s list cache predates whichever write landed last.
      const fresh = new BeadsStore({ dir: bl.dir, now: () => "2026-07-01" });
      const ids = (await fresh.list({})).items.map((t) => t.id);
      expect(ids).toEqual(expect.arrayContaining(["lk-a1", "lk-b1", "lk-a2"]));
    },
    IT_TIMEOUT * 3,
  );

  it(
    "fails with LOCKED once a configured wait runs out",
    async () => {
      const impatient = new BeadsStore({
        dir: bl.dir,
        lockTimeoutMs: 50,
        now: () => "2026-07-01",
      });
      await withLock(join(bl.dir, ".beads", "tasks-axi"), async () => {
        await expect(
          impatient.create({ id: "lk-c2", title: "gives up" }),
        ).rejects.toMatchObject({ code: "LOCKED" });
      });
      expect(await impatient.get("lk-c2")).toBeNull();
    },
    IT_TIMEOUT,
  );

  it.skipIf(process.platform === "win32")(
    "shares one lock between mirrored and mirrorless workspace views",
    async () => {
      const wrapper = join(bl.dir, "slow-create.cjs");
      writeFileSync(
        wrapper,
        [
          "#!/usr/bin/env node",
          'const { spawnSync } = require("node:child_process");',
          "const args = process.argv.slice(2);",
          'if (args[0] === "create" && args.includes("ws-a1")) Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, 200);',
          'const result = spawnSync("bd", args, { stdio: "inherit" });',
          "process.exit(result.status ?? 1);",
          "",
        ].join("\n"),
        "utf8",
      );
      chmodSync(wrapper, 0o755);
      const mirrorless = new BeadsStore({
        dir: bl.dir,
        bin: wrapper,
        lockTimeoutMs: 1_000,
        now: () => "2026-07-01",
      });
      const mirrored = new BeadsStore({
        dir: bl.dir,
        mirrorPath: bl.mirrorPath,
        bin: wrapper,
        lockTimeoutMs: 50,
        now: () => "2026-07-01",
      });

      const first = mirrorless.create({ id: "ws-a1", title: "slow" });
      await waitForWorkspaceLock(bl.dir);
      await expect(
        mirrored.create({ id: "ws-a2", title: "contender" }),
      ).rejects.toMatchObject({ code: "LOCKED" });
      await first;
      expect(await mirrorless.get("ws-a2")).toBeNull();
    },
    IT_TIMEOUT,
  );

  it.skipIf(process.platform === "win32")(
    "locks the workspace bd resolves, whatever the caller's cwd",
    async () => {
      // A wrapper that pins the workspace, so the store is configured with no
      // dir: callers from different directories must still share one lock.
      const wrapper = join(bl.dir, "pinned-lock-bd.cjs");
      writeFileSync(
        wrapper,
        [
          "#!/usr/bin/env node",
          'const { spawnSync } = require("node:child_process");',
          "const r = spawnSync(",
          '  "bd",',
          "  process.argv.slice(2),",
          "  {",
          '    stdio: "inherit",',
          `    cwd: ${JSON.stringify(bl.dir)},`,
          `    env: { ...process.env, BEADS_DIR: ${JSON.stringify(join(bl.dir, ".beads"))} },`,
          "  },",
          ");",
          "process.exit(r.status ?? 1);",
          "",
        ].join("\n"),
        "utf8",
      );
      chmodSync(wrapper, 0o755);
      const cwds = [
        mkdtempSync(join(tmpdir(), "tasks-axi-cwd-a-")),
        mkdtempSync(join(tmpdir(), "tasks-axi-cwd-b-")),
      ];
      const previous = process.cwd();
      try {
        await withLock(join(bl.dir, ".beads", "tasks-axi"), async () => {
          for (const cwd of cwds) {
            process.chdir(cwd);
            const store = new BeadsStore({
              bin: wrapper,
              lockTimeoutMs: 50,
              now: () => "2026-07-01",
            });
            await expect(
              store.create({ id: "ws-cwd", title: "contender" }),
            ).rejects.toMatchObject({ code: "LOCKED" });
          }
        });
      } finally {
        process.chdir(previous);
        for (const cwd of cwds) rmSync(cwd, { recursive: true, force: true });
      }
      expect(await bl.store.get("ws-cwd")).toBeNull();
    },
    IT_TIMEOUT,
  );
});

describe.skipIf(!BD_AVAILABLE)("BeadsStore id prefix", () => {
  let bl: TempBeadsBacklog;
  beforeAll(() => {
    bl = makeBeadsBacklog();
  }, HOOK_TIMEOUT);
  afterAll(() => bl.cleanup());

  it(
    "creates ids under the configured prefix without forcing them past bd",
    async () => {
      const store = new BeadsStore({
        dir: bl.dir,
        prefix: "tst",
        now: () => "2026-07-01",
      });
      await store.create({ id: "tst-wire-up-login", title: "slug id" });
      expect((await store.get("tst-wire-up-login"))?.title).toBe("slug id");
      await expect(
        store.create({ id: "other-1", title: "foreign" }),
      ).rejects.toMatchObject({ code: "VALIDATION_ERROR" });
      expect(await store.get("other-1")).toBeNull();
    },
    IT_TIMEOUT,
  );

  it(
    "surfaces bd's own prefix error when the configured prefix is wrong",
    async () => {
      const store = new BeadsStore({
        dir: bl.dir,
        prefix: "zzz",
        now: () => "2026-07-01",
      });
      await expect(
        store.create({ id: "zzz-1", title: "bd disagrees" }),
      ).rejects.toMatchObject({
        message: expect.stringMatching(/prefix mismatch/i),
      });
    },
    IT_TIMEOUT,
  );

  it(
    "keeps accepting any slug when no prefix is configured",
    async () => {
      await bl.store.create({ id: "anything-goes", title: "forced" });
      expect((await bl.store.get("anything-goes"))?.title).toBe("forced");
    },
    IT_TIMEOUT,
  );
});

describe.skipIf(!BD_AVAILABLE)("BeadsStore native beads", () => {
  let bl: TempBeadsBacklog;
  const bd = (...args: string[]): string =>
    execFileSync("bd", args, {
      cwd: bl.dir,
      env: { ...process.env, BEADS_DIR: join(bl.dir, ".beads") },
      encoding: "utf8",
    });
  // The local date of a bd UTC timestamp, computed independently of the store.
  const localDay = (stamp: string): string => {
    const d = new Date(stamp);
    return [
      d.getFullYear(),
      String(d.getMonth() + 1).padStart(2, "0"),
      String(d.getDate()).padStart(2, "0"),
    ].join("-");
  };
  const showJson = (
    id: string,
  ): { created_at: string; closed_at?: string; close_reason?: string } => {
    const parsed = JSON.parse(bd("show", id, "--json")) as unknown;
    return (Array.isArray(parsed) ? parsed[0] : parsed) as {
      created_at: string;
      closed_at?: string;
      close_reason?: string;
    };
  };

  beforeAll(() => {
    bl = makeBeadsBacklog();
    bd(
      "create",
      "--title",
      "native bug",
      "--id",
      "tst-nat1",
      "-t",
      "bug",
      "-p",
      "0",
      "--silent",
    );
    bd("create", "--title", "native plain", "--id", "tst-nat2", "--silent");
    bd(
      "create",
      "--title",
      "native closed",
      "--id",
      "tst-nat3",
      "-t",
      "feature",
      "-p",
      "3",
      "--silent",
    );
    bd("close", "tst-nat3", "--reason", "finished natively");
  }, HOOK_TIMEOUT);
  afterAll(() => bl.cleanup());

  it(
    "reads priority, issue type and dates from bd for an untouched issue",
    async () => {
      const bug = await bl.store.get("tst-nat1");
      expect(bug).toMatchObject({
        state: "queued",
        kind: "bug",
        priority: 0,
        created: localDay(showJson("tst-nat1").created_at),
      });
      expect(bug?.closed).toBeUndefined();

      const plain = await bl.store.get("tst-nat2");
      expect(plain?.kind).toBeUndefined();
      expect(plain?.priority).toBe(2);

      const closed = await bl.store.get("tst-nat3");
      expect(closed).toMatchObject({
        state: "done",
        kind: "feature",
        priority: 3,
        closed: localDay(showJson("tst-nat3").closed_at as string),
      });
    },
    IT_TIMEOUT,
  );

  it(
    "keeps the native values, with no fabricated date, after a tasks-axi write",
    async () => {
      const before = await bl.store.get("tst-nat1");
      const started = await bl.store.transition("tst-nat1", "in_flight", {
        date: "2030-01-01",
      });
      expect(started).toMatchObject({
        state: "in_flight",
        kind: "bug",
        priority: 0,
        created: before?.created,
      });
      const reread = await new BeadsStore({
        dir: bl.dir,
        now: () => "2030-01-01",
      }).get("tst-nat1");
      expect(reread).toMatchObject({ kind: "bug", priority: 0 });
      expect(reread?.created).toBe(before?.created);
    },
    IT_TIMEOUT,
  );

  it(
    "does not mistake bd's default priority for one on tasks-axi-written issues",
    async () => {
      const created = await bl.store.create({ id: "nat-own", title: "mine" });
      expect(created.priority).toBeUndefined();
      expect((await bl.store.get("nat-own"))?.priority).toBeUndefined();
      expect((await bl.store.get("nat-own"))?.kind).toBeUndefined();
    },
    IT_TIMEOUT,
  );

  it(
    "records a close reason: the pr url when given, else a default",
    async () => {
      await bl.store.create({ id: "nat-pr", title: "closed with a pr" });
      await bl.store.create({ id: "nat-bare", title: "closed bare" });
      await bl.store.create({
        id: "nat-blocked",
        title: "closed while blocked",
        deps: [{ type: "blocked-by", id: "nat-bare" }],
      });
      const pr = "https://github.com/acme/widgets/pull/7";
      await bl.store.transition("nat-pr", "done", { pr, date: "2026-07-01" });
      await bl.store.transition("nat-blocked", "done", { date: "2026-07-01" });
      await bl.store.transition("nat-bare", "done", { date: "2026-07-01" });
      expect(showJson("nat-pr").close_reason).toBe(pr);
      expect(showJson("nat-bare").close_reason).toBe("Closed");
      expect(showJson("nat-blocked").close_reason).toBe("Closed");
      expect((await bl.store.get("nat-pr"))?.state).toBe("done");
    },
    IT_TIMEOUT,
  );
});

describe.skipIf(!BD_AVAILABLE)("BeadsStore move to markdown", () => {
  let bl: TempBeadsBacklog;
  let targetDir: string;
  beforeAll(() => {
    bl = makeBeadsBacklog();
    targetDir = mkdtempSync(join(tmpdir(), "tasks-axi-mv-target-"));
  }, HOOK_TIMEOUT);
  afterAll(() => {
    bl.cleanup();
    rmSync(targetDir, { recursive: true, force: true });
  });

  const makeTarget = (name: string): MarkdownStore => {
    const path = join(targetDir, `${name}.md`);
    writeFileSync(path, "# Backlog\n\n## In flight\n\n## Queued\n\n## Done\n");
    return new MarkdownStore({ path, now: () => "2026-07-01" });
  };

  /** A bd wrapper that runs `onDelete` (a JS snippet) before any `delete`. */
  const deleteWrapper = (name: string, onDelete: string): string => {
    const wrapper = join(bl.dir, `${name}.cjs`);
    writeFileSync(
      wrapper,
      [
        "#!/usr/bin/env node",
        'const { spawnSync } = require("node:child_process");',
        'const fs = require("node:fs");',
        "const args = process.argv.slice(2);",
        `if (args[0] === "delete") { ${onDelete} }`,
        'const result = spawnSync("bd", args, { stdio: "inherit" });',
        "process.exit(result.status ?? 1);",
        "",
      ].join("\n"),
      "utf8",
    );
    chmodSync(wrapper, 0o755);
    return wrapper;
  };

  const fresh = () => new BeadsStore({ dir: bl.dir, now: () => "2026-07-01" });

  it(
    "moves a task into a markdown backlog",
    async () => {
      await bl.store.create({ id: "mv-a1", title: "travels", body: "kept" });
      const target = makeTarget("happy");
      await bl.store.moveTo("mv-a1", target);
      expect((await target.get("mv-a1"))?.body).toBe("kept");
      expect(await fresh().get("mv-a1")).toBeNull();
    },
    IT_TIMEOUT,
  );

  it(
    "moves through the mv command",
    async () => {
      await bl.store.create({ id: "mv-c1", title: "via the CLI" });
      const target = makeTarget("cli");
      const out = await mvCommand(
        ["mv-c1", "--to", join(targetDir, "cli.md"), "--json"],
        bl.ctx,
      );
      expect(JSON.parse(out)).toMatchObject({ ok: true, id: "mv-c1" });
      expect(await target.get("mv-c1")).not.toBeNull();
      expect(await fresh().get("mv-c1")).toBeNull();
    },
    IT_TIMEOUT,
  );

  it.skipIf(process.platform === "win32")(
    "holds the destination lock until the source delete is verified",
    async () => {
      await bl.store.create({ id: "mv-l1", title: "locked move" });
      const target = makeTarget("locked");
      const marker = join(targetDir, "lock-seen");
      const store = new BeadsStore({
        dir: bl.dir,
        bin: deleteWrapper(
          "bd-delete-lock-probe",
          `fs.writeFileSync(${JSON.stringify(marker)}, String(fs.existsSync(${JSON.stringify(join(targetDir, "locked.md.lock"))})));`,
        ),
        now: () => "2026-07-01",
      });
      await store.moveTo("mv-l1", target);
      expect(readFileSync(marker, "utf8")).toBe("true");
      expect(await target.get("mv-l1")).not.toBeNull();
    },
    IT_TIMEOUT,
  );

  it.skipIf(process.platform === "win32")(
    "rolls the destination copy back when the source delete fails",
    async () => {
      await bl.store.create({ id: "mv-r1", title: "stays put" });
      const target = makeTarget("rollback");
      const store = new BeadsStore({
        dir: bl.dir,
        bin: deleteWrapper(
          "bd-delete-fails",
          'process.stderr.write("Error: delete refused\\n"); process.exit(1);',
        ),
        now: () => "2026-07-01",
      });
      await expect(store.moveTo("mv-r1", target)).rejects.toMatchObject({
        message: expect.stringContaining("delete refused"),
      });
      expect(await target.get("mv-r1")).toBeNull();
      expect(await fresh().get("mv-r1")).not.toBeNull();
    },
    IT_TIMEOUT,
  );

  it.skipIf(process.platform === "win32")(
    "reports a duplicate when the destination rollback also fails",
    async () => {
      await bl.store.create({ id: "mv-d1", title: "lives in both" });
      makeTarget("unrollable");
      const targetPath = join(targetDir, "unrollable.md");
      const target = new MarkdownStore({
        path: targetPath,
        now: () => "2026-07-01",
      });
      const store = new BeadsStore({
        dir: bl.dir,
        bin: deleteWrapper(
          "bd-delete-breaks-target",
          `fs.rmSync(${JSON.stringify(targetPath)}); fs.mkdirSync(${JSON.stringify(targetPath)}); process.stderr.write("Error: delete refused\\n"); process.exit(1);`,
        ),
        now: () => "2026-07-01",
      });
      await expect(store.moveTo("mv-d1", target)).rejects.toMatchObject({
        code: "CONFLICT",
        message: expect.stringContaining("exists in both backlogs"),
        suggestions: expect.arrayContaining([
          expect.stringContaining("delete refused"),
        ]),
      });
      expect(await fresh().get("mv-d1")).not.toBeNull();
    },
    IT_TIMEOUT,
  );

  it(
    "does not treat an unconfigured markdown path as the beads source",
    async () => {
      await bl.store.create({ id: "mv-u1", title: "default path is free" });
      const targetPath = join(targetDir, "default-path.md");
      const target = makeTarget("default-path");
      const out = await mvCommand(["mv-u1", "--to", targetPath, "--json"], {
        store: fresh(),
        config: { backend: "beads", path: targetPath, doneKeep: 10 },
      });
      const parsed = JSON.parse(out) as Record<string, unknown>;
      expect(parsed).toMatchObject({ ok: true, id: "mv-u1", to: targetPath });
      expect(parsed).not.toHaveProperty("from");
      expect(await target.get("mv-u1")).not.toBeNull();
      expect(await fresh().get("mv-u1")).toBeNull();
    },
    IT_TIMEOUT,
  );

  it(
    "refuses a --to that resolves to the configured beads mirror",
    async () => {
      await bl.store.create({ id: "mv-m1", title: "mirror is the source" });
      await expect(
        mvCommand(["mv-m1", "--to", bl.mirrorPath], bl.ctx),
      ).rejects.toMatchObject({
        code: "VALIDATION_ERROR",
        message: "--to resolves to the current backlog",
      });
      expect(await fresh().get("mv-m1")).not.toBeNull();
    },
    IT_TIMEOUT,
  );

  it.skipIf(process.platform === "win32")(
    "keeps the destination copy when the source is gone but a later step fails",
    async () => {
      await bl.store.create({ id: "mv-k1", title: "must not vanish" });
      const target = makeTarget("kept");
      // The mirror path turns into a directory during the delete, so the
      // post-delete mirror write fails after bd has already deleted the source.
      const mirrorDir = join(targetDir, "mirror-is-a-dir");
      const store = new BeadsStore({
        dir: bl.dir,
        mirrorPath: mirrorDir,
        bin: deleteWrapper(
          "bd-delete-breaks-mirror",
          `fs.mkdirSync(${JSON.stringify(join(mirrorDir, "occupied"))}, { recursive: true });`,
        ),
        now: () => "2026-07-01",
      });
      await expect(store.moveTo("mv-k1", target)).rejects.toBeInstanceOf(Error);
      expect(await fresh().get("mv-k1")).toBeNull();
      expect(await target.get("mv-k1")).not.toBeNull();
    },
    IT_TIMEOUT,
  );

  it(
    "refuses a task that still blocks an active task",
    async () => {
      await bl.store.create({ id: "mv-b1", title: "blocker" });
      await bl.store.create({
        id: "mv-b2",
        title: "dependent",
        deps: [{ type: "blocked-by", id: "mv-b1" }],
      });
      const target = makeTarget("blocked");
      await expect(bl.store.moveTo("mv-b1", target)).rejects.toMatchObject({
        code: "VALIDATION_ERROR",
      });
      expect(await target.get("mv-b1")).toBeNull();
      expect(await fresh().get("mv-b1")).not.toBeNull();
    },
    IT_TIMEOUT,
  );
});

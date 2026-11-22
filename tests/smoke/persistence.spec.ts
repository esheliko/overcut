import { expect, test, type Page } from "@playwright/test";

/** The test hook `window.__overcut` exists only with `?e2e` (apps/web/src/persistence.tsx). */
type Hook = {
  session: { editing: { apply(o: unknown, k?: number): Promise<unknown>; undo(): Promise<{ can_undo: boolean }>; project(): Promise<unknown> }; whenDurable(): Promise<void>; stats: { appends: number; maxAppendMs: number } };
  kill(): void;
  storageKind: string;
};
declare global {
  interface Window {
    __overcut: Hook;
  }
}

const open = async (page: Page) => {
  await page.goto("/?e2e");
  await page.waitForFunction(() => !!window.__overcut, undefined, { timeout: 30_000 });
};

test("a killed saving process loses nothing that was acknowledged: reload restores it, undo reaches the session start, Undo recovery goes back", async ({ page }) => {
  const errors: string[] = [];
  page.on("pageerror", (e) => errors.push(e.message));
  await open(page);
  const kind = await page.evaluate(() => window.__overcut.storageKind);
  expect(["opfs", "idb"]).toContain(kind);
  await expect(page.getByTestId("recovery-note")).toHaveCount(0); // a brand-new project is not a recovery

  const result = await page.evaluate(async () => {
    const { session, kill } = window.__overcut;
    const hex = (n: number) => n.toString(16).padStart(32, "0");
    const project = (await session.editing.project()) as { sequences: { tracks: { id: string }[] }[] };
    const track = project.sequences[0]!.tracks[0]!.id;
    const media = "00000000000000000000000000000e2e";
    const base = JSON.stringify(project);
    await session.editing.apply({ op: "insert_clip", track, clip: { id: hex(0x100), media, start: 0, source_in: 0, duration: 705_600_000 } });
    await session.whenDurable();
    let acked = JSON.stringify(await session.editing.project());
    let ackedOps = 1;
    // an edit stream: a drag (one coalesced undo step) with durability acknowledged every few moves; the process dies after op 20's acknowledgement
    for (let i = 1; i <= 40; i++) {
      await session.editing.apply({ op: "move", clip: hex(0x100), track, start: i * 1_000_000 }, 7);
      if (i <= 20 && i % 5 === 0) {
        await session.whenDurable();
        acked = JSON.stringify(await session.editing.project());
        ackedOps = i + 1;
      }
      if (i === 20) kill();
    }
    return { base, acked, ackedOps, appends: session.stats.appends, maxAppendMs: session.stats.maxAppendMs };
  });
  console.log(`autosave: ${result.appends} appends, slowest ${result.maxAppendMs.toFixed(1)} ms (${kind})`);

  await page.reload(); // the old page's Worker is long dead; the new one finds a journal with edits in it
  await page.waitForFunction(() => !!window.__overcut, undefined, { timeout: 30_000 });
  await expect(page.getByTestId("recovery-note")).toContainText("Recovered unsaved changes");
  expect(await page.evaluate(async () => JSON.stringify(await window.__overcut.session.editing.project()))).toBe(result.acked);

  // undo walks back through the crashed session to its start
  const undone = await page.evaluate(async (base) => {
    const e = window.__overcut.session.editing;
    let steps = 0;
    while ((await e.undo()).can_undo) steps++;
    return { steps: steps + 1, project: JSON.stringify(await e.project()), same: JSON.stringify(await e.project()) === base };
  }, result.base);
  expect(undone.same).toBe(true);
  expect(undone.steps).toBe(2); // the insert, and the whole drag as one step

  // Undo recovery: back to the last clean save, discarded edits kept aside; the next open is quiet
  await page.getByRole("button", { name: "Undo recovery" }).click();
  await expect(page.getByTestId("recovery-note")).toHaveCount(0);
  await page.reload();
  await page.waitForFunction(() => !!window.__overcut, undefined, { timeout: 30_000 });
  await expect(page.getByTestId("recovery-note")).toHaveCount(0);
  expect(await page.evaluate(async () => JSON.stringify(await window.__overcut.session.editing.project()))).toBe(result.base);
  expect(errors).toEqual([]);
});

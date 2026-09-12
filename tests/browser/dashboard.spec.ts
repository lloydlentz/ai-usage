import { readFileSync } from "node:fs";
import { test, expect, type Page } from "@playwright/test";
import { normalizeRows, sumTokensByType } from "../../lib/burn-data";
import { formatTokens } from "../../lib/token-math";
import { dayNumber } from "../../lib/date-windows";

async function openDashboard(page: Page) {
  await page.goto("/");
  // A fresh CI browser can reach server-rendered markup before hydration and
  // ResizeObserver apply the real chart size. Pointer coordinates must use it.
  await expect(page.locator(".refreshToggle")).not.toHaveText("Checking refresh");
  await expect.poll(() => page.locator(".timelineSvg").evaluate((element) => {
    const svg = element as SVGSVGElement;
    return Math.abs(svg.viewBox.baseVal.width - Math.max(280, svg.getBoundingClientRect().width));
  })).toBeLessThan(.5);
}

test("presets position the range without shrinking the timeline in either theme", async ({ page }) => {
  const errors: string[] = [];
  page.on("pageerror", (error) => errors.push(error.message));
  await openDashboard(page);
  const filters = page.locator("#date-filters");
  const toggle = page.locator(".refreshToggle");
  await expect(filters).toBeHidden();
  await expect(toggle).toHaveAttribute("aria-expanded", "false");
  await toggle.click();
  await expect(filters).toBeVisible();
  await expect(toggle).toHaveAttribute("aria-expanded", "true");
  const period = page.getByRole("combobox", { name: "Period", exact: true });
  await expect(period.locator("option")).toHaveText(["1 day", "3 days", "7 days", "31 days", "3 months", "6 months", "All time"]);
  const overview = await page.locator("path.timelineAreaClaude").getAttribute("d");
  await period.selectOption("1");
  const timeline = page.locator(".timeline");
  expect(await timeline.getAttribute("data-start")).toBe(await timeline.getAttribute("data-end"));
  await expect(page.locator("path.timelineAreaClaude")).toHaveAttribute("d", overview!);
  const data = JSON.parse(readFileSync("data/daily-burn.json", "utf8"));
  const lastDay = data[data.length - 1];
  await expect(page.locator(".modelShareBar")).toBeVisible();
  const before = await page.locator(".modelShareHeading > span").innerText();
  expect(lastDay.codex_tokens + lastDay.claude_code_tokens).toBeGreaterThan(0);
  await period.selectOption("all");
  await expect(page.locator(".modelShareHeading > span")).not.toHaveText(before);
  const widths = await page.locator(".modelShareSegment").evaluateAll((elements) => elements.reduce((sum, el) => sum + parseFloat((el as HTMLElement).style.width), 0));
  // CSSOM rounds each percentage when serializing style.width. Allow the
  // accumulated rounding; full-precision share math is covered in unit tests.
  expect(widths).toBeCloseTo(100, 3);
  await expect(page.getByRole("heading", { name: "Explore recorded usage" })).toBeVisible();
  await page.getByLabel("From", { exact: true }).fill(lastDay.date);
  await expect(page.getByRole("slider", { name: "Range start", exact: true })).toHaveAttribute("aria-valuetext", lastDay.date);
  await expect(page.locator("path.timelineAreaClaude")).toHaveAttribute("d", overview!);
  await page.getByRole("button", { name: "Reset dates" }).click();
  await page.getByRole("button", { name: /ticker/i }).click();
  await expect(page.locator("main")).toHaveAttribute("data-theme", "ticker");
  await page.locator(".refreshToggle").click();
  await expect(filters).toBeHidden();
  await page.locator(".refreshToggle").focus();
  await page.locator(".refreshToggle").press("Enter");
  await expect(filters).toBeVisible();
  await expect(page.locator("body")).toBeVisible();
  expect(await page.evaluate(() => document.documentElement.scrollWidth <= window.innerWidth)).toBe(true);
  expect(errors).toEqual([]);
});

test("timeline supports keyboard inspection", async ({ page }) => {
  await openDashboard(page);
  const chart = page.getByRole("slider", { name: /^Daily usage/ });
  await chart.focus();
  await chart.press("Home");
  await expect(chart).toHaveAttribute("aria-valuenow", "0");
  await chart.press("ArrowRight");
  await expect(chart).toHaveAttribute("aria-valuenow", "1");
  await expect(page.locator(".timelineTooltip")).toBeVisible();
  await chart.press("End");
  expect(await chart.getAttribute("aria-valuenow")).toBe(await chart.getAttribute("aria-valuemax"));
});

test("explorer filters and sanitized labels persist and export", async ({ page }) => {
  await openDashboard(page);
  const explorer = page.locator(".usageExplorer");
  await explorer.getByRole("combobox", { name: "Tool", exact: true }).selectOption("codex");
  await explorer.getByRole("combobox", { name: "Model", exact: true }).selectOption("gpt-6-astra");
  const day = explorer.locator("details").first();
  await day.locator("summary").click();
  const category = day.getByRole("combobox");
  await category.selectOption("review");
  await expect(day.locator("summary")).toContainText("review");
  const download = page.waitForEvent("download");
  await explorer.getByRole("button", { name: "Export labels" }).click();
  expect((await download).suggestedFilename()).toBe("driver-labels.json");
  await page.reload();
  expect(await page.evaluate(() => Object.values(JSON.parse(localStorage.getItem("token-burn-driver-labels-v1") || "{}")))).toContain("review");
});

test("stale collection does not claim live or invent today's readings", async ({ page }) => {
  const meta = JSON.parse(readFileSync("data/meta.json", "utf8"));
  await page.clock.install({ time: new Date(Date.parse(meta.collected_at) + 24 * 60 * 60_000) });
  await openDashboard(page);
  await expect(page.getByRole("button", { name: "Refresh overdue", exact: true })).toBeVisible();
  await expect(page.locator(".toolSummaryNote")).toContainText(JSON.parse(readFileSync("data/daily-burn.json", "utf8")).at(-1).date);
  await expect(page.locator(".toolToday")).toHaveText(["no reading", "no reading"]);
  await expect(page.locator(".ledgerWarn").first()).toContainText("Today’s missing readings are unknown");
});

test("today column reads the viewer's Chicago day", async ({ page }) => {
  const lastDay = JSON.parse(readFileSync("data/daily-burn.json", "utf8")).at(-1);
  // 18:00 UTC is midday in Chicago under both CST and CDT.
  await page.clock.install({ time: new Date(`${lastDay.date}T18:00:00Z`) });
  await openDashboard(page);
  await expect(page.locator(".toolToday")).toHaveText([formatTokens(lastDay.claude_code_tokens), formatTokens(lastDay.codex_tokens)]);
  await expect(page.locator(".toolSummaryNote")).toContainText(`Today is ${lastDay.date}`);
});

async function assertSelectedTotals(page: Page) {
  const timeline = page.locator(".timeline");
  const start = (await timeline.getAttribute("data-start"))!;
  const end = (await timeline.getAttribute("data-end"))!;
  const rows = normalizeRows(JSON.parse(readFileSync("data/daily-burn.json", "utf8"))).filter((row) => row.date >= start && row.date <= end);
  const measured = rows.reduce((sum, row) => sum + row.codex_tokens + row.claude_code_tokens, 0);
  await expect(page.locator(".modelShareHeading > span")).toHaveText(`${formatTokens(measured)} measured tokens in this period`);
  await expect(page.locator(".shiftVolume .ledgerAmountInk")).toHaveText(formatTokens(sumTokensByType(rows).typed));
  return { start, end, days: dayNumber(end) - dayNumber(start) + 1 };
}

test("draw, move, and resize a range while the overview and lifetime totals stay fixed", async ({ page }) => {
  await openDashboard(page);
  const svg = page.locator(".timelineSvg");
  await svg.scrollIntoViewIfNeeded();
  const chart = (await svg.boundingBox())!;
  const path = await page.locator("path.timelineAreaClaude").getAttribute("d");
  const totals = await page.locator(".toolTotal").allTextContents();
  const left = Number(await svg.getAttribute("data-plot-left"));
  const width = Number(await svg.getAttribute("data-plot-width"));
  const x = (fraction: number) => chart.x + chart.width * (left + fraction * width);
  const y = chart.y + chart.height / 2;
  await page.mouse.move(x(.2), y);
  await page.mouse.down();
  await page.mouse.move(x(.4), y, { steps: 8 });
  // Dependent views update during the drag, before releasing the pointer.
  const drawn = await assertSelectedTotals(page);
  await page.mouse.up();
  expect(drawn.days).toBeGreaterThan(1);
  await page.locator(".timelineRangeRail").scrollIntoViewIfNeeded();
  const rail = (await page.locator(".timelineRangeRail").boundingBox())!;
  const move = (await page.locator(".timelineRangeMove").boundingBox())!;
  await page.mouse.move(move.x + move.width / 2, move.y + move.height / 2);
  await page.mouse.down();
  await page.mouse.move(move.x + move.width / 2 + rail.width * .1, move.y + move.height / 2, { steps: 8 });
  await page.mouse.up();
  const moved = await assertSelectedTotals(page);
  expect(moved.days).toBe(drawn.days);
  expect(moved.start > drawn.start).toBe(true);
  await page.getByRole("slider", { name: "Range end", exact: true }).scrollIntoViewIfNeeded();
  await page.getByRole("slider", { name: "Range end", exact: true }).click();
  expect(await assertSelectedTotals(page)).toEqual(moved);
  const edge = (await page.getByRole("slider", { name: "Range end", exact: true }).boundingBox())!;
  await page.mouse.move(edge.x + edge.width / 2, edge.y + edge.height / 2);
  await page.mouse.down();
  await page.mouse.move(edge.x + edge.width / 2 + rail.width * .08, edge.y + edge.height / 2, { steps: 6 });
  await page.mouse.up();
  const resized = await assertSelectedTotals(page);
  expect(resized.start).toBe(moved.start);
  expect(resized.days).toBeGreaterThan(moved.days);
  await expect(page.locator("path.timelineAreaClaude")).toHaveAttribute("d", path!);
  expect(await page.locator(".toolTotal").allTextContents()).toEqual(totals);
  expect(await page.evaluate(() => document.documentElement.scrollWidth <= window.innerWidth)).toBe(true);
});

test("keyboard moves and resizes inclusive single-day selections at the history boundaries", async ({ page }) => {
  await openDashboard(page);
  await page.locator(".refreshToggle").click();
  await page.getByRole("combobox", { name: "Period", exact: true }).selectOption("1");
  const initial = await assertSelectedTotals(page);
  const mover = page.getByRole("slider", { name: "Move selected date range", exact: true });
  await mover.focus();
  await mover.press("ArrowRight");
  expect(await assertSelectedTotals(page)).toEqual(initial);
  await mover.press("Shift+ArrowLeft");
  const moved = await assertSelectedTotals(page);
  expect(moved.days).toBe(1);
  expect(dayNumber(initial.start) - dayNumber(moved.start)).toBe(7);
  const start = page.getByRole("slider", { name: "Range start", exact: true });
  await start.press("Shift+ArrowLeft");
  expect((await assertSelectedTotals(page)).days).toBe(8);
  await mover.press("Home");
  const earliest = await assertSelectedTotals(page);
  await mover.press("ArrowLeft");
  expect(await assertSelectedTotals(page)).toEqual(earliest);
  await page.getByRole("button", { name: "Select all time", exact: true }).click();
  await expect(page.getByRole("button", { name: "Select all time", exact: true })).toBeDisabled();
});

test("touch can select and slide a date range", async ({ page, isMobile }) => {
  test.skip(!isMobile, "Native touch is checked in the mobile project");
  await openDashboard(page);
  await page.locator(".timelineSvg").scrollIntoViewIfNeeded();
  const chart = (await page.locator(".timelineSvg").boundingBox())!;
  const session = await page.context().newCDPSession(page);
  const touch = async (type: "touchStart" | "touchMove" | "touchEnd", x: number, y: number) => session.send("Input.dispatchTouchEvent", { type, touchPoints: type === "touchEnd" ? [] : [{ x, y, id: 1 }] });
  const y = chart.y + chart.height / 2;
  await touch("touchStart", chart.x + chart.width * .2, y);
  await touch("touchMove", chart.x + chart.width * .4, y);
  await touch("touchEnd", 0, 0);
  const firstDate = JSON.parse(readFileSync("data/daily-burn.json", "utf8"))[0].date;
  await expect(page.locator(".timeline")).not.toHaveAttribute("data-start", firstDate);
  const before = await assertSelectedTotals(page);
  await page.locator(".timelineRangeMove").scrollIntoViewIfNeeded();
  const bar = (await page.locator(".timelineRangeMove").boundingBox())!;
  await touch("touchStart", bar.x + bar.width / 2, bar.y + bar.height / 2);
  await touch("touchMove", bar.x + bar.width / 2 + 35, bar.y + bar.height / 2);
  await touch("touchEnd", 0, 0);
  await expect(page.locator(".timeline")).not.toHaveAttribute("data-start", before.start);
  const after = await assertSelectedTotals(page);
  expect(after.days).toBe(before.days);
  expect(after.start > before.start).toBe(true);
  await session.detach();
});
